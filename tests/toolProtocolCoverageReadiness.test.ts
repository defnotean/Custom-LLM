import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolRegistry } from "../src/tools";
import { buildToolEvalCases, type ToolEvalCase } from "../src/training/eval/ToolEvalSuite";
import { checkToolProtocolCoverageReadiness } from "../src/training/quality/ToolProtocolCoverageReadiness";

describe("ToolProtocolCoverageReadiness", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes when the tool suite covers the required BFCL-style scenario families", async () => {
    const suitePath = await writeSuite(buildToolEvalCases(buildToolRegistry()));

    const report = await checkToolProtocolCoverageReadiness({ suitePath });

    expect(report.status).toBe("pass");
    expect(report.summary.total).toBeGreaterThanOrEqual(250);
    expect(report.summary.promptInjectionSources).toMatchObject({
      user_json: expect.any(Number),
      pasted_tool_output: expect.any(Number),
      memory_text: expect.any(Number),
      confirmation_bypass: expect.any(Number),
      permission_bypass: expect.any(Number),
    });
    expect(report.summary.toolSurfaceTools).toBeGreaterThanOrEqual(10);
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        "single-tool-call-required-args",
        "missing-required-arg-clarification",
        "permission-denied-refusal",
        "risky-confirmation-request",
        "pending-confirmation-changed-args",
        "prompt-injection-memory-override",
      ]),
    );
  });

  it("fails when prompt-injection families are missing", async () => {
    const cases = buildToolEvalCases(buildToolRegistry()).filter((item) => item.metadata.promptInjection !== true);
    const suitePath = await writeSuite(cases);

    const report = await checkToolProtocolCoverageReadiness({ suitePath, minTotalCases: 0 });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "tool-protocol-scenario:prompt-injection-user-json")).toMatchObject({
      status: "fail",
    });
    expect(report.checks.find((check) => check.id === "tool-protocol-scenario:prompt-injection-memory-override")).toMatchObject({
      status: "fail",
    });
  });

  async function writeSuite(cases: ToolEvalCase[]): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "tool-protocol-coverage-"));
    await mkdir(dir, { recursive: true });
    const suitePath = join(dir, "tool-routing.eval.jsonl");
    await writeFile(suitePath, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    return suitePath;
  }
});
