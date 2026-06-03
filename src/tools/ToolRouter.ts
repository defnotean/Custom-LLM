import type { Logger } from "pino";
import type { RegisteredTool } from "./ToolDefinition";
import type { ToolRegistry } from "./ToolRegistry";

/**
 * Tool candidate retrieval. With 400+ tools, putting everything in the
 * prompt collapses selection accuracy — so we retrieve a small, relevant
 * candidate set (default top 10) and only show those to the model.
 *
 * Current implementation: deterministic keyword/category/example scoring.
 * The ToolRetrievalStrategy interface is the seam for the planned
 * embedding-based retriever (RAG-MCP style: embed tool descriptions, ANN
 * search per query, optional reranker) — swap strategies without touching
 * the agent layer. See docs/TOOL_REGISTRY.md.
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

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "be", "to", "of", "and", "or", "in",
  "on", "for", "it", "this", "that", "me", "my", "you", "your", "i", "we",
  "do", "does", "can", "could", "would", "should", "please", "with", "at",
]);

/** Verbs/nouns that strongly suggest an action rather than chat. */
const ACTION_HINTS = [
  "timeout", "ban", "kick", "mute", "warn", "delete", "remove", "purge",
  "remember", "recall", "forget", "memory", "note",
  "send", "post", "dm", "announce",
  "summarize", "summary", "stats", "info", "lookup", "check",
  "ping", "time", "server", "channel", "user", "remind",
];

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  moderation: ["timeout", "ban", "kick", "mute", "warn", "delete", "mod", "moderate", "punish", "report", "spam"],
  utility: ["ping", "time", "date", "info", "server", "channel", "status", "latency", "alive"],
  memory: ["remember", "recall", "forget", "memory", "note", "preference", "fact", "know"],
  discord: ["send", "message", "post", "summarize", "stats", "guild", "announce", "channel"],
  example: ["echo", "add", "test"],
};

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
    const text = `${input.message} ${input.recentSummary ?? ""}`;
    const tokens = tokenize(text);
    const tokenSet = new Set(tokens);
    const lowered = input.message.toLowerCase();

    const held = new Set(input.memberPermissions.map((p) => p.toUpperCase()));
    const isAdmin = held.has("ADMINISTRATOR");

    const scored: Array<{ tool: RegisteredTool; score: number; why: string[] }> = [];

    for (const tool of this.registry.listTools()) {
      // Permission pre-filter: don't offer tools the member can't run —
      // saves prompt tokens and avoids tempting the model into denied calls.
      const required = tool.requiredDiscordPermissions ?? [];
      if (!isAdmin && required.some((p) => !held.has(p.toUpperCase()))) continue;

      let score = 0;
      const why: string[] = [];

      // Exact / partial tool-name mentions.
      if (lowered.includes(tool.name)) {
        score += 6;
        why.push("name mentioned");
      }
      const nameParts = tool.name.split("_");
      const nameHits = nameParts.filter((p) => tokenSet.has(p)).length;
      if (nameHits > 0) {
        score += nameHits * 2;
        why.push(`name tokens x${nameHits}`);
      }

      // Category keyword affinity.
      const catWords = CATEGORY_KEYWORDS[tool.category] ?? [];
      const catHits = catWords.filter((w) => tokenSet.has(w)).length;
      if (catHits > 0) {
        score += catHits * 1.5;
        why.push(`category keywords x${catHits}`);
      }

      // Description token overlap.
      const descTokens = new Set(tokenize(tool.description));
      const descHits = tokens.filter((t) => descTokens.has(t)).length;
      if (descHits > 0) {
        score += descHits;
        why.push(`description overlap x${descHits}`);
      }

      // Example phrase overlap (examples are written as user-style requests).
      let exampleHits = 0;
      for (const example of tool.examples ?? []) {
        const exTokens = new Set(tokenize(example));
        exampleHits += tokens.filter((t) => exTokens.has(t)).length > 1 ? 1 : 0;
      }
      if (exampleHits > 0) {
        score += exampleHits * 1.5;
        why.push(`example match x${exampleHits}`);
      }

      if (score > 0) scored.push({ tool, score, why });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, maxTools);
    const topScore = top[0]?.score ?? 0;

    const hasActionHint = ACTION_HINTS.some((hint) => tokenSet.has(hint));
    const likelyNeedsTool = topScore >= 3 || (hasActionHint && topScore > 0);
    const confidence = Math.max(0, Math.min(1, topScore / 10));

    const reasoning =
      top.length === 0
        ? "no tools matched the message; treating as plain conversation"
        : `top candidates: ${top
            .slice(0, 3)
            .map((s) => `${s.tool.name}(${s.score.toFixed(1)}: ${s.why.join(", ")})`)
            .join("; ")}${hasActionHint ? "; action-verb detected" : ""}`;

    return {
      likelyNeedsTool,
      candidateTools: top.map((s) => s.tool),
      reasoning,
      confidence,
    };
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
