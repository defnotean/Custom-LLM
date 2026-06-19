import {
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, type Guild, type GuildBasedChannel } from "discord.js";
import pino from "pino";
import { env } from "../src/config/env";
import {
  runDiscordVoiceSessionSmoke,
  type DiscordVoicePermissionName,
  type DiscordVoiceSessionConnector,
  type DiscordVoiceSessionSmokeChannel,
  type DiscordVoiceSessionSmokeClient,
} from "../src/discord/voice/DiscordVoiceSessionSmoke";

interface CliOptions {
  token: string;
  guildId: string;
  voiceChannelId: string;
  executeJoin: boolean;
  readyTimeoutMs: number;
}

const PERMISSION_BITS: Record<DiscordVoicePermissionName, bigint> = {
  ViewChannel: PermissionFlagsBits.ViewChannel,
  Connect: PermissionFlagsBits.Connect,
  Speak: PermissionFlagsBits.Speak,
  UseVAD: PermissionFlagsBits.UseVAD,
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
  });

  const report = await runDiscordVoiceSessionSmoke({
    token: options.token,
    guildId: options.guildId,
    voiceChannelId: options.voiceChannelId,
    client: new DiscordJsVoiceSessionSmokeClient(client),
    connector: options.executeJoin ? new DiscordJsVoiceSessionConnector() : null,
    executeJoin: options.executeJoin,
    readyTimeoutMs: options.readyTimeoutMs,
    logger,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));

  if (report.status !== "pass") {
    const failures = report.checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.id}: ${check.summary}`)
      .join("; ");
    throw new Error(`Discord voice session smoke failed: ${failures}`);
  }
}

class DiscordJsVoiceSessionSmokeClient implements DiscordVoiceSessionSmokeClient {
  constructor(private readonly client: Client) {}

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }

  destroy(): void {
    this.client.destroy();
  }

  getSelfUserId(): string | null {
    return this.client.user?.id ?? null;
  }

  async fetchGuild(guildId: string): Promise<{ id: string; name?: string | null } | null> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;
    return { id: guild.id, name: guild.name };
  }

  async fetchSelfMember(guildId: string, userId: string): Promise<{ id: string; displayName?: string | null } | null> {
    const guild = await this.fetchRealGuild(guildId);
    if (!guild) return null;
    const member = guild.members.me ?? (await guild.members.fetch(userId).catch(() => null));
    if (!member) return null;
    return { id: member.id, displayName: member.displayName };
  }

  async fetchVoiceChannel(
    guildId: string,
    channelId: string,
    botUserId: string,
  ): Promise<DiscordVoiceSessionSmokeChannel | null> {
    const guild = await this.fetchRealGuild(guildId);
    if (!guild) return null;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return null;
    return adaptChannel(guild, channel, botUserId);
  }

  private async fetchRealGuild(guildId: string): Promise<Guild | null> {
    return await this.client.guilds.fetch(guildId).catch(() => null);
  }
}

class DiscordJsVoiceSessionConnector implements DiscordVoiceSessionConnector {
  async join(input: {
    guildId: string;
    channelId: string;
    readyTimeoutMs: number;
    adapterCreator?: unknown;
  }): Promise<void> {
    if (!input.adapterCreator) throw new Error("voice adapter creator is unavailable for the configured guild");
    const connection = joinVoiceChannel({
      guildId: input.guildId,
      channelId: input.channelId,
      adapterCreator: input.adapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, input.readyTimeoutMs);
    } finally {
      connection.destroy();
    }
  }
}

function adaptChannel(
  guild: Guild,
  channel: GuildBasedChannel,
  botUserId: string,
): DiscordVoiceSessionSmokeChannel {
  const permissions = "permissionsFor" in channel ? channel.permissionsFor(botUserId) : null;
  return {
    id: channel.id,
    name: readString(channel, "name") ?? channel.id,
    kind: mapKind(channel.type),
    viewable: readBoolean(channel, "viewable"),
    joinable: readBoolean(channel, "joinable"),
    speakable: readBoolean(channel, "speakable"),
    full: readBoolean(channel, "full"),
    adapterCreator: guild.voiceAdapterCreator,
    permissionsFor: () =>
      permissions
        ? {
            has: (permission) => permissions.has(PERMISSION_BITS[permission]),
          }
        : null,
  };
}

function mapKind(type: ChannelType): DiscordVoiceSessionSmokeChannel["kind"] {
  if (type === ChannelType.GuildVoice) return "voice";
  if (type === ChannelType.GuildStageVoice) return "stage";
  return "other";
}

function readBoolean(value: object, key: string): boolean | undefined {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function readString(value: object, key: string): string | undefined {
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    token: env.DISCORD_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    voiceChannelId: process.env.DISCORD_VOICE_CHANNEL_ID ?? "",
    executeJoin: false,
    readyTimeoutMs: 10_000,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--token") options.token = requireValue(argv[++index], arg);
    else if (arg === "--guild-id") options.guildId = requireValue(argv[++index], arg);
    else if (arg === "--voice-channel-id") options.voiceChannelId = requireValue(argv[++index], arg);
    else if (arg === "--execute-join") options.executeJoin = true;
    else if (arg === "--ready-timeout-ms") options.readyTimeoutMs = parsePositiveInt(argv[++index], arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(requireValue(value, flag));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
