import { ActivityType, type Client, type PresenceData, type PresenceStatusData } from "discord.js";
import type { Logger } from "pino";

export const DISCORD_PRESENCE_ACTIVITY_TYPES = ["Playing", "Listening", "Watching", "Competing", "Custom"] as const;

export type DiscordPresenceActivityType = (typeof DISCORD_PRESENCE_ACTIVITY_TYPES)[number];

export interface DiscordPresenceOptions {
  status: PresenceStatusData;
  activityType: DiscordPresenceActivityType;
  activityName: string;
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
