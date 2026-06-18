import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  evaluateSpecialistRoutingPredictions,
  makeSpecialistRoutingOraclePredictions,
  writeSpecialistRoutingEvalSuite,
} from "../src/training/eval/SpecialistRoutingEvalSuite";

describe("SpecialistRoutingEvalSuite", () => {
  it("builds and scores oracle router predictions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "router-eval-"));
    const suitePath = join(dir, "specialist-routing.eval.jsonl");
    const predictionsPath = join(dir, "oracle.predictions.jsonl");

    const summary = await writeSpecialistRoutingEvalSuite(suitePath);
    const oracle = await makeSpecialistRoutingOraclePredictions(suitePath, predictionsPath);
    const report = await evaluateSpecialistRoutingPredictions(suitePath, predictionsPath);

    expect(summary.cases).toBe(18);
    expect(summary.byRoute.tool_protocol).toBe(3);
    expect(summary.byRoute.knowledge).toBe(3);
    expect(oracle.predictions).toBe(18);
    expect(report.routeAccuracy).toBe(1);
    expect(report.expertAccuracy).toBe(1);
    expect(report.toolVsNonToolAccuracy).toBe(1);
    expect(report.failures).toEqual([]);
  });

  it("flags wrong, invalid, and missing specialist routes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "router-eval-"));
    const suitePath = join(dir, "specialist-routing.eval.jsonl");
    const predictionsPath = join(dir, "bad.predictions.jsonl");
    await writeSpecialistRoutingEvalSuite(suitePath);
    const cases = (await readFile(suitePath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { id: string; route: string });

    await writeFile(
      predictionsPath,
      [
        JSON.stringify({ id: cases[0]?.id, route: "knowledge" }),
        JSON.stringify({ id: cases[1]?.id, output: "{\"route\":\"not_real\"}" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const report = await evaluateSpecialistRoutingPredictions(suitePath, predictionsPath);
    expect(report.routeAccuracy).toBeLessThan(1);
    expect(report.invalidPredictions).toBe(1);
    expect(report.missingPredictions).toBe(16);
    expect(report.failures.some((failure) => failure.reason.includes("wrong route"))).toBe(true);
  });
});
