import type { LearnedItem } from "./LiveLearningRegistry";
import type { SkillHint } from "../types/ai";
import {
  expertForRoute,
  isSpecialistRoute,
  normalizeSpecialistRoute,
  type SpecialistExpert,
  type SpecialistRoute,
} from "../ai/routing/SpecialistRoutingContract";

export interface SkillRetrievalInput {
  query: string;
  candidateToolNames?: string[];
  specialistRoute?: SpecialistRoute | string;
  specialistExpert?: SpecialistExpert | string;
  topK?: number;
}

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

  async retrieve(input: SkillRetrievalInput): Promise<SkillHint[]> {
    const topK = input.topK ?? 3;
    if (topK <= 0) return [];

    const items = await this.source.listLearnedItems({
      kind: "skill",
      reviewStatus: "approved",
      limit: this.options.candidatePoolLimit ?? 50,
    });
    const queryTerms = terms(
      [input.query, ...(input.candidateToolNames ?? []), input.specialistRoute ?? "", input.specialistExpert ?? ""].join(
        " ",
      ),
    );
    const candidateTools = new Set(input.candidateToolNames ?? []);
    const routeContext = normalizeOptional(input.specialistRoute);
    const expertContext = normalizeOptional(input.specialistExpert);

    return items
      .filter((item) => item.reviewStatus === "approved")
      .filter((item) => item.retention.canRetrieve)
      .filter((item) => item.accessPaths.includes("skill_registry"))
      .filter((item) => candidateTools.size === 0 || !toolNameFor(item) || candidateTools.has(toolNameFor(item) ?? ""))
      .map((item) => toScoredHint(item, queryTerms, candidateTools, { routeContext, expertContext }))
      .filter((hint) => hint.score > 0)
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.id.localeCompare(b.id))
      .slice(0, topK);
  }
}

function toScoredHint(
  item: LearnedItem,
  queryTerms: Set<string>,
  candidateTools: Set<string>,
  routing: { routeContext?: string; expertContext?: string },
): SkillHint {
  const toolName = toolNameFor(item);
  const itemRoute = routeFor(item);
  const itemExpert = specialistExpertFor(item);
  const contentTerms = terms([item.content, item.source, toolName ?? "", itemRoute ?? "", itemExpert ?? ""].join(" "));
  let relevance = 0;
  for (const term of queryTerms) {
    if (contentTerms.has(term)) relevance += 1;
  }
  if (toolName && candidateTools.has(toolName)) relevance += 3;
  if (routing.routeContext && itemRoute === routing.routeContext) relevance += 3;
  if (routing.expertContext && itemExpert === routing.expertContext) relevance += 1;
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

function toolNameFor(item: LearnedItem): string | undefined {
  return typeof item.metadata.toolName === "string" ? item.metadata.toolName : undefined;
}

function routeFor(item: LearnedItem): string | undefined {
  const route =
    typeof item.metadata.specialistRoute === "string"
      ? item.metadata.specialistRoute
      : typeof item.metadata.route === "string"
        ? item.metadata.route
        : undefined;
  return normalizeOptional(route);
}

function specialistExpertFor(item: LearnedItem): string | undefined {
  const metadataExpert =
    typeof item.metadata.specialistExpert === "string"
      ? item.metadata.specialistExpert
      : typeof item.metadata.expert === "string"
        ? item.metadata.expert
        : undefined;
  if (metadataExpert) return normalizeOptional(metadataExpert);

  const route = routeFor(item);
  return route && isSpecialistRoute(route) ? expertForRoute(route) : undefined;
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeSpecialistRoute(value);
  return normalized.length > 0 ? normalized : undefined;
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
