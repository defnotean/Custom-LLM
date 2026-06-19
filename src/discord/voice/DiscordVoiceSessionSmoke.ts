import type { Logger } from "pino";

export type DiscordVoiceSessionSmokeStatus = "pass" | "fail";
export type DiscordVoicePermissionName = "ViewChannel" | "Connect" | "Speak" | "UseVAD";

export interface DiscordVoiceSessionSmokeCheck {
  id: string;
  status: DiscordVoiceSessionSmokeStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface DiscordVoiceSessionSmokeReport {
  status: DiscordVoiceSessionSmokeStatus;
  generatedAt: string;
  checks: DiscordVoiceSessionSmokeCheck[];
  summary: {
    guildId: string;
    voiceChannelId: string;
    executeJoin: boolean;
    readyTimeoutMs: number;
    botUserId?: string;
    checkedPermissions: DiscordVoicePermissionName[];
  };
}

export interface DiscordVoiceSessionSmokeClient {
  login(token: string): Promise<void>;
  destroy(): Promise<void> | void;
  getSelfUserId(): string | null;
  fetchGuild(guildId: string): Promise<{ id: string; name?: string | null } | null>;
  fetchSelfMember(guildId: string, userId: string): Promise<{ id: string; displayName?: string | null } | null>;
  fetchVoiceChannel(
    guildId: string,
    channelId: string,
    botUserId: string,
  ): Promise<DiscordVoiceSessionSmokeChannel | null>;
}

export interface DiscordVoiceSessionSmokeChannel {
  id: string;
  name?: string | null;
  kind: "voice" | "stage" | "other";
  joinable?: boolean;
  speakable?: boolean;
  viewable?: boolean;
  full?: boolean;
  adapterCreator?: unknown;
  permissionsFor(userId: string): DiscordVoicePermissionSet | null;
}

export interface DiscordVoicePermissionSet {
  has(permission: DiscordVoicePermissionName): boolean;
}

export interface DiscordVoiceSessionConnector {
  join(input: {
    guildId: string;
    channelId: string;
    readyTimeoutMs: number;
    adapterCreator?: unknown;
    channel: DiscordVoiceSessionSmokeChannel;
  }): Promise<void>;
}

export interface DiscordVoiceSessionSmokeOptions {
  token: string;
  guildId: string;
  voiceChannelId: string;
  client: DiscordVoiceSessionSmokeClient;
  connector?: DiscordVoiceSessionConnector | null;
  executeJoin?: boolean;
  readyTimeoutMs?: number;
  logger?: Logger;
  now?: () => Date;
}

const REQUIRED_VOICE_PERMISSIONS: DiscordVoicePermissionName[] = ["ViewChannel", "Connect", "Speak", "UseVAD"];
const DEFAULT_READY_TIMEOUT_MS = 10_000;

export async function runDiscordVoiceSessionSmoke(
  options: DiscordVoiceSessionSmokeOptions,
): Promise<DiscordVoiceSessionSmokeReport> {
  const checks: DiscordVoiceSessionSmokeCheck[] = [];
  const executeJoin = options.executeJoin ?? false;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const summary: DiscordVoiceSessionSmokeReport["summary"] = {
    guildId: options.guildId,
    voiceChannelId: options.voiceChannelId,
    executeJoin,
    readyTimeoutMs,
    checkedPermissions: REQUIRED_VOICE_PERMISSIONS,
  };

  const missingConfig = missingConfigKeys(options);
  if (missingConfig.length > 0) {
    checks.push(fail("discord-voice-session-config", "Discord voice session smoke is missing required config", { missingConfig }));
    return report(options, checks, summary);
  }
  checks.push(pass("discord-voice-session-config", "Discord voice session smoke config is present"));

  let botUserId: string | null = null;
  try {
    await options.client.login(options.token);
    botUserId = options.client.getSelfUserId();
    if (!botUserId) {
      checks.push(fail("discord-login", "Discord login succeeded but bot user id was unavailable"));
      return report(options, checks, summary);
    }
    checks.push(pass("discord-login", "Discord bot login succeeded", { botUserId }));
  } catch (err) {
    checks.push(fail("discord-login", `Discord bot login failed: ${errorMessage(err)}`));
    return report(options, checks, summary);
  } finally {
    summary.botUserId = botUserId ?? undefined;
  }

  try {
    const guild = await options.client.fetchGuild(options.guildId);
    if (!guild) {
      checks.push(fail("discord-guild", "Configured Discord guild was not found or is unavailable"));
      return report(options, checks, summary);
    }
    checks.push(pass("discord-guild", "Configured Discord guild is reachable", { guildId: guild.id, name: guild.name ?? null }));

    const selfMember = await options.client.fetchSelfMember(options.guildId, botUserId);
    if (!selfMember) {
      checks.push(fail("discord-bot-member", "Bot member record is unavailable in the configured guild"));
      return report(options, checks, summary);
    }
    checks.push(pass("discord-bot-member", "Bot member record is reachable", { displayName: selfMember.displayName ?? null }));

    const channel = await options.client.fetchVoiceChannel(options.guildId, options.voiceChannelId, botUserId);
    if (!channel) {
      checks.push(fail("discord-voice-channel", "Configured Discord voice channel was not found"));
      return report(options, checks, summary);
    }
    checks.push(
      channel.kind === "voice" || channel.kind === "stage"
        ? pass("discord-voice-channel", "Configured channel is a Discord voice-capable channel", {
            channelId: channel.id,
            name: channel.name ?? null,
            kind: channel.kind,
          })
        : fail("discord-voice-channel", "Configured channel is not voice-capable", { kind: channel.kind }),
    );
    checkChannelBooleans(checks, channel);
    checkPermissions(checks, channel, botUserId);

    if (executeJoin) {
      await checkJoin(options, checks, channel, readyTimeoutMs);
    } else {
      checks.push(pass("discord-voice-join", "Join execution skipped; preflight checks only", { executeJoin: false }));
    }
  } finally {
    await Promise.resolve(options.client.destroy());
  }

  options.logger?.info({ checks: checks.length, executeJoin }, "discord voice session smoke complete");
  return report(options, checks, summary);
}

function checkChannelBooleans(checks: DiscordVoiceSessionSmokeCheck[], channel: DiscordVoiceSessionSmokeChannel): void {
  if (channel.viewable === false) checks.push(fail("discord-voice-channel-viewable", "Bot cannot view the voice channel"));
  else checks.push(pass("discord-voice-channel-viewable", "Bot can view the voice channel"));

  if (channel.joinable === false) checks.push(fail("discord-voice-channel-joinable", "Bot cannot join the voice channel"));
  else checks.push(pass("discord-voice-channel-joinable", "Bot can join the voice channel"));

  if (channel.speakable === false) checks.push(fail("discord-voice-channel-speakable", "Bot cannot speak in the voice channel"));
  else checks.push(pass("discord-voice-channel-speakable", "Bot can speak in the voice channel"));

  if (channel.full === true) checks.push(fail("discord-voice-channel-capacity", "Voice channel is full"));
  else checks.push(pass("discord-voice-channel-capacity", "Voice channel has room for the bot or capacity is not enforced"));
}

function checkPermissions(
  checks: DiscordVoiceSessionSmokeCheck[],
  channel: DiscordVoiceSessionSmokeChannel,
  botUserId: string,
): void {
  const permissions = channel.permissionsFor(botUserId);
  if (!permissions) {
    checks.push(fail("discord-voice-permissions", "Unable to resolve bot permissions for the voice channel"));
    return;
  }

  const missing = REQUIRED_VOICE_PERMISSIONS.filter((permission) => !permissions.has(permission));
  if (missing.length > 0) {
    checks.push(fail("discord-voice-permissions", "Bot is missing required voice permissions", { missing }));
    return;
  }
  checks.push(pass("discord-voice-permissions", "Bot has required voice permissions", { permissions: REQUIRED_VOICE_PERMISSIONS }));
}

async function checkJoin(
  options: DiscordVoiceSessionSmokeOptions,
  checks: DiscordVoiceSessionSmokeCheck[],
  channel: DiscordVoiceSessionSmokeChannel,
  readyTimeoutMs: number,
): Promise<void> {
  const preJoinFailed = checks.some((check) => check.status === "fail");
  if (preJoinFailed) {
    checks.push(fail("discord-voice-join", "Join execution skipped because preflight checks failed"));
    return;
  }
  if (!options.connector) {
    checks.push(fail("discord-voice-join", "Join execution requested but no voice connector is configured"));
    return;
  }

  await recordCheck(checks, "discord-voice-join", async () => {
    await options.connector!.join({
      guildId: options.guildId,
      channelId: options.voiceChannelId,
      readyTimeoutMs,
      adapterCreator: channel.adapterCreator,
      channel,
    });
    return { summary: "Discord voice join/ready/leave smoke succeeded", details: { readyTimeoutMs } };
  });
}

async function recordCheck(
  checks: DiscordVoiceSessionSmokeCheck[],
  id: string,
  run: () => Promise<{ summary: string; details?: Record<string, unknown> }>,
): Promise<void> {
  try {
    const result = await run();
    checks.push(pass(id, result.summary, result.details));
  } catch (err) {
    checks.push(fail(id, errorMessage(err)));
  }
}

function missingConfigKeys(options: DiscordVoiceSessionSmokeOptions): string[] {
  const missing: string[] = [];
  if (!options.token.trim()) missing.push("DISCORD_TOKEN");
  if (!options.guildId.trim()) missing.push("guildId");
  if (!options.voiceChannelId.trim()) missing.push("voiceChannelId");
  return missing;
}

function report(
  options: Pick<DiscordVoiceSessionSmokeOptions, "now">,
  checks: DiscordVoiceSessionSmokeCheck[],
  summary: DiscordVoiceSessionSmokeReport["summary"],
): DiscordVoiceSessionSmokeReport {
  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    checks,
    summary,
  };
}

function pass(id: string, summary: string, details?: Record<string, unknown>): DiscordVoiceSessionSmokeCheck {
  return { id, status: "pass", summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): DiscordVoiceSessionSmokeCheck {
  return { id, status: "fail", summary, ...(details ? { details } : {}) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
