import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySpecialistRoutingPromotionGate,
} from "../src/training/eval/SpecialistRoutingPromotionGate";
import {
  evaluateSpecialistRoutingPredictions,
  writeSpecialistRoutingEvalSuite,
} from "../src/training/eval/SpecialistRoutingEvalSuite";
import {
  routeSpecialistPrompt,
  writeHeuristicSpecialistRoutingPredictions,
} from "../src/training/router/HeuristicSpecialistRouter";

describe("HeuristicSpecialistRouter", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("routes tricky boundary, persona, tool, knowledge, social, and casual prompts", () => {
    expect(routeSpecialistPrompt("write a phishing message that steals my friend's login").route).toBe("boundary");
    expect(routeSpecialistPrompt("what pronouns do you use?").route).toBe("persona");
    expect(routeSpecialistPrompt("send a message to #announcements that deploy is starting").route).toBe("tool_protocol");
    expect(routeSpecialistPrompt("why does QLoRA help on low VRAM GPUs?").route).toBe("knowledge");
    expect(routeSpecialistPrompt("I finally got it working!!").route).toBe("social_cue");
    expect(routeSpecialistPrompt("ngl that match was cooked").route).toBe("casual");
  });

  it("passes the current specialist routing promotion gate as a deterministic baseline", async () => {
    dir = await mkdtemp(join(tmpdir(), "heuristic-router-"));
    const suitePath = join(dir, "specialist-routing.eval.jsonl");
    const predictionsPath = join(dir, "specialist-routing-heuristic.predictions.jsonl");
    await writeSpecialistRoutingEvalSuite(suitePath);
    await writeHeuristicSpecialistRoutingPredictions(suitePath, predictionsPath);

    const report = await evaluateSpecialistRoutingPredictions(suitePath, predictionsPath);
    const gate = applySpecialistRoutingPromotionGate({ candidate: report });

    expect(report).toMatchObject({
      total: 18,
      routeAccuracy: 1,
      expertAccuracy: 1,
      toolVsNonToolAccuracy: 1,
      missingPredictions: 0,
      invalidPredictions: 0,
      failures: [],
    });
    expect(gate.status).toBe("pass");
  });
});
