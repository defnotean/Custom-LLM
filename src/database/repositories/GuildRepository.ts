import type { PrismaClient } from "@prisma/client";
import type { JsonValue } from "../../types/common";

export interface GuildSettings {
  /** Channels where the bot may converse without being mentioned (TODO: enforcement). */
  allowChannels?: string[];
  /** Per-guild disabled tool names (TODO: enforcement in ToolRouter/Executor). */
  disabledTools?: string[];
  [key: string]: JsonValue | undefined;
}

export class GuildRepository {
  private readonly settingsCache = new Map<string, { value: GuildSettings; expires: number }>();

  constructor(private readonly prisma: PrismaClient) {}

  async ensure(discordGuildId: string, name: string): Promise<void> {
    await this.prisma.guildProfile.upsert({
      where: { discordGuildId },
      create: { discordGuildId, name },
      update: { name },
    });
  }

  /** Settings with a 60s in-process cache (avoids a DB hit per message). */
  async getSettings(discordGuildId: string): Promise<GuildSettings> {
    const cached = this.settingsCache.get(discordGuildId);
    if (cached && cached.expires > Date.now()) return cached.value;

    const row = await this.prisma.guildProfile.findUnique({ where: { discordGuildId } });
    const value = (row?.settingsJson ?? {}) as GuildSettings;
    this.settingsCache.set(discordGuildId, { value, expires: Date.now() + 60_000 });
    return value;
  }

  async updateSettings(discordGuildId: string, settings: GuildSettings): Promise<void> {
    await this.prisma.guildProfile.update({
      where: { discordGuildId },
      data: { settingsJson: settings as object },
    });
    this.settingsCache.delete(discordGuildId);
  }

  async count(): Promise<number> {
    return this.prisma.guildProfile.count();
  }
}
