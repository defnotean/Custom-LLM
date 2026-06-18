import type { PrismaClient } from "@prisma/client";
import type { JsonValue } from "../../types/common";
import type { GuildVoiceSettings } from "../../discord/voice/VoiceSessionPolicy";

export interface GuildSettings {
  /** Text channels where Irene may respond in this guild. Empty means all channels. */
  allowChannels?: string[];
  /** Per-guild disabled tool names enforced by routing, commands, and execution. */
  disabledTools?: string[];
  /** Opt-in voice policy for join/speak/listen/transcription behavior. */
  voice?: GuildVoiceSettings;
  [key: string]: JsonValue | GuildVoiceSettings | undefined;
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

  async updateSettings(discordGuildId: string, settings: GuildSettings, name?: string): Promise<void> {
    await this.prisma.guildProfile.upsert({
      where: { discordGuildId },
      create: { discordGuildId, name: name ?? discordGuildId, settingsJson: settings as object },
      update: { ...(name ? { name } : {}), settingsJson: settings as object },
    });
    this.settingsCache.delete(discordGuildId);
  }

  async count(): Promise<number> {
    return this.prisma.guildProfile.count();
  }
}
