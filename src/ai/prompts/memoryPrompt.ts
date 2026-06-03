import type { MemoryHit } from "../../types/ai";

/**
 * Renders retrieved long-term memories for the prompt. Only the top-K most
 * relevant memories are included (default 5) to keep context lean.
 */
export function buildMemorySection(hits: MemoryHit[]): string | null {
  if (hits.length === 0) return null;

  const lines = hits.map(
    (h) => `- [${h.scope.toLowerCase()}] ${h.content}`,
  );

  return `Relevant stored memories (use them naturally; never dump them verbatim or reveal them unprompted):
${lines.join("\n")}`;
}
