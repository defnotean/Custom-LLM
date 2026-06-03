import { describe, expect, it, vi, afterEach } from "vitest";
import { ToolCooldownService, InMemoryCooldownStore } from "../src/tools/ToolCooldownService";

describe("ToolCooldownService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first use, blocks within window, reports remaining time", async () => {
    vi.useFakeTimers();
    const service = new ToolCooldownService(new InMemoryCooldownStore());

    expect((await service.check("ping", "u1")).allowed).toBe(true);
    await service.markUsed("ping", "u1", 10);

    const blocked = await service.check("ping", "u1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remainingMs).toBeGreaterThan(8000);
    expect(blocked.remainingMs).toBeLessThanOrEqual(10000);
  });

  it("expires after the window", async () => {
    vi.useFakeTimers();
    const service = new ToolCooldownService(new InMemoryCooldownStore());
    await service.markUsed("ping", "u1", 10);
    vi.advanceTimersByTime(10_001);
    expect((await service.check("ping", "u1")).allowed).toBe(true);
  });

  it("is scoped per user and per tool", async () => {
    const service = new ToolCooldownService(new InMemoryCooldownStore());
    await service.markUsed("ping", "u1", 60);
    expect((await service.check("ping", "u2")).allowed).toBe(true);
    expect((await service.check("echo", "u1")).allowed).toBe(true);
    expect((await service.check("ping", "u1")).allowed).toBe(false);
  });

  it("zero cooldown means no cooldown", async () => {
    const service = new ToolCooldownService(new InMemoryCooldownStore());
    await service.markUsed("ping", "u1", 0);
    expect((await service.check("ping", "u1")).allowed).toBe(true);
  });
});
