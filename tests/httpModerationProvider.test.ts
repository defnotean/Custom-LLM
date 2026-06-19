import { describe, expect, it } from "vitest";
import {
  HttpModerationProvider,
  normalizeModerationResponse,
  type ModerationFetchLike,
} from "../src/safety/ModerationProvider";

describe("HttpModerationProvider", () => {
  it("posts message context with bearer auth and normalizes action decisions", async () => {
    let captured:
      | {
          url: string;
          init: Parameters<ModerationFetchLike>[1];
        }
      | undefined;
    const fetchImpl: ModerationFetchLike = async (url, init) => {
      captured = { url, init };
      return jsonResponse({ action: "block", reason: "policy hit", labels: ["S1"] });
    };
    const provider = new HttpModerationProvider({
      endpointUrl: "http://127.0.0.1:8080/moderate",
      apiKey: "secret",
      fetchImpl,
    });

    const decision = await provider.check({
      userId: "u1",
      guildId: null,
      channelId: "c1",
      content: "hello",
    });

    expect(decision.action).toBe("block");
    expect(decision.reason).toBe("policy hit");
    expect(decision.labels).toEqual(["S1"]);
    expect(captured?.url).toBe("http://127.0.0.1:8080/moderate");
    expect(captured?.init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(captured?.init.body ?? "{}")).toEqual({
      userId: "u1",
      guildId: null,
      channelId: "c1",
      content: "hello",
    });
  });

  it.each([
    [{ blocked: true, categories: ["S2"], message: "blocked" }, "block", ["S2"]],
    [{ safe: false, category: "S3", explanation: "unsafe" }, "block", ["S3"]],
    [{ safe: true, labels: ["clean"] }, "allow", ["clean"]],
    [{ flagged: false }, "allow", undefined],
  ])("normalizes provider response %#", (body, action, labels) => {
    const decision = normalizeModerationResponse(body);

    expect(decision.action).toBe(action);
    expect(decision.labels).toEqual(labels);
  });

  it("throws on provider transport failure", async () => {
    const provider = new HttpModerationProvider({
      endpointUrl: "http://127.0.0.1:8080/moderate",
      fetchImpl: async () => jsonResponse({ error: "down" }, { ok: false, status: 503, statusText: "Unavailable" }),
    });

    await expect(
      provider.check({
        userId: "u1",
        guildId: "g1",
        channelId: "c1",
        content: "hello",
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("throws on malformed provider JSON", async () => {
    const provider = new HttpModerationProvider({
      endpointUrl: "http://127.0.0.1:8080/moderate",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return "{";
        },
      }),
    });

    await expect(
      provider.check({
        userId: "u1",
        guildId: "g1",
        channelId: "c1",
        content: "hello",
      }),
    ).rejects.toThrow(/invalid JSON/);
  });
});

function jsonResponse(
  body: unknown,
  overrides?: Partial<{ ok: boolean; status: number; statusText: string }>,
): Awaited<ReturnType<ModerationFetchLike>> {
  return {
    ok: overrides?.ok ?? true,
    status: overrides?.status ?? 200,
    statusText: overrides?.statusText ?? "OK",
    async text() {
      return JSON.stringify(body);
    },
  };
}
