import type { RegisteredTool } from "./ToolDefinition";

export interface PermissionCheckResult {
  allowed: boolean;
  missing: string[];
}

/**
 * Code-level permission enforcement for tool execution. The model is told
 * about required permissions, but this service is the actual gate — model
 * output is never trusted to self-police.
 */
export class ToolPermissionService {
  /**
   * @param memberPermissions normalized UPPER_SNAKE permission names
   */
  check(tool: RegisteredTool, memberPermissions: readonly string[]): PermissionCheckResult {
    const required = tool.requiredDiscordPermissions ?? [];
    if (required.length === 0) return { allowed: true, missing: [] };

    const held = new Set(memberPermissions.map((p) => p.toUpperCase()));
    if (held.has("ADMINISTRATOR")) return { allowed: true, missing: [] };

    const missing = required.filter((p) => !held.has(p.toUpperCase()));
    return { allowed: missing.length === 0, missing };
  }
}
