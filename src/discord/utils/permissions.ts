import type { GuildMember } from "discord.js";

/**
 * discord.js v14 exposes permissions as PascalCase strings
 * ("ModerateMembers"); tools declare them UPPER_SNAKE ("MODERATE_MEMBERS").
 * Everything downstream uses UPPER_SNAKE.
 */
export function toUpperSnake(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

/** Normalized permission names for a guild member (empty for DMs). */
export function memberPermissionNames(member: GuildMember | null): string[] {
  if (!member) return [];
  return permissionNames(member.permissions);
}

export function permissionNames(permissions: { toArray(): string[] } | null | undefined): string[] {
  if (!permissions) return [];
  return permissions.toArray().map(toUpperSnake);
}
