import type { LearnedItem } from "./LiveLearningRegistry";
import type { SkillHint } from "../types/ai";

export interface SkillItemSource {
  listLearnedItems(filter?: {
    kind?: "skill";
    reviewStatus?: "approved";
    limit?: number;
  }): Promise<LearnedItem[]>;
}

export class SkillRetrievalService {
  constructor(
    private readonly source: SkillItemSource,
    private readonly options: { candidatePoolLimit?: number } = {},
  ) {}

  async retrieve(input: { query: string; candidateToolNames?: string[]; topK?: number }): Promise<SkillHint[]> {
    const topK = input.topK ?? 3;
    if (topK <= 0) return [];

    const items = await this.source.listLearnedItems({
      kind: "skill",
      reviewStatus: "approved",
      limit: this.options.candidatePoolLimit ?? 50,
    });
    const queryTerms = terms([input.query, ...(input.candidateToolNames ?? [])].join(" "));
    const candidateTools = new Set(input.candidateToolNames ?? []);

    return items
      .filter((item) => item.reviewStatus === "approved")
      .filter((item) => item.retention.canRetrieve)
      .filter((item) => item.accessPaths.includes("skill_registry"))
      .map((item) => toScoredHint(item, queryTerms, candidateTools))
      .filter((hint) => hint.score > 0)
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.id.localeCompare(b.id))
      .slice(0, topK);
  }
}

function toScoredHint(item: LearnedItem, queryTerms: Set<string>, candidateTools: Set<string>): SkillHint {
  const toolName = typeof item.metadata.toolName === "string" ? item.metadata.toolName : undefined;
  const contentTerms = terms([item.content, item.source, toolName ?? ""].join(" "));
  let relevance = 0;
  for (const term of queryTerms) {
    if (contentTerms.has(term)) relevance += 1;
  }
  if (toolName && candidateTools.has(toolName)) relevance += 3;
  const score = relevance > 0 ? relevance + item.confidence : 0;

  return {
    id: item.id,
    content: compactSkillContent(item.content),
    source: item.source,
    confidence: item.confidence,
    score,
    ...(toolName ? { toolName } : {}),
  };
}

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 3),
  );
}

function compactSkillContent(content: string): string {
  const normalized = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
  return normalized.length <= 700 ? normalized : `${normalized.slice(0, 697)}...`;
}
