export type ModerationProviderAction = "allow" | "block";

export interface ModerationProviderInput {
  userId: string;
  guildId: string | null;
  channelId: string;
  content: string;
}

export interface ModerationProviderDecision {
  action: ModerationProviderAction;
  reason?: string;
  labels?: string[];
  raw?: unknown;
}

export interface ModerationProvider {
  check(input: ModerationProviderInput): Promise<ModerationProviderDecision>;
}

export interface HttpModerationProviderOptions {
  endpointUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: ModerationFetchLike;
}

export type ModerationFetchLike = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

/**
 * Private HTTP moderation hook for public Discord deployments.
 *
 * Contract: POST JSON {content, userId, guildId, channelId}. The endpoint may
 * return any of:
 *   {action:"allow"|"block", reason?, labels?}
 *   {blocked:boolean, reason?, labels?/categories?}
 *   {safe:boolean, reason?, labels?/categories?}
 */
export class HttpModerationProvider implements ModerationProvider {
  private readonly endpointUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: ModerationFetchLike;

  constructor(options: HttpModerationProviderOptions) {
    this.endpointUrl = options.endpointUrl;
    this.apiKey = options.apiKey || undefined;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async check(input: ModerationProviderInput): Promise<ModerationProviderDecision> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const response = await this.fetchImpl(this.endpointUrl, {
        method: "POST",
        headers,
        body: `${JSON.stringify(input)}\n`,
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new Error(`moderation endpoint returned HTTP ${response.status} ${response.statusText}`);
      }
      return normalizeModerationResponse(parseModerationBody(bodyText));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function normalizeModerationResponse(raw: unknown): ModerationProviderDecision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("moderation endpoint returned a non-object JSON payload");
  }

  const body = raw as Record<string, unknown>;
  const labels = readLabels(body);
  const reason = readString(body.reason) ?? readString(body.message) ?? readString(body.explanation);
  const action = normalizeAction(body);
  if (!action) {
    throw new Error("moderation endpoint JSON did not include action, blocked, or safe");
  }

  return {
    action,
    ...(reason ? { reason } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    raw,
  };
}

function parseModerationBody(bodyText: string): unknown {
  if (bodyText.trim().length === 0) {
    throw new Error("moderation endpoint returned an empty body");
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch (err) {
    throw new Error("moderation endpoint returned invalid JSON", { cause: err });
  }
}

function normalizeAction(body: Record<string, unknown>): ModerationProviderAction | null {
  const action = readString(body.action)?.toLowerCase();
  if (action === "allow" || action === "allowed" || action === "safe") return "allow";
  if (action === "block" || action === "blocked" || action === "deny" || action === "unsafe") return "block";

  if (typeof body.blocked === "boolean") return body.blocked ? "block" : "allow";
  if (typeof body.safe === "boolean") return body.safe ? "allow" : "block";
  if (typeof body.isSafe === "boolean") return body.isSafe ? "allow" : "block";
  if (typeof body.flagged === "boolean") return body.flagged ? "block" : "allow";
  return null;
}

function readLabels(body: Record<string, unknown>): string[] {
  return [
    ...readStringArray(body.labels),
    ...readStringArray(body.categories),
    ...readStringArray(body.category),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

function readStringArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
