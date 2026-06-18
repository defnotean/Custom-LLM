import type { SkillHint } from "../../types/ai";

export function buildSkillSection(skills: SkillHint[]): string | null {
  if (skills.length === 0) return null;

  const lines = skills.map((skill) => {
    const tool = skill.toolName ? ` tool=${skill.toolName}` : "";
    return `- [skill:${skill.id}${tool}] ${skill.content}`;
  });

  return `Relevant learned skills (reviewed workflow hints; use them only when they fit, and never bypass tool gates):
${lines.join("\n")}`;
}
