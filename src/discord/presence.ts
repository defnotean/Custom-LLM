import { ActivityType, type Client, type PresenceData, type PresenceStatusData } from "discord.js";
import type { Logger } from "pino";

export const DISCORD_PRESENCE_ACTIVITY_TYPES = ["Playing", "Listening", "Watching", "Competing", "Custom"] as const;

export type DiscordPresenceActivityType = (typeof DISCORD_PRESENCE_ACTIVITY_TYPES)[number];

export interface DiscordPresenceOptions {
  status: PresenceStatusData;
  activityType: DiscordPresenceActivityType;
  activityName: string;
}

export interface VoiceListeningPresenceInput {
  guildId: string;
  channelId: string;
}

export interface VoiceListeningPresenceIndicatorOptions {
  client: Client;
  basePresence: DiscordPresenceOptions;
  logger?: Logger;
}

const activityTypeByName: Record<DiscordPresenceActivityType, ActivityType> = {
  Playing: ActivityType.Playing,
  Listening: ActivityType.Listening,
  Watching: ActivityType.Watching,
  Competing: ActivityType.Competing,
  Custom: ActivityType.Custom,
};

export function buildPresenceData(options: DiscordPresenceOptions): PresenceData {
  const activityName = options.activityName.trim();
  return {
    status: options.status,
    activities: activityName
      ? [
          options.activityType === "Custom"
            ? {
                name: "Custom Status",
                state: activityName,
                type: activityTypeByName[options.activityType],
              }
            : {
                name: activityName,
                type: activityTypeByName[options.activityType],
              },
        ]
      : [],
  };
}

export function buildVoiceListeningPresenceData(base: DiscordPresenceOptions, activeGuilds: number): PresenceData {
  return buildPresenceData({
    status: base.status,
    activityType: "Listening",
    activityName: formatVoiceListeningActivity(activeGuilds),
  });
}

export function applyDiscordPresence(
  client: Client,
  options: DiscordPresenceOptions,
  logger?: Logger,
): PresenceData | null {
  if (!client.user) return null;
  const presence = buildPresenceData(options);
  client.user.setPresence(presence);
  logger?.info(
    {
      status: presence.status,
      activityType: options.activityType,
      activityName: options.activityName,
    },
    "discord presence configured",
  );
  return presence;
}

export class VoiceListeningPresenceIndicator {
  private readonly active = new Map<string, VoiceListeningPresenceInput>();

  constructor(private readonly options: VoiceListeningPresenceIndicatorOptions) {}

  showListening(input: VoiceListeningPresenceInput): PresenceData | null {
    this.active.set(input.guildId, input);
    return this.apply();
  }

  clearListening(guildId: string): PresenceData | null {
    this.active.delete(guildId);
    return this.apply();
  }

  activeCount(): number {
    return this.active.size;
  }

  private apply(): PresenceData | null {
    if (!this.options.client.user) return null;
    if (this.active.size === 0) {
      return applyDiscordPresence(this.options.client, this.options.basePresence, this.options.logger);
    }

    const presence = buildVoiceListeningPresenceData(this.options.basePresence, this.active.size);
    this.options.client.user.setPresence(presence);
    this.options.logger?.info(
      { activeVoiceGuilds: this.active.size, activityName: presence.activities?.[0]?.name },
      "discord voice listening presence configured",
    );
    return presence;
  }
}

function formatVoiceListeningActivity(activeGuilds: number): string {
  const count = Math.max(1, activeGuilds);
  return `to opt-in voice in ${count} ${count === 1 ? "server" : "servers"}`;
}
