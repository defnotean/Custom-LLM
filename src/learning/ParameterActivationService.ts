import type { LearnedItem, ParameterModule } from "./LiveLearningRegistry";
import type { ParameterModuleHint } from "../types/ai";
import {
  expertForRoute,
  isSpecialistRoute,
  normalizeSpecialistRoute,
  type SpecialistExpert,
  type SpecialistRoute,
} from "../ai/routing/SpecialistRoutingContract";

export interface ParameterActivationInput {
  query: string;
  candidateToolNames?: string[];
  specialistRoute?: SpecialistRoute | string;
  specialistExpert?: SpecialistExpert | string;
  topK?: number;
}

export interface ParameterModuleSource {
  listParameterModules(filter?: {
    status?: "active";
    limit?: number;
  }): Promise<ParameterModule[]>;
  getLearnedItem(id: string): Promise<LearnedItem | null>;
}

export class ParameterActivationService {
  constructor(
    private readonly source: ParameterModuleSource,
    private readonly options: { candidatePoolLimit?: number; sourcePreviewLimit?: number } = {},
  ) {}

  async retrieve(input: ParameterActivationInput): Promise<ParameterModuleHint[]> {
    const topK = input.topK ?? 3;
    if (topK <= 0) return [];

    const modules = await this.source.listParameterModules({
      status: "active",
      limit: this.options.candidatePoolLimit ?? 50,
    });
    const sourceCache = new Map<string, LearnedItem | null>();
    const queryTerms = terms(
      [input.query, ...(input.candidateToolNames ?? []), input.specialistRoute ?? "", input.specialistExpert ?? ""].join(
        " ",
      ),
    );
    const candidateTools = new Set(input.candidateToolNames ?? []);
    const routeContext = normalizeOptional(input.specialistRoute);
    const expertContext = normalizeOptional(input.specialistExpert);

    const hints = await Promise.all(
      modules
        .filter((module) => module.status === "active")
        .filter((module) => module.kind !== "base_model")
        .map(async (module) =>
          this.toScoredHint(module, queryTerms, candidateTools, { routeContext, expertContext }, sourceCache),
        ),
    );

    return hints
      .filter((hint) => hint.score > 0)
      .sort((a, b) => b.score - a.score || b.activeParameters - a.activeParameters || a.id.localeCompare(b.id))
      .slice(0, topK);
  }

  private async toScoredHint(
    module: ParameterModule,
    queryTerms: Set<string>,
    candidateTools: Set<string>,
    routing: { routeContext?: string; expertContext?: string },
    sourceCache: Map<string, LearnedItem | null>,
  ): Promise<ParameterModuleHint> {
    const sourceItems = await this.loadSourceItems(module.sourceLearningItemIds, sourceCache);
    const retrievableSourceItems = sourceItems.filter((item) => item.retention.canRetrieve);
    const sourceSummaries = retrievableSourceItems
      .slice(0, this.options.sourcePreviewLimit ?? 3)
      .map((item) => compactSourceContent(item.content));
    const moduleTerms = terms(
      [
        module.name,
        module.kind,
        module.route ?? "",
        metadataText(module.metadata),
        retrievableSourceItems.map((item) => item.content).join(" "),
      ].join(" "),
    );

    let relevance = 0;
    for (const term of queryTerms) {
      if (moduleTerms.has(term)) relevance += 1;
    }
    if (module.route && candidateTools.has(module.route)) relevance += 3;
    const toolName = typeof module.metadata.toolName === "string" ? module.metadata.toolName : undefined;
    if (toolName && candidateTools.has(toolName)) relevance += 3;
    const moduleRoute = normalizeOptional(module.route);
    if (routing.routeContext && moduleRoute === routing.routeContext) relevance += 4;
    const moduleExpert = specialistExpertFor(module);
    if (routing.expertContext && moduleExpert === routing.expertContext) relevance += 1;

    return {
      id: module.id,
      name: module.name,
      kind: module.kind,
      parameters: module.parameters,
      activeParameters: module.activeParameters,
      score: relevance > 0 ? relevance + Math.log10(module.activeParameters + 1) / 10 : 0,
      ...(module.route ? { route: module.route } : {}),
      sourceLearningItemIds: [...module.sourceLearningItemIds],
      sourceSummaries,
    };
  }

  private async loadSourceItems(
    ids: string[],
    cache: Map<string, LearnedItem | null>,
  ): Promise<LearnedItem[]> {
    const items: LearnedItem[] = [];
    for (const id of ids) {
      if (!cache.has(id)) cache.set(id, await this.source.getLearnedItem(id));
      const item = cache.get(id);
      if (item) items.push(item);
    }
    return items;
  }
}

function specialistExpertFor(module: ParameterModule): string | undefined {
  const metadataExpert =
    typeof module.metadata.specialistExpert === "string"
      ? module.metadata.specialistExpert
      : typeof module.metadata.expert === "string"
        ? module.metadata.expert
        : undefined;
  if (metadataExpert) return normalizeOptional(metadataExpert);

  if (!module.route) return undefined;
  const normalizedRoute = normalizeSpecialistRoute(module.route);
  return isSpecialistRoute(normalizedRoute) ? expertForRoute(normalizedRoute) : undefined;
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

function metadataText(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const item of Object.values(value)) {
    if (typeof item === "string") parts.push(item);
    if (Array.isArray(item)) parts.push(item.filter((entry) => typeof entry === "string").join(" "));
  }
  return parts.join(" ");
}

function compactSourceContent(content: string): string {
  const normalized = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
