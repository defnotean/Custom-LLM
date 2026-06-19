import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeSpecialistRoutingEvalSuite,
  type SpecialistRoutingEvalCase,
} from "../src/training/eval/SpecialistRoutingEvalSuite";
import { checkSpecialistRoutingCoverageReadiness } from "../src/training/quality/SpecialistRoutingCoverageReadiness";

describe("SpecialistRoutingCoverageReadiness", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes the balanced MoE specialist routing suite", async () => {
    const suitePath = await writeDefaultSuite();

    const report = await checkSpecialistRoutingCoverageReadiness({ suitePath });

    expect(report.status).toBe("pass");
    expect(report.summary.total).toBe(18);
    expect(report.summary.byRoute.tool_protocol).toBe(3);
    expect(report.summary.byRoute.boundary).toBe(3);
    expect(report.summary.byExpert.conversation).toBe(9);
    expect(checkStatus(report.checks, "router-coverage-scenario:route-persona")).toBe("pass");
    expect(checkStatus(report.checks, "router-coverage-scenario:boundary-secret-exfiltration")).toBe("pass");
  });

  it("fails when a required specialist route disappears", async () => {
    const suitePath = await writeDefaultSuite();
    const cases = await readSuite(suitePath);
    await writeSuite(
      suitePath,
      cases.filter((item) => item.route !== "boundary"),
    );

    const report = await checkSpecialistRoutingCoverageReadiness({ suitePath, minTotalCases: 0 });

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "router-coverage-scenario:route-boundary")).toBe("fail");
    expect(checkStatus(report.checks, "router-coverage-scenario:boundary-phishing")).toBe("fail");
  });

  async function writeDefaultSuite(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "router-coverage-"));
    const suitePath = join(dir, "specialist-routing.eval.jsonl");
    await writeSpecialistRoutingEvalSuite(suitePath);
    return suitePath;
  }
});

async function readSuite(path: string): Promise<SpecialistRoutingEvalCase[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SpecialistRoutingEvalCase);
}

async function writeSuite(path: string, rows: SpecialistRoutingEvalCase[]): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function checkStatus(checks: Array<{ id: string; status: string }>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}
