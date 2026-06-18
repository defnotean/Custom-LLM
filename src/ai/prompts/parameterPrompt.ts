import type { ParameterModuleHint } from "../../types/ai";

export function buildParameterModuleSection(modules: ParameterModuleHint[]): string | null {
  if (modules.length === 0) return null;

  const lines = modules.map((module) => {
    const route = module.route ? ` route=${module.route}` : "";
    const source =
      module.sourceSummaries.length > 0
        ? ` source="${module.sourceSummaries.join(" | ")}"`
        : "";
    return `- [module:${module.id} kind=${module.kind}${route} params=${module.activeParameters}] ${module.name}${source}`;
  });

  return `Active learned parameter modules (promoted growth modules; use their source knowledge when relevant, but never bypass tool gates):
${lines.join("\n")}`;
}
