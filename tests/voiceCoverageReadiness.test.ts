import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeVoiceEvalSuite,
  type VoiceEvalCase,
} from "../src/training/eval/VoiceEvalSuite";
import { checkVoiceCoverageReadiness } from "../src/training/quality/VoiceCoverageReadiness";

describe("VoiceCoverageReadiness", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes the checked-in Discord voice coverage suite", async () => {
    const suitePath = await writeDefaultSuite();

    const report = await checkVoiceCoverageReadiness({ suitePath });

    expect(report.status).toBe("pass");
    expect(report.summary.total).toBe(12);
    expect(report.summary.byKind.retention_policy).toBe(2);
    expect(report.summary.rawAudioRetainedCases).toBe(0);
    expect(report.summary.trainingQueuedCases).toBe(0);
    expect(report.summary.multiSpeakerCases).toBe(1);
    expect(checkStatus(report.checks, "voice-coverage-scenario:crosstalk-active-speaker")).toBe("pass");
    expect(checkStatus(report.checks, "voice-coverage-scenario:training-review-not-auto-queue")).toBe("pass");
  });

  it("fails when retention policy coverage is removed", async () => {
    const suitePath = await writeDefaultSuite();
    const cases = await readSuite(suitePath);
    await writeSuite(
      suitePath,
      cases.filter((item) => item.kind !== "retention_policy"),
    );

    const report = await checkVoiceCoverageReadiness({ suitePath, minTotalCases: 0 });

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "voice-coverage-scenario:retention-policy")).toBe("fail");
  });

  async function writeDefaultSuite(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "voice-coverage-"));
    const suitePath = join(dir, "voice.eval.jsonl");
    await writeVoiceEvalSuite(suitePath);
    return suitePath;
  }
});

async function readSuite(path: string): Promise<VoiceEvalCase[]> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as VoiceEvalCase);
}

async function writeSuite(path: string, rows: VoiceEvalCase[]): Promise<void> {
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function checkStatus(checks: Array<{ id: string; status: string }>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}
