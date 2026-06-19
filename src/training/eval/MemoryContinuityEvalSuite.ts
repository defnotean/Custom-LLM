import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pino from "pino";
import { LiveLearningRegistry, type LearnedItem } from "../../learning/LiveLearningRegistry";
import { HashingEmbeddingProvider } from "../../memory/EmbeddingProvider";
import { InMemoryMemoryStore } from "../../memory/InMemoryMemoryStore";
import type { MemoryExtractionDecision, MemoryExtractionMode, MemoryExtractor } from "../../memory/MemoryExtractor";
import { MemoryService, type RememberInput } from "../../memory/MemoryService";
import type { EvalLatencyStats } from "./ToolEvalSuite";

export type MemoryContinuityCaseKind =
  | "explicit_recall"
  | "implicit_capture"
  | "scope_isolation"
  | "forget"
  | "policy_rejection"
  | "learning_capture"
  | "llm_extraction";

export interface MemoryContinuityEvalCase {
  id: string;
  kind: MemoryContinuityCaseKind;
  description: string;
  metadata: Record<string, unknown>;
}

export interface MemoryContinuityEvalSuite {
  cases: MemoryContinuityEvalCase[];
}

export interface MemoryContinuitySuiteSummary {
  path: string;
  cases: number;
  byKind: Record<string, number>;
  sha256: string;
}

export interface MemoryContinuityCaseResult {
  id: string;
  kind: MemoryContinuityCaseKind;
  passed: boolean;
  stored: boolean;
  recalled: boolean;
  isolated: boolean | null;
  forgetPassed: boolean | null;
  policyRejected: boolean | null;
  learnedItemCaptured: boolean | null;
  latencyMs: number;
  reasons: string[];
}

export interface MemoryContinuityReport {
  suitePath: string;
  total: number;
  passRate: number;
  storedExpectedRate: number;
  recallHitRate: number;
  isolationPassRate: number;
  forgetPassRate: number;
  policyRejectionPassRate: number;
  learnedItemPassRate: number;
  latencyMs: EvalLatencyStats;
  byKind: Record<string, { total: number; passRate: number }>;
  failures: Array<{ id: string; kind: MemoryContinuityCaseKind; reasons: string[] }>;
  results: MemoryContinuityCaseResult[];
}

const CASES: MemoryContinuityEvalCase[] = [
  evalCase(
    "memory:case:explicit-user-recall",
    "explicit_recall",
    "Explicit USER memories are immediately retrievable for the same user context.",
  ),
  evalCase(
    "memory:case:implicit-preference-capture",
    "implicit_capture",
    "Stable preferences from conversation write-back are retrievable without restart.",
  ),
  evalCase(
    "memory:case:user-scope-isolation",
    "scope_isolation",
    "USER memories never leak into another user's retrieval context.",
  ),
  evalCase(
    "memory:case:guild-scope-isolation",
    "scope_isolation",
    "GUILD memories are shared inside one guild but isolated from other guilds.",
  ),
  evalCase(
    "memory:case:channel-scope-isolation",
    "scope_isolation",
    "CHANNEL memories are visible only in the channel where they were stored.",
  ),
  evalCase(
    "memory:case:owner-forget",
    "forget",
    "A user can delete their own USER memory and it disappears from recall.",
  ),
  evalCase(
    "memory:case:non-owner-forget-denied",
    "forget",
    "A non-admin cannot delete another user's USER memory.",
  ),
  evalCase(
    "memory:case:admin-forget-guild",
    "forget",
    "An admin can delete a GUILD memory and it disappears from recall.",
  ),
  evalCase(
    "memory:case:secret-rejected",
    "policy_rejection",
    "Secrets are rejected even when explicitly submitted as memory.",
  ),
  evalCase(
    "memory:case:oneoff-rejected",
    "policy_rejection",
    "One-off casual chatter is not promoted into durable memory.",
  ),
  evalCase(
    "memory:case:explicit-learned-item",
    "learning_capture",
    "Explicit memory writes create trainable learned items for review.",
  ),
  evalCase(
    "memory:case:implicit-learned-item",
    "learning_capture",
    "Implicit memory writes create retrievable but non-trainable learned items.",
  ),
  evalCase(
    "memory:case:llm-extraction-add",
    "llm_extraction",
    "LLM ADD extraction stores a concise policy-gated memory instead of the raw turn.",
  ),
  evalCase(
    "memory:case:llm-extraction-update",
    "llm_extraction",
    "LLM UPDATE extraction replaces a matching memory without losing recall.",
  ),
  evalCase(
    "memory:case:llm-extraction-delete",
    "llm_extraction",
    "LLM DELETE extraction removes a matching memory from recall.",
  ),
  evalCase(
    "memory:case:llm-extraction-noop",
    "llm_extraction",
    "LLM NOOP extraction prevents non-durable turns from falling back into memory.",
  ),
  evalCase(
    "memory:case:llm-extraction-policy-guard",
    "llm_extraction",
    "LLM ADD extraction still cannot store secrets because MemoryPolicy gates every candidate.",
  ),
];

const logger = pino({ level: "silent" });

export async function writeMemoryContinuityEvalSuite(outPath: string): Promise<MemoryContinuitySuiteSummary> {
  await mkdir(dirname(outPath), { recursive: true });
  const suite: MemoryContinuityEvalSuite = { cases: CASES };
  const body = `${JSON.stringify(suite, null, 2)}\n`;
  await writeFile(outPath, body, "utf8");
  return {
    path: outPath,
    cases: suite.cases.length,
    byKind: countBy(suite.cases.map((item) => item.kind)),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

export async function evaluateMemoryContinuitySuite(suitePath: string): Promise<MemoryContinuityReport> {
  const suite = JSON.parse(await readFile(suitePath, "utf8")) as MemoryContinuityEvalSuite;
  const results: MemoryContinuityCaseResult[] = [];
  const failures: MemoryContinuityReport["failures"] = [];
  const byKindRaw: Record<string, { total: number; passed: number }> = {};
  const latencyValues: number[] = [];

  for (const item of suite.cases) {
    const result = await evaluateCase(item);
    results.push(result);
    latencyValues.push(result.latencyMs);

    const kindStats = byKindRaw[item.kind] ?? { total: 0, passed: 0 };
    kindStats.total++;
    if (result.passed) kindStats.passed++;
    byKindRaw[item.kind] = kindStats;

    if (!result.passed) failures.push({ id: result.id, kind: result.kind, reasons: result.reasons });
  }

  const storedExpected = results.filter((item) => storedExpectedKinds.has(item.kind));
  const recallExpected = results.filter((item) => recallExpectedKinds.has(item.kind));
  const isolationExpected = results.filter((item) => item.isolated !== null);
  const forgetExpected = results.filter((item) => item.forgetPassed !== null);
  const rejectionExpected = results.filter((item) => item.policyRejected !== null);
  const learnedExpected = results.filter((item) => item.learnedItemCaptured !== null);

  return {
    suitePath,
    total: suite.cases.length,
    passRate: ratio(results.filter((item) => item.passed).length, results.length),
    storedExpectedRate: ratio(storedExpected.filter((item) => item.stored).length, storedExpected.length),
    recallHitRate: ratio(recallExpected.filter((item) => item.recalled).length, recallExpected.length),
    isolationPassRate: ratio(isolationExpected.filter((item) => item.isolated === true).length, isolationExpected.length),
    forgetPassRate: ratio(forgetExpected.filter((item) => item.forgetPassed === true).length, forgetExpected.length),
    policyRejectionPassRate: ratio(
      rejectionExpected.filter((item) => item.policyRejected === true).length,
      rejectionExpected.length,
    ),
    learnedItemPassRate: ratio(
      learnedExpected.filter((item) => item.learnedItemCaptured === true).length,
      learnedExpected.length,
    ),
    latencyMs: latencyStats(latencyValues),
    byKind: Object.fromEntries(
      Object.entries(byKindRaw).map(([kind, stats]) => [
        kind,
        { total: stats.total, passRate: ratio(stats.passed, stats.total) },
      ]),
    ),
    failures: failures.slice(0, 100),
    results,
  };
}

async function evaluateCase(item: MemoryContinuityEvalCase): Promise<MemoryContinuityCaseResult> {
  const started = Date.now();
  const reasons: string[] = [];
  let stored = false;
  let recalled = false;
  let isolated: boolean | null = null;
  let forgetPassed: boolean | null = null;
  let policyRejected: boolean | null = null;
  let learnedItemCaptured: boolean | null = null;

  switch (item.id) {
    case "memory:case:explicit-user-recall": {
      const harness = makeHarness();
      const result = await harness.service.remember(
        memoryInput("I prefer concise implementation updates and my Irene project timezone is CST", {
          explicit: true,
        }),
      );
      stored = result.stored;
      recalled = await hasRecall(harness.service, "concise implementation updates CST", defaultCtx(), "timezone is CST");
      if (!stored) reasons.push(`expected memory storage, got: ${result.reason}`);
      if (!recalled) reasons.push("expected same-user recall hit");
      break;
    }
    case "memory:case:implicit-preference-capture": {
      const harness = makeHarness();
      const result = await harness.service.maybeExtractMemoryFromConversation(
        defaultCtx(),
        "I prefer short deployment summaries after each push",
        "Understood.",
      );
      stored = result.stored;
      recalled = await hasRecall(harness.service, "short deployment summaries", defaultCtx(), "short deployment summaries");
      if (!stored) reasons.push(`expected implicit stable preference capture, got: ${result.reason}`);
      if (!recalled) reasons.push("expected implicit memory recall hit");
      break;
    }
    case "memory:case:user-scope-isolation": {
      const harness = makeHarness();
      const result = await harness.service.remember(
        memoryInput("I main support in ranked matches and want that remembered", { explicit: true }),
      );
      stored = result.stored;
      const ownerHit = await hasRecall(harness.service, "main support ranked matches", defaultCtx(), "main support");
      const otherHit = await hasRecall(
        harness.service,
        "main support ranked matches",
        { userId: "user-beta", guildId: "guild-alpha", channelId: "channel-alpha" },
        "main support",
      );
      recalled = ownerHit;
      isolated = ownerHit && !otherHit;
      if (!stored) reasons.push(`expected memory storage, got: ${result.reason}`);
      if (!ownerHit) reasons.push("expected owner recall hit");
      if (otherHit) reasons.push("memory leaked into another user's search context");
      break;
    }
    case "memory:case:guild-scope-isolation": {
      const harness = makeHarness();
      const result = await harness.service.remember(
        memoryInput("The project standup schedule is Friday at 17:00 UTC", {
          explicit: true,
          scope: "GUILD",
          guildId: "guild-alpha",
        }),
      );
      stored = result.stored;
      const sameGuildHit = await hasRecall(
        harness.service,
        "project standup Friday 17:00 UTC",
        { userId: "user-beta", guildId: "guild-alpha", channelId: "channel-alpha" },
        "17:00 UTC",
      );
      const otherGuildHit = await hasRecall(
        harness.service,
        "project standup Friday 17:00 UTC",
        { userId: "user-beta", guildId: "guild-beta", channelId: "channel-alpha" },
        "17:00 UTC",
      );
      recalled = sameGuildHit;
      isolated = sameGuildHit && !otherGuildHit;
      if (!stored) reasons.push(`expected guild memory storage, got: ${result.reason}`);
      if (!sameGuildHit) reasons.push("expected same-guild recall hit");
      if (otherGuildHit) reasons.push("guild memory leaked into another guild");
      break;
    }
    case "memory:case:channel-scope-isolation": {
      const harness = makeHarness();
      const result = await harness.service.remember(
        memoryInput("This channel sprint tag is violet-delta", {
          explicit: true,
          scope: "CHANNEL",
          channelId: "channel-alpha",
        }),
      );
      stored = result.stored;
      const sameChannelHit = await hasRecall(
        harness.service,
        "channel sprint tag violet-delta",
        defaultCtx(),
        "violet-delta",
      );
      const otherChannelHit = await hasRecall(
        harness.service,
        "channel sprint tag violet-delta",
        { userId: "user-alpha", guildId: "guild-alpha", channelId: "channel-beta" },
        "violet-delta",
      );
      recalled = sameChannelHit;
      isolated = sameChannelHit && !otherChannelHit;
      if (!stored) reasons.push(`expected channel memory storage, got: ${result.reason}`);
      if (!sameChannelHit) reasons.push("expected same-channel recall hit");
      if (otherChannelHit) reasons.push("channel memory leaked into another channel");
      break;
    }
    case "memory:case:owner-forget": {
      const harness = makeHarness();
      const result = await harness.service.remember(
        memoryInput("I prefer blue compact dashboards in admin views", { explicit: true }),
      );
      stored = result.stored;
      const id = result.id ?? "";
      const deleted = await harness.service.forget(id, { userId: "user-alpha", isAdmin: false });
      const afterForgetHit = await hasRecall(harness.service, "blue compact dashboards", defaultCtx(), "blue compact");
      forgetPassed = deleted.deleted && !afterForgetHit;
      recalled = !afterForgetHit;
      if (!stored) reasons.push(`expected memory storage, got: ${result.reason}`);
      if (!deleted.deleted) reasons.push(`expected owner delete, got: ${deleted.reason}`);
      if (afterForgetHit) reasons.push("forgotten owner memory was still recalled");
      break;
    }
    case "memory:case:non-owner-forget-denied": {
      const harness = makeHarness();
      const result = await harness.service.remember(
        memoryInput("I prefer terminal-first debugging notes", { explicit: true }),
      );
      stored = result.stored;
      const denied = await harness.service.forget(result.id ?? "", { userId: "user-beta", isAdmin: false });
      const ownerHit = await hasRecall(harness.service, "terminal-first debugging notes", defaultCtx(), "terminal-first");
      recalled = ownerHit;
      forgetPassed = !denied.deleted && ownerHit;
      if (!stored) reasons.push(`expected memory storage, got: ${result.reason}`);
      if (denied.deleted) reasons.push("non-owner deleted another user's memory");
      if (!ownerHit) reasons.push("owner memory was not retained after denied delete");
      break;
    }
    case "memory:case:admin-forget-guild": {
      const harness = makeHarness();
      const result = await harness.service.remember(
        memoryInput("The guild release room is channel redwood", {
          explicit: true,
          scope: "GUILD",
          guildId: "guild-alpha",
        }),
      );
      stored = result.stored;
      const deleted = await harness.service.forget(result.id ?? "", { userId: "admin-user", isAdmin: true });
      const afterForgetHit = await hasRecall(harness.service, "guild release room redwood", defaultCtx(), "redwood");
      forgetPassed = deleted.deleted && !afterForgetHit;
      recalled = !afterForgetHit;
      if (!stored) reasons.push(`expected guild memory storage, got: ${result.reason}`);
      if (!deleted.deleted) reasons.push(`expected admin delete, got: ${deleted.reason}`);
      if (afterForgetHit) reasons.push("forgotten guild memory was still recalled");
      break;
    }
    case "memory:case:secret-rejected": {
      const harness = makeHarness();
      const result = await harness.service.remember(
        memoryInput("my api key: sk-abcdefghijklmnop", { explicit: true }),
      );
      const count = await harness.service.count();
      stored = result.stored;
      policyRejected = !result.stored && count === 0 && harness.learnedItems().length === 0;
      if (result.stored) reasons.push("secret-like content was stored");
      if (count !== 0) reasons.push("memory store changed after secret rejection");
      if (harness.learnedItems().length !== 0) reasons.push("secret-like content created a learned item");
      break;
    }
    case "memory:case:oneoff-rejected": {
      const harness = makeHarness();
      const result = await harness.service.remember(
        memoryInput("lol nice one", { explicit: false }),
      );
      const count = await harness.service.count();
      stored = result.stored;
      policyRejected = !result.stored && count === 0;
      if (result.stored) reasons.push("one-off casual text was stored");
      if (count !== 0) reasons.push("memory store changed after one-off rejection");
      break;
    }
    case "memory:case:explicit-learned-item": {
      const harness = makeHarness();
      const result = await harness.service.remember(
        memoryInput("I prefer release notes with exact commit hashes", { explicit: true }),
      );
      const itemCaptured = matchingLearnedItem(harness.learnedItems(), {
        content: "exact commit hashes",
        source: "explicit_memory",
        canTrain: true,
      });
      stored = result.stored;
      recalled = await hasRecall(harness.service, "release notes exact commit hashes", defaultCtx(), "exact commit hashes");
      learnedItemCaptured = Boolean(itemCaptured && result.learnedItemId === itemCaptured.id);
      if (!stored) reasons.push(`expected memory storage, got: ${result.reason}`);
      if (!recalled) reasons.push("expected learned explicit memory to stay retrievable");
      if (!learnedItemCaptured) reasons.push("explicit memory did not create a trainable learned item");
      break;
    }
    case "memory:case:implicit-learned-item": {
      const harness = makeHarness();
      const result = await harness.service.maybeExtractMemoryFromConversation(
        defaultCtx(),
        "I usually want small focused diffs before broad refactors",
        "Got it.",
      );
      const itemCaptured = matchingLearnedItem(harness.learnedItems(), {
        content: "small focused diffs",
        source: "memory_policy",
        canTrain: false,
      });
      stored = result.stored;
      recalled = await hasRecall(harness.service, "small focused diffs", defaultCtx(), "small focused diffs");
      learnedItemCaptured = Boolean(itemCaptured);
      if (!stored) reasons.push(`expected implicit memory storage, got: ${result.reason}`);
      if (!recalled) reasons.push("expected implicit learned memory to stay retrievable");
      if (!learnedItemCaptured) reasons.push("implicit memory did not create a retrievable non-trainable learned item");
      break;
    }
    case "memory:case:llm-extraction-add": {
      const harness = makeHarness({
        extractionMode: "llm",
        extractionDecisions: [
          {
            action: "ADD",
            content: "I prefer concise implementation updates.",
            scope: "USER",
            confidence: 0.92,
            reason: "stable preference",
          },
        ],
      });
      const result = await harness.service.maybeExtractMemoryFromConversation(
        defaultCtx(),
        "btw for this project, short implementation updates are better than long ones",
        "Understood.",
      );
      const rawTurnStored = await hasRecall(
        harness.service,
        "short implementation updates better",
        defaultCtx(),
        "btw for this project",
      );
      const itemCaptured = matchingLearnedItem(harness.learnedItems(), {
        content: "concise implementation updates",
        source: "llm_memory_extractor",
        canTrain: false,
      });
      stored = result.stored;
      recalled = await hasRecall(harness.service, "concise implementation updates", defaultCtx(), "concise implementation");
      learnedItemCaptured = Boolean(itemCaptured);
      if (!stored) reasons.push(`expected LLM ADD memory storage, got: ${result.reason}`);
      if (!recalled) reasons.push("expected LLM-extracted ADD memory recall hit");
      if (rawTurnStored) reasons.push("LLM ADD stored the raw turn instead of the extracted memory");
      if (!learnedItemCaptured) reasons.push("LLM ADD did not create a retrievable non-trainable learned item");
      break;
    }
    case "memory:case:llm-extraction-update": {
      const harness = makeHarness({
        extractionMode: "llm",
        extractionDecisions: [
          {
            action: "UPDATE",
            target: "short answers",
            content: "I prefer detailed implementation notes.",
            confidence: 0.9,
            reason: "preference correction",
          },
        ],
      });
      await harness.service.remember(memoryInput("I prefer short answers.", { explicit: true }));
      const result = await harness.service.maybeExtractMemoryFromConversation(
        defaultCtx(),
        "actually don't keep answers short; I want detailed implementation notes",
        "Updated.",
      );
      const oldHit = await hasRecall(harness.service, "short answers", defaultCtx(), "short answers");
      const count = await harness.service.count();
      stored = result.stored;
      recalled = await hasRecall(harness.service, "detailed implementation notes", defaultCtx(), "detailed implementation");
      if (!stored) reasons.push(`expected LLM UPDATE replacement storage, got: ${result.reason}`);
      if (!recalled) reasons.push("expected LLM-extracted UPDATE memory recall hit");
      if (oldHit) reasons.push("old memory remained after LLM UPDATE");
      if (count !== 1) reasons.push(`expected exactly one memory after LLM UPDATE, got ${count}`);
      break;
    }
    case "memory:case:llm-extraction-delete": {
      const harness = makeHarness({
        extractionMode: "llm",
        extractionDecisions: [{ action: "DELETE", target: "short answers", confidence: 0.94, reason: "forget request" }],
      });
      await harness.service.remember(memoryInput("I prefer short answers.", { explicit: true }));
      const result = await harness.service.maybeExtractMemoryFromConversation(
        defaultCtx(),
        "forget that I prefer short answers",
        "Forgotten.",
      );
      const afterDeleteHit = await hasRecall(harness.service, "short answers", defaultCtx(), "short answers");
      const count = await harness.service.count();
      stored = false;
      recalled = !afterDeleteHit;
      forgetPassed = result.reason.includes("deleted memory") && !afterDeleteHit && count === 0;
      if (!result.reason.includes("deleted memory")) reasons.push(`expected LLM DELETE to delete memory, got: ${result.reason}`);
      if (afterDeleteHit) reasons.push("deleted LLM extraction target was still recalled");
      if (count !== 0) reasons.push(`expected empty store after LLM DELETE, got ${count}`);
      break;
    }
    case "memory:case:llm-extraction-noop": {
      const harness = makeHarness({
        extractionMode: "llm",
        extractionDecisions: [{ action: "NOOP", reason: "one-off", confidence: 1 }],
      });
      const result = await harness.service.maybeExtractMemoryFromConversation(
        defaultCtx(),
        "I prefer short answers btw",
        "Got it.",
      );
      const count = await harness.service.count();
      stored = result.stored;
      policyRejected = !result.stored && result.reason === "one-off" && count === 0;
      if (result.stored) reasons.push("LLM NOOP unexpectedly stored memory");
      if (result.reason !== "one-off") reasons.push(`expected NOOP reason to win, got: ${result.reason}`);
      if (count !== 0) reasons.push("LLM NOOP changed the memory store");
      break;
    }
    case "memory:case:llm-extraction-policy-guard": {
      const harness = makeHarness({
        extractionMode: "llm",
        extractionDecisions: [
          { action: "ADD", content: "my password: hunter2", confidence: 0.99, reason: "bad extractor candidate" },
        ],
      });
      const result = await harness.service.maybeExtractMemoryFromConversation(
        defaultCtx(),
        "remember my password: hunter2",
        "I cannot store that.",
      );
      const count = await harness.service.count();
      stored = result.stored;
      policyRejected = !result.stored && count === 0 && harness.learnedItems().length === 0;
      if (result.stored) reasons.push("LLM-extracted secret-like memory was stored");
      if (!/secret|credential/i.test(result.reason)) reasons.push(`expected policy rejection reason, got: ${result.reason}`);
      if (count !== 0) reasons.push("memory store changed after LLM-extracted secret rejection");
      if (harness.learnedItems().length !== 0) reasons.push("LLM-extracted secret created a learned item");
      break;
    }
    default:
      reasons.push(`no evaluator for case ${item.id}`);
  }

  return {
    id: item.id,
    kind: item.kind,
    passed: reasons.length === 0,
    stored,
    recalled,
    isolated,
    forgetPassed,
    policyRejected,
    learnedItemCaptured,
    latencyMs: Date.now() - started,
    reasons,
  };
}

function makeHarness(options: { extractionMode?: MemoryExtractionMode; extractionDecisions?: MemoryExtractionDecision[] } = {}): {
  service: MemoryService;
  learnedItems: () => LearnedItem[];
} {
  const registry = new LiveLearningRegistry({
    now: () => "2026-06-18T22:00:00.000Z",
    idFactory: (() => {
      let next = 0;
      return () => `learned-memory-${++next}`;
    })(),
  });
  const service = new MemoryService(new InMemoryMemoryStore(), new HashingEmbeddingProvider(), logger, {
    learning: {
      createLearnedItem: async (input) => registry.recordLearnedItem(input),
    },
    extractionMode: options.extractionMode ?? "heuristic",
    ...(options.extractionDecisions ? { extractor: fixedExtractor(options.extractionDecisions) } : {}),
  });
  return { service, learnedItems: () => registry.listLearnedItems() };
}

function fixedExtractor(decisions: MemoryExtractionDecision[]): MemoryExtractor {
  return {
    async extract() {
      return decisions;
    },
  };
}

async function hasRecall(
  service: MemoryService,
  query: string,
  ctx: { userId: string; guildId: string | null; channelId: string },
  expectedContent: string,
): Promise<boolean> {
  const hits = await service.search(query, ctx, 5);
  return hits.some((hit) => hit.content.includes(expectedContent));
}

function matchingLearnedItem(
  items: LearnedItem[],
  expected: { content: string; source: string; canTrain: boolean },
): LearnedItem | null {
  return (
    items.find(
      (item) =>
        item.kind === "memory" &&
        item.content.includes(expected.content) &&
        item.source === expected.source &&
        item.accessPaths.includes("memory_rag") &&
        item.retention.canRetrieve === true &&
        item.retention.canTrain === expected.canTrain,
    ) ?? null
  );
}

function memoryInput(
  content: string,
  options: Partial<Pick<RememberInput, "explicit" | "scope" | "guildId" | "channelId">>,
): RememberInput {
  const scope = options.scope ?? "USER";
  return {
    content,
    scope,
    userId: scope === "USER" ? "user-alpha" : null,
    guildId: options.guildId ?? "guild-alpha",
    channelId: options.channelId ?? "channel-alpha",
    explicit: options.explicit,
  };
}

function defaultCtx(): { userId: string; guildId: string | null; channelId: string } {
  return { userId: "user-alpha", guildId: "guild-alpha", channelId: "channel-alpha" };
}

function evalCase(
  id: string,
  kind: MemoryContinuityCaseKind,
  description: string,
): MemoryContinuityEvalCase {
  return { id, kind, description, metadata: {} };
}

const storedExpectedKinds = new Set<MemoryContinuityCaseKind>([
  "explicit_recall",
  "implicit_capture",
  "scope_isolation",
  "forget",
  "learning_capture",
]);

const recallExpectedKinds = new Set<MemoryContinuityCaseKind>([
  "explicit_recall",
  "implicit_capture",
  "scope_isolation",
  "learning_capture",
]);

function latencyStats(values: number[]): EvalLatencyStats {
  if (values.length === 0) return { count: 0, average: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: sorted.length,
    average: Number((sum / sorted.length).toFixed(3)),
    p95: Number((sorted[p95Index] ?? 0).toFixed(3)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(6));
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
