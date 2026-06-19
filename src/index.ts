import { Events } from "discord.js";
import { env, commandPrefix } from "./config/env";
import { logger, childLogger } from "./config/logger";
import { toErrorMessage } from "./utils/errors";
import type { HealthPayload, StatsPayload } from "./types/common";

import { buildLLMRouterFromEnv } from "./ai/llm/LLMRouter";
import { AgentController } from "./ai/orchestration/AgentController";
import { DEFAULT_BOT_NAME } from "./ai/prompts/systemPrompt";
import { ToolRouterAgent } from "./ai/orchestration/ToolRouterAgent";
import { MemoryAgent } from "./ai/orchestration/MemoryAgent";
import { SafetyAgent } from "./ai/orchestration/SafetyAgent";

import { buildToolRegistry } from "./tools";
import {
  EmbeddingToolRetrievalStrategy,
  KeywordToolRetrievalStrategy,
  ToolRouter,
  type ToolRetrievalStrategy,
} from "./tools/ToolRouter";
import { ToolExecutor } from "./tools/ToolExecutor";
import { ToolPermissionService } from "./tools/ToolPermissionService";
import { ToolCooldownService } from "./tools/ToolCooldownService";

import { initDatabase, closeDatabase } from "./database/prisma";
import { ConversationRepository } from "./database/repositories/ConversationRepository";
import { UserRepository } from "./database/repositories/UserRepository";
import { ToolLogRepository } from "./database/repositories/ToolLogRepository";
import { TrainingExampleRepository } from "./database/repositories/TrainingExampleRepository";
import { UserFeedbackRepository } from "./database/repositories/UserFeedbackRepository";
import { LiveLearningRepository } from "./database/repositories/LiveLearningRepository";
import { GuildRepository } from "./database/repositories/GuildRepository";

import { MemoryService } from "./memory/MemoryService";
import { LLMMemoryExtractor } from "./memory/MemoryExtractor";
import type { MemoryStore } from "./memory/MemoryStore";
import { InMemoryMemoryStore } from "./memory/InMemoryMemoryStore";
import { PgVectorMemoryStore } from "./memory/PgVectorMemoryStore";
import { QdrantMemoryStore } from "./memory/QdrantMemoryStore";
import {
  HashingEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  type EmbeddingProvider,
} from "./memory/EmbeddingProvider";

import { SafetyService } from "./safety/SafetyService";
import { RateLimitService } from "./safety/RateLimitService";
import { HttpModerationProvider } from "./safety/ModerationProvider";
import { connectRedisRuntimeState, type RedisRuntimeState } from "./state/RedisRuntimeState";
import { InMemoryRecentConversationWindow } from "./state/RecentConversationWindow";
import { TrainingDataLogger } from "./training/TrainingDataLogger";
import { DatasetExporter } from "./training/DatasetExporter";
import { InteractionLearningCapture } from "./learning/InteractionLearningCapture";
import { SkillRetrievalService } from "./learning/SkillRetrievalService";
import { ParameterActivationService } from "./learning/ParameterActivationService";
import { ParameterModuleStagingService } from "./learning/ParameterModuleStagingService";
import {
  HttpParameterModuleHotloadLoader,
  ParameterModuleHotloadService,
} from "./learning/ParameterModuleHotloadService";
import { ParameterGrowthPlanner } from "./training/parameter/ParameterGrowthPlanner";
import { ParameterGrowthDatasetBuilder } from "./training/parameter/ParameterGrowthDatasetBuilder";
import { ParameterGrowthDatasetBuildRunner } from "./training/parameter/ParameterGrowthDatasetBuildRunner";
import {
  HttpParameterTrainerBackend,
  ParameterTrainerDispatchService,
} from "./training/parameter/ParameterTrainerDispatchService";

import { createDiscordClient, startDiscordClient } from "./discord/client";
import { VoiceListeningPresenceIndicator } from "./discord/presence";
import { createMessageHandler } from "./discord/events/messageCreate";
import { createInteractionHandler } from "./discord/events/interactionCreate";
import { DiscordVoiceService } from "./discord/voice/DiscordVoiceService";
import { VoiceReceiveBridge } from "./discord/voice/VoiceReceiveBridge";
import { HttpVoiceReceivePreprocessor } from "./discord/voice/VoiceReceivePreprocessor";
import { VoiceSpeechQueue } from "./discord/voice/VoiceSpeechQueue";
import { DiscordVoiceSpeechPlayer, HttpTtsProvider } from "./discord/voice/VoiceTtsPlayback";
import { HttpSttProvider } from "./discord/voice/VoiceSttTranscription";
import type { CommandServices } from "./discord/commands";

import { buildApiServer, startApiServer } from "./server/api";
import { InProcessJobQueue, RedisJobQueue, type JobQueue } from "./jobs/queue";
import { registerMemorySummarizerWorker } from "./jobs/workers/memorySummarizerWorker";
import { registerDatasetExportWorker } from "./jobs/workers/datasetExportWorker";
import { registerParameterGrowthPlannerWorker } from "./jobs/workers/parameterGrowthPlannerWorker";

/**
 * Composition root. Degrades gracefully: no DB → persistence off; no
 * vector store → in-process memory; no Discord token → API-only mode.
 * Every degradation is logged loudly at startup.
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  logger.info({ nodeEnv: env.NODE_ENV }, "starting custom-llm-discord-bot");

  // ── Database (optional) ────────────────────────────────────────────────
  const prisma = await initDatabase(childLogger("database"));
  const conversationRepo = prisma ? new ConversationRepository(prisma) : null;
  const userRepo = prisma ? new UserRepository(prisma) : null;
  const toolLogRepo = prisma ? new ToolLogRepository(prisma) : null;
  const trainingRepo = prisma ? new TrainingExampleRepository(prisma) : null;
  const feedbackRepo = prisma ? new UserFeedbackRepository(prisma) : null;
  const learningRepo = prisma ? new LiveLearningRepository(prisma) : null;
  const guildRepo = prisma ? new GuildRepository(prisma) : null;
  const redisRuntimeState = await initRuntimeState();
  const recentConversationWindow =
    redisRuntimeState?.recentConversationWindow ?? new InMemoryRecentConversationWindow();

  // ── LLM ────────────────────────────────────────────────────────────────
  const llm = buildLLMRouterFromEnv(env, childLogger("llm"));
  logger.info({ providers: llm.listProviders() }, "llm configured");

  // ── Embeddings + memory ────────────────────────────────────────────────
  let memoryService: MemoryService | null = null;
  let embeddings: EmbeddingProvider | null = null;
  if (env.MEMORY_ENABLED) {
    embeddings =
      env.EMBEDDING_PROVIDER === "hashing"
        ? new HashingEmbeddingProvider()
        : new OpenAICompatibleEmbeddingProvider({
            baseUrl: env.EMBEDDING_BASE_URL,
            model: env.EMBEDDING_MODEL,
            logger: childLogger("embeddings"),
          });

    const store = await selectMemoryStore(embeddings, prisma);
    const memoryExtractor =
      env.MEMORY_EXTRACTION_MODE === "heuristic"
        ? null
        : new LLMMemoryExtractor(llm, childLogger("memory-extractor"), {
            minConfidence: env.MEMORY_EXTRACTOR_MIN_CONFIDENCE,
            maxActions: env.MEMORY_EXTRACTOR_MAX_ACTIONS,
          });
    memoryService = new MemoryService(store, embeddings, childLogger("memory"), {
      learning: learningRepo,
      extractor: memoryExtractor,
      extractionMode: env.MEMORY_EXTRACTION_MODE,
    });
    logger.info(
      { store: store.name, embeddings: embeddings.name, extractionMode: env.MEMORY_EXTRACTION_MODE },
      "memory system ready",
    );
  } else {
    logger.info("memory system disabled via MEMORY_ENABLED=false");
  }

  // ── Safety ─────────────────────────────────────────────────────────────
  const moderationProvider = env.SAFETY_MODERATION_ENDPOINT
    ? new HttpModerationProvider({
        endpointUrl: env.SAFETY_MODERATION_ENDPOINT,
        ...(env.SAFETY_MODERATION_API_KEY ? { apiKey: env.SAFETY_MODERATION_API_KEY } : {}),
        timeoutMs: env.SAFETY_MODERATION_TIMEOUT_MS,
      })
    : undefined;
  const safetyService = new SafetyService(childLogger("safety"), {
    enabled: env.SAFETY_ENABLED,
    rateLimit: new RateLimitService({
      ...(redisRuntimeState ? { store: redisRuntimeState.rateLimitStore } : {}),
    }),
    ...(moderationProvider ? { moderationProvider, moderationFailClosed: env.SAFETY_MODERATION_FAIL_CLOSED } : {}),
  });
  logger.info(
    {
      safetyEnabled: env.SAFETY_ENABLED,
      moderationProviderConfigured: Boolean(moderationProvider),
      moderationFailClosed: env.SAFETY_MODERATION_FAIL_CLOSED,
    },
    "safety service ready",
  );

  // ── Tools ──────────────────────────────────────────────────────────────
  const registry = buildToolRegistry();
  const toolRouterLogger = childLogger("tool-router");
  const toolRetrievalStrategy = buildToolRetrievalStrategy(registry, embeddings, toolRouterLogger);
  const toolRouter = new ToolRouter(registry, { strategy: toolRetrievalStrategy, logger: toolRouterLogger });
  const executor = new ToolExecutor({
    registry,
    permissions: new ToolPermissionService(),
    cooldowns: new ToolCooldownService(redisRuntimeState?.cooldownStore),
    logger: childLogger("tool-executor"),
    logSink: toolLogRepo,
    safetyEnabled: env.SAFETY_ENABLED,
  });
  logger.info(
    { tools: registry.size, categories: registry.categories(), retrieval: env.TOOL_ROUTER_STRATEGY },
    "tool registry ready",
  );

  // ── Training capture ───────────────────────────────────────────────────
  const trainingLogger = new TrainingDataLogger({
    conversations: conversationRepo,
    examples: trainingRepo,
    users: userRepo,
    logger: childLogger("training"),
    enabled: env.TRAINING_LOGGING_ENABLED,
  });
  const exporter = trainingRepo
    ? new DatasetExporter({ source: trainingRepo, feedbackSource: feedbackRepo ?? undefined, logger: childLogger("exporter") })
    : null;
  const learningCapture = learningRepo ? new InteractionLearningCapture(learningRepo, childLogger("learning-capture")) : null;
  const skillRetriever = learningRepo ? new SkillRetrievalService(learningRepo) : null;
  const parameterActivator = learningRepo ? new ParameterActivationService(learningRepo) : null;
  const parameterModuleStaging = learningRepo ? new ParameterModuleStagingService(learningRepo) : null;
  const parameterHotloadLoader = env.PARAMETER_HOTLOAD_ENDPOINT
    ? new HttpParameterModuleHotloadLoader({
        endpointUrl: env.PARAMETER_HOTLOAD_ENDPOINT,
        ...(env.PARAMETER_HOTLOAD_API_KEY ? { apiKey: env.PARAMETER_HOTLOAD_API_KEY } : {}),
        timeoutMs: env.PARAMETER_HOTLOAD_TIMEOUT_MS,
      })
    : undefined;
  const parameterHotloadService = new ParameterModuleHotloadService(parameterHotloadLoader);
  logger.info({ configured: Boolean(parameterHotloadLoader) }, "parameter hotload service ready");
  const parameterGrowthPlanner = learningRepo ? new ParameterGrowthPlanner(learningRepo) : null;
  const parameterGrowthDatasetRunner = learningRepo
    ? new ParameterGrowthDatasetBuildRunner(new ParameterGrowthDatasetBuilder(learningRepo))
    : null;
  const parameterTrainerBackend = env.PARAMETER_TRAINER_ENDPOINT
    ? new HttpParameterTrainerBackend({
        endpointUrl: env.PARAMETER_TRAINER_ENDPOINT,
        ...(env.PARAMETER_TRAINER_API_KEY ? { apiKey: env.PARAMETER_TRAINER_API_KEY } : {}),
        timeoutMs: env.PARAMETER_TRAINER_TIMEOUT_MS,
      })
    : undefined;
  const parameterTrainerDispatch = new ParameterTrainerDispatchService({
    ...(parameterTrainerBackend ? { backend: parameterTrainerBackend } : {}),
  });
  logger.info({ configured: Boolean(parameterTrainerBackend) }, "parameter trainer dispatch service ready");

  // ── Discord client + agent ─────────────────────────────────────────────
  const discordClient = createDiscordClient();
  const discordPresence = {
    status: env.DISCORD_PRESENCE_STATUS,
    activityType: env.DISCORD_PRESENCE_ACTIVITY_TYPE,
    activityName: env.DISCORD_PRESENCE_ACTIVITY_NAME,
  };
  const voicePresenceIndicator = new VoiceListeningPresenceIndicator({
    client: discordClient,
    basePresence: discordPresence,
    logger: childLogger("presence"),
  });
  const voiceSpeechQueue = env.VOICE_TTS_ENDPOINT
    ? new VoiceSpeechQueue(
        new DiscordVoiceSpeechPlayer({
          tts: new HttpTtsProvider({
            endpointUrl: env.VOICE_TTS_ENDPOINT,
            ...(env.VOICE_TTS_API_KEY ? { apiKey: env.VOICE_TTS_API_KEY } : {}),
            voice: env.VOICE_TTS_VOICE,
            format: env.VOICE_TTS_FORMAT,
            timeoutMs: env.VOICE_TTS_TIMEOUT_MS,
          }),
          streamType: env.VOICE_TTS_STREAM_TYPE,
          playbackTimeoutMs: env.VOICE_TTS_PLAYBACK_TIMEOUT_MS,
          logger: childLogger("voice-tts"),
        }),
        {
          maxTextChars: env.VOICE_SPEECH_MAX_CHARS,
          maxQueueDepth: env.VOICE_SPEECH_MAX_QUEUE_DEPTH,
          cooldownMs: env.VOICE_SPEECH_COOLDOWN_MS,
          onPlaybackError: (job, err) =>
            childLogger("voice-tts").warn(
              { jobId: job.id, guildId: job.guildId, err: toErrorMessage(err) },
              "voice speech playback failed",
            ),
        },
      )
    : null;
  logger.info({ ttsConfigured: Boolean(voiceSpeechQueue) }, "voice speech queue ready");
  const sttProvider = env.VOICE_STT_ENDPOINT
    ? new HttpSttProvider({
        endpointUrl: env.VOICE_STT_ENDPOINT,
        ...(env.VOICE_STT_API_KEY ? { apiKey: env.VOICE_STT_API_KEY } : {}),
        ...(env.VOICE_STT_MODEL ? { model: env.VOICE_STT_MODEL } : {}),
        language: env.VOICE_STT_LANGUAGE,
        format: env.VOICE_STT_FORMAT,
        timeoutMs: env.VOICE_STT_TIMEOUT_MS,
      })
    : null;
  logger.info({ sttConfigured: Boolean(sttProvider) }, "voice transcription provider ready");
  const voiceReceivePreprocessor = env.VOICE_RECEIVE_PREPROCESS_ENDPOINT
    ? new HttpVoiceReceivePreprocessor({
        endpointUrl: env.VOICE_RECEIVE_PREPROCESS_ENDPOINT,
        ...(env.VOICE_RECEIVE_PREPROCESS_API_KEY ? { apiKey: env.VOICE_RECEIVE_PREPROCESS_API_KEY } : {}),
        timeoutMs: env.VOICE_RECEIVE_PREPROCESS_TIMEOUT_MS,
      })
    : null;
  logger.info({ configured: Boolean(voiceReceivePreprocessor) }, "voice receive preprocessing ready");
  const voiceService = new DiscordVoiceService({
    settingsStore: guildRepo,
    speechQueue: voiceSpeechQueue,
    sttProvider,
    presenceIndicator: voicePresenceIndicator,
    logger: childLogger("voice"),
  });

  const agent = new AgentController({
    llm,
    registry,
    executor,
    toolRouterAgent: env.TOOL_CALLING_ENABLED
      ? new ToolRouterAgent(registry, toolRouter)
      : null,
    memoryAgent: memoryService
      ? new MemoryAgent(memoryService, childLogger("memory-agent"))
      : null,
    skillRetriever,
    parameterActivator,
    safetyAgent: env.SAFETY_ENABLED ? new SafetyAgent(safetyService) : null,
    training: trainingLogger,
    learning: learningCapture,
    pendingConfirmations: redisRuntimeState?.pendingConfirmationStore,
    logger: childLogger("agent"),
    botName: DEFAULT_BOT_NAME,
    toolCallingEnabled: env.TOOL_CALLING_ENABLED,
    toolContextExtras: { db: prisma, memory: memoryService, discordClient },
  });

  voiceService.setReceiveBridge(
    new VoiceReceiveBridge({
      transcribeBufferedAudio: (ctx, input) => voiceService.transcribeBufferedAudio(ctx, input),
      agent,
      speechQueue: voiceSpeechQueue,
      getGuildSettings: guildRepo ? (guildId) => guildRepo.getSettings(guildId) : undefined,
      client: discordClient,
      logger: childLogger("voice-receive"),
      receiveFormat: env.VOICE_RECEIVE_FORMAT,
      preprocessAudio: voiceReceivePreprocessor ? (input) => voiceReceivePreprocessor.call(input) : undefined,
    }),
  );

  // ── Health/stats providers (shared by API + !ai commands) ──────────────
  const getHealth = async (): Promise<HealthPayload> => ({
    status: discordClient.isReady() || !env.DISCORD_TOKEN ? "ok" : "degraded",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    discord: { configured: env.DISCORD_TOKEN.length > 0, connected: discordClient.isReady() },
    llm: { provider: llm.info.name, model: llm.info.model, baseUrl: llm.info.baseUrl },
    database: { available: prisma !== null },
    runtimeState: {
      store: redisRuntimeState ? "redis" : "memory",
      redisConnected: redisRuntimeState !== null,
    },
    memory: {
      enabled: memoryService !== null,
      store: memoryService ? memoryService.storeName : "disabled",
    },
  });

  const getStats = async (): Promise<StatsPayload> => {
    const learningStats = learningRepo ? await safeValue(() => learningRepo.getStats()) : null;
    return {
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      registry: { tools: registry.size, categories: registry.categories() },
      llm: { provider: llm.info.name, model: llm.info.model },
      learning: learningStats ? { enabled: true, ...learningStats } : { enabled: false },
      db: prisma
        ? {
            available: true,
            conversations: await safeCount(() => conversationRepo?.count()),
            toolLogs: await safeCount(() => toolLogRepo?.count()),
            trainingExamples: await safeCount(() => trainingRepo?.count()),
            memories: await safeCount(() => memoryService?.count()),
          }
        : { available: false },
    };
  };

  // ── Discord event handlers ─────────────────────────────────────────────
  const commandServices: CommandServices = {
    registry,
    executor,
    buildToolContext: (ctx) => ({
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      memberPermissions: ctx.memberPermissions,
      disabledTools: ctx.guildSettings?.disabledTools,
      message: ctx.raw,
      discordClient,
      logger: childLogger("tool"),
      db: prisma,
      memory: memoryService,
    }),
    memory: memoryService,
    voice: voiceService,
    settingsStore: guildRepo,
    exporter,
    stats: getStats,
    health: getHealth,
    logger: childLogger("commands"),
  };

  discordClient.on(
    Events.MessageCreate,
    createMessageHandler({
      client: discordClient,
      agent,
      commandServices,
      commandPrefix,
      settingsStore: guildRepo,
      recentConversationWindow,
      logger: childLogger("discord"),
    }),
  );
  discordClient.on(
    Events.InteractionCreate,
    createInteractionHandler({
      agent,
      commandServices,
      settingsStore: guildRepo,
      recentConversationWindow,
      logger: childLogger("discord"),
    }),
  );

  // ── API server ─────────────────────────────────────────────────────────
  const api = buildApiServer({
    registry,
    memory: memoryService ? (q, ctx, topK) => memoryService.search(q, ctx, topK) : null,
    learningStats: learningRepo ? () => learningRepo.getStats() : null,
    listLearnedItems: learningRepo ? (filter) => learningRepo.listLearnedItems(filter) : null,
    getLearnedItem: learningRepo ? (id) => learningRepo.getLearnedItem(id) : null,
    markLearningReviewed: learningRepo ? (id, status, options) => learningRepo.markReviewed(id, status, options) : null,
    queueLearningForTraining: learningRepo ? (id, options) => learningRepo.queueForTraining(id, options) : null,
    listParameterModules: learningRepo ? (filter) => learningRepo.listParameterModules(filter) : null,
    getParameterModule: learningRepo ? (id) => learningRepo.getParameterModule(id) : null,
    createParameterModule: learningRepo ? (input) => learningRepo.createParameterModule(input) : null,
    stageParameterModuleFromManifest: parameterModuleStaging
      ? (input) => parameterModuleStaging.stageFromManifest(input)
      : null,
    buildParameterGrowthPlan: parameterGrowthPlanner ? (options) => parameterGrowthPlanner.buildPlan(options) : null,
    writeParameterGrowthPlan: parameterGrowthPlanner
      ? (outDir, options) => parameterGrowthPlanner.writePlan(outDir, options)
      : null,
    buildParameterGrowthDataset: parameterGrowthDatasetRunner ? (input) => parameterGrowthDatasetRunner.run(input) : null,
    dispatchParameterTraining: (input) => parameterTrainerDispatch.dispatch(input),
    applyParameterHotloadManifest: (input) => parameterHotloadService.apply(input),
    promoteParameterModule: learningRepo ? (id, options) => learningRepo.promoteParameterModule(id, options) : null,
    retireParameterModule: learningRepo ? (id) => learningRepo.retireParameterModule(id) : null,
    getParameterSnapshot: learningRepo ? (options) => learningRepo.getParameterSnapshot(options) : null,
    exporter: exporter ? (outDir) => exporter.exportAll(outDir) : null,
    recordFeedbackPreference: feedbackRepo ? (input) => feedbackRepo.createPreferencePair(input) : null,
    getHealth,
    getStats,
    logger: childLogger("api"),
  });
  await startApiServer(api, { port: env.API_PORT, host: env.API_HOST }, childLogger("api"));

  // ── Background jobs ────────────────────────────────────────────────────
  const queue = buildJobQueue(redisRuntimeState);
  registerMemorySummarizerWorker(queue, {
    conversations: conversationRepo,
    memory: memoryService,
    learning: learningRepo,
    llm,
    logger: childLogger("jobs"),
  });
  registerDatasetExportWorker(queue, { exporter, logger: childLogger("jobs") });
  registerParameterGrowthPlannerWorker(queue, { planner: parameterGrowthPlanner, logger: childLogger("jobs") });
  queue.start();

  // ── Discord login (optional in API-only/dev mode) ──────────────────────
  if (env.DISCORD_TOKEN) {
    await startDiscordClient(discordClient, env.DISCORD_TOKEN, childLogger("discord"), discordPresence);
  } else {
    logger.warn("DISCORD_TOKEN not set — running in API-only mode (no Discord connection)");
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    queue.stop();
    await redisRuntimeState?.close().catch(() => undefined);
    await api.close().catch(() => undefined);
    await discordClient.destroy().catch(() => undefined);
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("startup complete");
}

async function initRuntimeState(): Promise<RedisRuntimeState | null> {
  if (env.RUNTIME_STATE_STORE !== "redis") {
    logger.info({ store: "memory" }, "runtime state configured");
    return null;
  }

  try {
    const state = await connectRedisRuntimeState({
      url: env.REDIS_URL,
      keyPrefix: env.REDIS_KEY_PREFIX,
      connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
      logger: childLogger("redis"),
    });
    logger.info({ store: "redis", url: env.REDIS_URL, keyPrefix: env.REDIS_KEY_PREFIX }, "runtime state configured");
    return state;
  } catch (err) {
    logger.warn(
      { err: toErrorMessage(err), url: env.REDIS_URL },
      "redis runtime state unavailable; falling back to in-memory state",
    );
    return null;
  }
}

async function selectMemoryStore(
  embeddings: EmbeddingProvider,
  prisma: Awaited<ReturnType<typeof initDatabase>>,
): Promise<MemoryStore> {
  const log = childLogger("memory");

  // Stores need embedding dims; resolve them once up-front (remote providers
  // discover dims on first call). Failure → hashing/in-memory fallback.
  let dims = embeddings.dims;
  if (dims <= 0) {
    try {
      await embeddings.embed(["dimension probe"]);
      dims = embeddings.dims;
    } catch (err) {
      log.warn(
        { err: toErrorMessage(err) },
        "embedding endpoint unreachable — falling back to in-process memory store",
      );
      return new InMemoryMemoryStore();
    }
  }

  try {
    if (env.VECTOR_STORE === "pgvector") {
      if (!prisma) throw new Error("pgvector store requires a database connection");
      const store = new PgVectorMemoryStore(prisma, log, { dims });
      await store.init();
      return store;
    }
    if (env.VECTOR_STORE === "qdrant") {
      const store = new QdrantMemoryStore({
        url: env.QDRANT_URL,
        collection: env.QDRANT_COLLECTION,
        dims,
        prisma,
        logger: log,
      });
      await store.init();
      return store;
    }
  } catch (err) {
    log.warn(
      { err: toErrorMessage(err), configured: env.VECTOR_STORE },
      "configured vector store failed to initialize — falling back to in-process memory store",
    );
  }
  return new InMemoryMemoryStore();
}

function buildToolRetrievalStrategy(
  registry: ReturnType<typeof buildToolRegistry>,
  embeddings: EmbeddingProvider | null,
  logger: ReturnType<typeof childLogger>,
): ToolRetrievalStrategy {
  const keyword = new KeywordToolRetrievalStrategy(registry);
  if (env.TOOL_ROUTER_STRATEGY !== "embedding") return keyword;

  const toolEmbeddings = embeddings ?? new HashingEmbeddingProvider();
  return new EmbeddingToolRetrievalStrategy(registry, toolEmbeddings, {
    fallback: keyword,
    logger,
  });
}

function buildJobQueue(redisRuntimeState: RedisRuntimeState | null): JobQueue {
  if (!redisRuntimeState) return new InProcessJobQueue(childLogger("jobs"));
  return new RedisJobQueue({
    client: redisRuntimeState.client,
    keyPrefix: env.REDIS_KEY_PREFIX,
    logger: childLogger("jobs"),
  });
}

async function safeCount(fn: () => Promise<number> | undefined): Promise<number | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

async function safeValue<T>(fn: () => Promise<T> | undefined): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err: toErrorMessage(err) }, "fatal startup error");
  process.exit(1);
});
