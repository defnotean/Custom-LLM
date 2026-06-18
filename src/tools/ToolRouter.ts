import type { Logger } from "pino";
import type { EmbeddingProvider } from "../memory/EmbeddingProvider";
import { toErrorMessage } from "../utils/errors";
import { cosineSimilarity } from "../utils/vectorMath";
import { describeArgsSchema } from "./schemaIntrospect";
import type { RegisteredTool } from "./ToolDefinition";
import type { ToolRegistry } from "./ToolRegistry";

/**
 * Tool candidate retrieval. With 400+ tools, putting everything in the
 * prompt collapses selection accuracy, so we retrieve a small, relevant
 * candidate set and only show those to the model.
 *
 * Default implementation: deterministic keyword/category/example scoring.
 * Scalable implementation: embedding retrieval over tool search documents,
 * blended with keyword signals and a safe keyword fallback. The agent layer
 * depends only on ToolRetrievalStrategy.
 */

export interface ToolRoutingInput {
  message: string;
  guildId: string | null;
  memberPermissions: readonly string[];
  recentSummary?: string;
  maxTools?: number;
}

export interface ToolRoutingResult {
  likelyNeedsTool: boolean;
  candidateTools: RegisteredTool[];
  reasoning: string;
  confidence: number;
}

export interface ToolRetrievalStrategy {
  retrieve(input: ToolRoutingInput): Promise<ToolRoutingResult>;
}

interface KeywordRoutingContext {
  tokens: string[];
  tokenSet: Set<string>;
  lowered: string;
  hasActionHint: boolean;
  hasToolAbstainHint: boolean;
}

interface ScoredTool {
  tool: RegisteredTool;
  score: number;
  why: string[];
  similarity?: number;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "be",
  "to",
  "of",
  "and",
  "or",
  "in",
  "on",
  "for",
  "it",
  "this",
  "that",
  "me",
  "my",
  "you",
  "your",
  "i",
  "we",
  "do",
  "does",
  "can",
  "could",
  "would",
  "should",
  "please",
  "with",
  "at",
]);

/** Verbs/nouns that strongly suggest an action rather than chat. */
const ACTION_HINTS = [
  "timeout",
  "ban",
  "kick",
  "mute",
  "warn",
  "delete",
  "remove",
  "purge",
  "remember",
  "recall",
  "forget",
  "memory",
  "note",
  "send",
  "post",
  "dm",
  "announce",
  "summarize",
  "summary",
  "stats",
  "info",
  "lookup",
  "check",
  "ping",
  "time",
  "server",
  "channel",
  "user",
  "remind",
];

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  moderation: ["timeout", "ban", "kick", "mute", "warn", "delete", "mod", "moderate", "punish", "report", "spam"],
  utility: ["ping", "time", "date", "info", "server", "channel", "status", "latency", "alive"],
  memory: ["remember", "recall", "forget", "memory", "note", "preference", "fact", "know"],
  discord: ["send", "message", "post", "summarize", "stats", "guild", "announce", "channel"],
  example: ["echo", "add", "test"],
};

const TOOL_ABSTAIN_PATTERNS = [
  /\b(?:do\s+not|don't|dont|never)\s+(?:call|use|run|execute|invoke|trigger)\s+(?:any\s+)?(?:tool|tools|tool_call|toolcall|function|functions)\b/,
  /\bwithout\s+(?:calling|using|running|executing|invoking|triggering)\s+(?:any\s+)?(?:tool|tools|tool_call|toolcall|function|functions)\b/,
  /\bno\s+(?:tool|tools|tool_call|toolcall|function|functions)\b/,
  /\bnot\s+actually\s+(?:call|use|run|execute|invoke|trigger)\b/,
  /\b(?:pasted|fake|example|quoted)\s+(?:tool|tool_call|toolcall|tool result|tool output|function)\b/,
  /\b(?:tool_result|tool_output)\b/,
  /\b(?:remembered note|memory says|note says|quoted text says)\b.*\b(?:call|run|execute|invoke)\b.*\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/,
];

const TOOL_META_TERM_PATTERN = /\b(?:tool|tools|tool_call|toolcall|function|functions|tool result|tool output)\b/;
const TOOL_IDENTIFIER_PATTERN = /\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/;
const TOOL_DISCUSSION_CUE_PATTERN =
  /\b(?:explain|describe|discuss|quote|repeat|joke|story|analyze|safe|trust|what should|what would|should you|show)\b/;
const TOOL_DISCUSSION_SCOPE_PATTERN = /\b(?:about|what|how|why|word|words|identifier|json|format|output|result)\b/;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export class KeywordToolRetrievalStrategy implements ToolRetrievalStrategy {
  constructor(private readonly registry: ToolRegistry) {}

  async retrieve(input: ToolRoutingInput): Promise<ToolRoutingResult> {
    const maxTools = input.maxTools ?? 10;
    const context = buildKeywordRoutingContext(input);
    if (context.hasToolAbstainHint) {
      return {
        likelyNeedsTool: false,
        candidateTools: [],
        reasoning: "explicit tool-abstain wording detected; treating as plain conversation",
        confidence: 0,
      };
    }

    const scored: ScoredTool[] = [];

    for (const tool of filterPermittedTools(this.registry.listTools(), input.memberPermissions)) {
      const { score, why } = scoreToolKeywords(tool, context);
      if (score > 0) scored.push({ tool, score, why });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, maxTools);
    const topScore = top[0]?.score ?? 0;
    const likelyNeedsTool = topScore >= 3 || (context.hasActionHint && topScore > 0);
    const confidence = Math.max(0, Math.min(1, topScore / 10));

    const reasoning =
      top.length === 0
        ? "no tools matched the message; treating as plain conversation"
        : `top candidates: ${top
            .slice(0, 3)
            .map((s) => `${s.tool.name}(${s.score.toFixed(1)}: ${s.why.join(", ")})`)
            .join("; ")}${context.hasActionHint ? "; action-verb detected" : ""}`;

    return {
      likelyNeedsTool,
      candidateTools: top.map((s) => s.tool),
      reasoning,
      confidence,
    };
  }
}

export interface EmbeddingToolRetrievalOptions {
  fallback?: ToolRetrievalStrategy;
  logger?: Logger;
  /** Minimum cosine similarity that can independently trigger tool routing. */
  minSimilarity?: number;
  embeddingWeight?: number;
  keywordWeight?: number;
  batchSize?: number;
}

interface IndexedTool {
  tool: RegisteredTool;
  document: string;
  embedding: number[];
}

/**
 * Embedding retrieval for large tool registries. It embeds one stable search
 * document per tool, embeds each incoming user request, ranks by cosine
 * similarity, then blends in the existing keyword signal. If the embedding
 * provider is unavailable, it trips a process-local circuit breaker and falls
 * back to keyword routing for the rest of the process.
 */
export class EmbeddingToolRetrievalStrategy implements ToolRetrievalStrategy {
  private readonly fallback: ToolRetrievalStrategy;
  private readonly logger: Logger | undefined;
  private readonly minSimilarity: number;
  private readonly embeddingWeight: number;
  private readonly keywordWeight: number;
  private readonly batchSize: number;
  private indexPromise: Promise<IndexedTool[]> | null = null;
  private disabledReason: string | null = null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly embeddings: EmbeddingProvider,
    options?: EmbeddingToolRetrievalOptions,
  ) {
    this.fallback = options?.fallback ?? new KeywordToolRetrievalStrategy(registry);
    this.logger = options?.logger;
    this.minSimilarity = options?.minSimilarity ?? 0.22;
    this.embeddingWeight = options?.embeddingWeight ?? 8;
    this.keywordWeight = options?.keywordWeight ?? 0.4;
    this.batchSize = options?.batchSize ?? 64;
  }

  async retrieve(input: ToolRoutingInput): Promise<ToolRoutingResult> {
    if (this.disabledReason) {
      return this.fallback.retrieve(input);
    }

    try {
      const context = buildKeywordRoutingContext(input);
      if (context.hasToolAbstainHint) {
        return {
          likelyNeedsTool: false,
          candidateTools: [],
          reasoning: "explicit tool-abstain wording detected; treating as plain conversation",
          confidence: 0,
        };
      }

      const queryText = `${input.message}\n${input.recentSummary ?? ""}`.trim();
      const [queryEmbedding] = await this.embeddings.embed([queryText]);
      if (!queryEmbedding) return this.fallback.retrieve(input);

      const permitted = new Set(
        filterPermittedTools(this.registry.listTools(), input.memberPermissions).map((tool) => tool.name),
      );
      const index = await this.getIndex();
      const scored: ScoredTool[] = [];

      for (const item of index) {
        if (!permitted.has(item.tool.name)) continue;
        const similarity = cosineSimilarity(queryEmbedding, item.embedding);
        const keyword = scoreToolKeywords(item.tool, context);
        const score = similarity * this.embeddingWeight + Math.min(keyword.score, 8) * this.keywordWeight;
        if (score <= 0) continue;

        const why: string[] = [];
        if (similarity >= this.minSimilarity) why.push(`embedding ${similarity.toFixed(3)}`);
        why.push(...keyword.why);
        scored.push({
          tool: item.tool,
          score,
          why: why.length > 0 ? why : [`embedding ${similarity.toFixed(3)}`],
          similarity,
        });
      }

      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, input.maxTools ?? 10);
      const topSimilarity = top[0]?.similarity ?? 0;
      const topKeywordScore = top[0] ? scoreToolKeywords(top[0].tool, context).score : 0;
      const keywordLikely = topKeywordScore >= 3 || (context.hasActionHint && topKeywordScore > 0);
      const semanticLikely =
        topSimilarity >= this.minSimilarity * 1.25 ||
        (topSimilarity >= this.minSimilarity && (context.hasActionHint || topKeywordScore > 0));
      const likelyNeedsTool = keywordLikely || semanticLikely;
      const confidence = Math.max(
        0,
        Math.min(1, Math.max(topSimilarity / (this.minSimilarity * 2), topKeywordScore / 10)),
      );
      const candidateSummary = top
        .slice(0, 3)
        .map((item) => `${item.tool.name}(${item.score.toFixed(2)}: ${item.why.join(", ")})`)
        .join("; ");

      return {
        likelyNeedsTool,
        candidateTools: likelyNeedsTool ? top.map((item) => item.tool) : [],
        reasoning:
          top.length === 0
            ? "embedding router found no permitted tools; treating as plain conversation"
            : likelyNeedsTool
              ? `embedding candidates via ${this.embeddings.name}: ${candidateSummary}${context.hasActionHint ? "; action-verb detected" : ""}`
              : `embedding candidates via ${this.embeddings.name} below routing threshold: ${candidateSummary}; treating as plain conversation`,
        confidence,
      };
    } catch (err) {
      this.disabledReason = toErrorMessage(err);
      this.logger?.warn(
        { err: this.disabledReason, embeddings: this.embeddings.name },
        "embedding tool retrieval failed; falling back to keyword routing",
      );
      return this.fallback.retrieve(input);
    }
  }

  private async getIndex(): Promise<IndexedTool[]> {
    this.indexPromise ??= this.buildIndex();
    return this.indexPromise;
  }

  private async buildIndex(): Promise<IndexedTool[]> {
    const tools = this.registry.listTools();
    const documents = tools.map((tool) => toolSearchDocument(tool));
    const vectors: number[][] = [];
    for (let start = 0; start < documents.length; start += this.batchSize) {
      vectors.push(...(await this.embeddings.embed(documents.slice(start, start + this.batchSize))));
    }
    return tools.flatMap((tool, index) => {
      const embedding = vectors[index];
      return embedding ? [{ tool, document: documents[index] ?? "", embedding }] : [];
    });
  }
}

export class ToolRouter {
  private readonly strategy: ToolRetrievalStrategy;
  private readonly logger: Logger | undefined;

  constructor(registry: ToolRegistry, options?: { strategy?: ToolRetrievalStrategy; logger?: Logger }) {
    this.strategy = options?.strategy ?? new KeywordToolRetrievalStrategy(registry);
    this.logger = options?.logger;
  }

  async route(input: ToolRoutingInput): Promise<ToolRoutingResult> {
    const result = await this.strategy.retrieve(input);
    this.logger?.debug(
      {
        likelyNeedsTool: result.likelyNeedsTool,
        candidates: result.candidateTools.map((t) => t.name),
        confidence: result.confidence,
      },
      "tool routing",
    );
    return result;
  }
}

function buildKeywordRoutingContext(input: ToolRoutingInput): KeywordRoutingContext {
  const text = `${input.message} ${input.recentSummary ?? ""}`;
  const tokens = tokenize(text);
  const tokenSet = new Set(tokens);
  const lowered = input.message.toLowerCase();
  return {
    tokens,
    tokenSet,
    lowered,
    hasActionHint: ACTION_HINTS.some((hint) => tokenSet.has(hint)),
    hasToolAbstainHint: hasToolAbstainHint(lowered),
  };
}

function hasToolAbstainHint(loweredMessage: string): boolean {
  if (TOOL_ABSTAIN_PATTERNS.some((pattern) => pattern.test(loweredMessage))) return true;
  const mentionsToolSurface = TOOL_META_TERM_PATTERN.test(loweredMessage) || TOOL_IDENTIFIER_PATTERN.test(loweredMessage);
  return (
    mentionsToolSurface &&
    TOOL_DISCUSSION_CUE_PATTERN.test(loweredMessage) &&
    TOOL_DISCUSSION_SCOPE_PATTERN.test(loweredMessage)
  );
}

function filterPermittedTools(
  tools: RegisteredTool[],
  memberPermissions: readonly string[],
): RegisteredTool[] {
  const held = new Set(memberPermissions.map((p) => p.toUpperCase()));
  const isAdmin = held.has("ADMINISTRATOR");
  return tools.filter((tool) => {
    // Permission pre-filter: do not offer tools the member cannot run.
    const required = tool.requiredDiscordPermissions ?? [];
    return isAdmin || required.every((p) => held.has(p.toUpperCase()));
  });
}

function scoreToolKeywords(tool: RegisteredTool, context: KeywordRoutingContext): { score: number; why: string[] } {
  let score = 0;
  const why: string[] = [];

  if (context.lowered.includes(tool.name)) {
    score += 6;
    why.push("name mentioned");
  }
  const nameParts = tool.name.split("_");
  const nameHits = nameParts.filter((part) => context.tokenSet.has(part)).length;
  if (nameHits > 0) {
    score += nameHits * 2;
    why.push(`name tokens x${nameHits}`);
  }

  const catWords = CATEGORY_KEYWORDS[tool.category] ?? [];
  const catHits = catWords.filter((word) => context.tokenSet.has(word)).length;
  if (catHits > 0) {
    score += catHits * 1.5;
    why.push(`category keywords x${catHits}`);
  }

  const descTokens = new Set(tokenize(tool.description));
  const descHits = context.tokens.filter((token) => descTokens.has(token)).length;
  if (descHits > 0) {
    score += descHits;
    why.push(`description overlap x${descHits}`);
  }

  let exampleHits = 0;
  for (const example of tool.examples ?? []) {
    const exTokens = new Set(tokenize(example));
    exampleHits += context.tokens.filter((token) => exTokens.has(token)).length > 1 ? 1 : 0;
  }
  if (exampleHits > 0) {
    score += exampleHits * 1.5;
    why.push(`example match x${exampleHits}`);
  }

  return { score, why };
}

function toolSearchDocument(tool: RegisteredTool): string {
  const args = describeArgsSchema(tool.argsSchema);
  return [
    `tool name: ${tool.name}`,
    `category: ${tool.category}`,
    `description: ${tool.description}`,
    `examples: ${(tool.examples ?? []).join(" | ")}`,
    `arguments: ${Object.entries(args)
      .map(([name, shape]) => `${name}: ${shape}`)
      .join("; ")}`,
    `risk: ${tool.riskLevel}`,
    tool.requiresConfirmation ? "requires user confirmation before execution" : "does not require confirmation",
    (tool.requiredDiscordPermissions ?? []).length > 0
      ? `required Discord permissions: ${(tool.requiredDiscordPermissions ?? []).join(", ")}`
      : "no member permission required",
  ].join("\n");
}
