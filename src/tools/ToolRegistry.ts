import type { JsonValue } from "../types/common";
import { describeArgsSchema } from "./schemaIntrospect";
import type { RegisteredTool, ToolRiskLevel } from "./ToolDefinition";

export interface ToolMetadata {
  name: string;
  category: string;
  description: string;
  examples: string[];
  riskLevel: ToolRiskLevel;
  requiresConfirmation: boolean;
  requiredDiscordPermissions: string[];
  cooldownSeconds: number;
  enabled: boolean;
  argsShape: Record<string, string>;
}

export type ToolCallValidation =
  | { ok: true; tool: RegisteredTool; args: unknown }
  | { ok: false; error: string; tool?: RegisteredTool };

const NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Central tool registry. Designed for 400+ tools: O(1) lookup, category
 * indexes, keyword search, and prompt-rendering for a *subset* of tools
 * (never the whole registry — see ToolRouter).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly byCategory = new Map<string, RegisteredTool[]>();

  registerTool(tool: RegisteredTool): void {
    if (!NAME_PATTERN.test(tool.name)) {
      throw new Error(
        `Tool name "${tool.name}" must be snake_case ([a-z][a-z0-9_]{1,63})`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    const list = this.byCategory.get(tool.category) ?? [];
    list.push(tool);
    this.byCategory.set(tool.category, list);
  }

  registerAll(tools: RegisteredTool[]): void {
    for (const tool of tools) this.registerTool(tool);
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  listTools(options?: { includeDisabled?: boolean }): RegisteredTool[] {
    const all = [...this.tools.values()];
    if (options?.includeDisabled) return all;
    return all.filter((t) => t.enabled !== false);
  }

  listByCategory(category: string): RegisteredTool[] {
    return (this.byCategory.get(category) ?? []).filter((t) => t.enabled !== false);
  }

  categories(): string[] {
    return [...this.byCategory.keys()].sort();
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * Simple keyword search over name/description/examples/category.
   * The ToolRouter layers smarter scoring on top; this is the registry-level
   * primitive (also exposed via API + !ai tools).
   */
  searchTools(query: string, options?: { limit?: number }): RegisteredTool[] {
    const limit = options?.limit ?? 10;
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 1);
    if (terms.length === 0) return [];

    const scored = this.listTools().map((tool) => {
      const haystack = [
        tool.name,
        tool.category,
        tool.description,
        ...(tool.examples ?? []),
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (tool.name === term) score += 5;
        else if (tool.name.includes(term)) score += 3;
        if (haystack.includes(term)) score += 1;
      }
      return { tool, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.tool);
  }

  /**
   * Render the prompt section for a *given subset* of tools. Intentionally
   * takes the subset as input: callers must route first. Rendering the whole
   * registry into a prompt is the #1 anti-pattern at 400+ tools.
   */
  getToolDescriptionsForPrompt(tools: RegisteredTool[]): string {
    return tools
      .map((tool, i) => {
        const args = describeArgsSchema(tool.argsSchema);
        const lines = [
          `${i + 1}. ${tool.name}`,
          `Description: ${tool.description}`,
          `Arguments schema: ${JSON.stringify(args)}`,
          `Risk: ${tool.riskLevel}`,
        ];
        if (tool.requiresConfirmation) lines.push("Requires confirmation: true");
        if (tool.requiredDiscordPermissions && tool.requiredDiscordPermissions.length > 0) {
          lines.push(`Required permissions: ${tool.requiredDiscordPermissions.join(", ")}`);
        }
        return lines.join("\n");
      })
      .join("\n\n");
  }

  exportToolMetadata(): ToolMetadata[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      category: tool.category,
      description: tool.description,
      examples: tool.examples ?? [],
      riskLevel: tool.riskLevel,
      requiresConfirmation: tool.requiresConfirmation,
      requiredDiscordPermissions: tool.requiredDiscordPermissions ?? [],
      cooldownSeconds: tool.cooldownSeconds ?? 0,
      enabled: tool.enabled !== false,
      argsShape: describeArgsSchema(tool.argsSchema),
    }));
  }

  /**
   * Validate a (possibly model-generated) tool call. This is the only path
   * by which raw arguments become typed arguments — the executor refuses
   * anything that didn't pass through here.
   */
  validateToolCall(name: string, rawArgs: unknown): ToolCallValidation {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool "${name}"` };
    }
    if (tool.enabled === false) {
      return { ok: false, error: `Tool "${name}" is disabled`, tool };
    }
    const parsed = tool.argsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const detail = issue
        ? `${issue.path.join(".") || "args"}: ${issue.message}`
        : "invalid arguments";
      return { ok: false, error: `Invalid arguments for "${name}" — ${detail}`, tool };
    }
    const args: unknown = parsed.data as unknown;
    return { ok: true, tool, args };
  }

  /** JSON-safe metadata dump (API, seed script). */
  toJSON(): JsonValue {
    return this.exportToolMetadata() as unknown as JsonValue;
  }
}
