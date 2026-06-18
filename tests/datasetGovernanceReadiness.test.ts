import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDatasetGovernanceReadiness } from "../src/training/quality/DatasetGovernanceReadiness";

describe("DatasetGovernanceReadiness", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes when raw, processed, and mixture reports preserve provenance", async () => {
    const fixture = await writeFixture();

    const report = await checkDatasetGovernanceReadiness(fixture.options);

    expect(report.status).toBe("pass");
    expect(checkStatus(report.checks, "raw-dataset-provenance")).toBe("pass");
    expect(checkStatus(report.checks, "processed-source-coverage")).toBe("pass");
    expect(checkStatus(report.checks, "processed-record-provenance")).toBe("pass");
    expect(checkStatus(report.checks, "preference-data-governance")).toBe("warn");
  });

  it("fails when a required raw source has an unapproved license or checksum", async () => {
    const fixture = await writeFixture({
      dollyExpectedSha256: "f".repeat(64),
      dollyLicense: "proprietary",
    });

    const report = await checkDatasetGovernanceReadiness(fixture.options);

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "raw-dataset-provenance")).toBe("fail");
  });

  it("fails when dataset artifacts contain obvious secrets or PII", async () => {
    const fixture = await writeFixture({ includeSecret: true });

    const report = await checkDatasetGovernanceReadiness(fixture.options);

    expect(report.status).toBe("fail");
    expect(checkStatus(report.checks, "dataset-secret-scan")).toBe("fail");
  });

  async function writeFixture(overrides: FixtureOverrides = {}): Promise<{
    options: Parameters<typeof checkDatasetGovernanceReadiness>[0];
  }> {
    dir = await mkdtemp(join(tmpdir(), "dataset-governance-"));
    const rawDir = join(dir, "raw");
    const processedDir = join(dir, "processed");
    const mixtureDir = join(dir, "mixtures");
    const preferenceDir = join(dir, "preferences");
    const sourceDir = join(dir, "source");
    await mkdir(rawDir, { recursive: true });
    await mkdir(processedDir, { recursive: true });
    await mkdir(mixtureDir, { recursive: true });
    await mkdir(preferenceDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });

    const dollyRaw = join(rawDir, "dolly.jsonl");
    const oasstRaw = join(rawDir, "oasst1-ready.jsonl");
    await writeFile(dollyRaw, `${JSON.stringify({ prompt: "hello", response: "hi" })}\n`, "utf8");
    await writeFile(oasstRaw, `${JSON.stringify({ prompt: "status", response: "ready" })}\n`, "utf8");
    const dollyRawReport = await fileReport(dollyRaw);
    const oasstRawReport = await fileReport(oasstRaw);

    const trainPath = join(processedDir, "sft.train.jsonl");
    const validationPath = join(processedDir, "sft.validation.jsonl");
    const allPath = join(processedDir, "sft.all.jsonl");
    const evalSeedPath = join(processedDir, "sft.eval-seed.jsonl");
    const trainRows = [
      chatRecord("dolly-train-1", "dolly", "cc-by-sa-3.0", "train", overrides.includeSecret),
      chatRecord("oasst-train-1", "oasst1_ready", "apache-2.0", "train"),
      chatRecord("dolly-train-2", "dolly", "cc-by-sa-3.0", "train"),
    ];
    const validationRows = [chatRecord("oasst-val-1", "oasst1_ready", "apache-2.0", "validation")];
    const evalSeedRows = [
      chatRecord("dolly-eval-1", "dolly", "cc-by-sa-3.0", "eval_seed"),
      chatRecord("oasst-eval-1", "oasst1_ready", "apache-2.0", "eval_seed"),
    ];
    await writeLines(trainPath, trainRows);
    await writeLines(validationPath, validationRows);
    await writeLines(allPath, [...trainRows, ...validationRows]);
    await writeLines(evalSeedPath, evalSeedRows);

    const rawManifestPath = join(rawDir, "dataset_manifest.json");
    await writeJson(rawManifestPath, {
      generatedAt: "2026-06-18T00:00:00.000Z",
      outDir: rawDir,
      sources: [
        {
          id: "dolly",
          name: "Databricks Dolly",
          url: "https://example.invalid/dolly.jsonl",
          outputFile: "dolly.jsonl",
          license: overrides.dollyLicense ?? "cc-by-sa-3.0",
          homepage: "https://example.invalid/dolly",
          expectedSha256: overrides.dollyExpectedSha256 ?? dollyRawReport.sha256,
          gated: false,
          status: "downloaded",
          path: dollyRaw,
          bytes: dollyRawReport.bytes,
          sha256: dollyRawReport.sha256,
        },
        {
          id: "oasst1_ready",
          name: "OpenAssistant Ready",
          url: "https://example.invalid/oasst.jsonl",
          outputFile: "oasst1-ready.jsonl",
          license: "apache-2.0",
          homepage: "https://example.invalid/oasst",
          expectedSha256: oasstRawReport.sha256,
          gated: false,
          status: "downloaded",
          path: oasstRaw,
          bytes: oasstRawReport.bytes,
          sha256: oasstRawReport.sha256,
        },
        {
          id: "xlam_tool_calling",
          name: "xLAM tool calling",
          url: "https://example.invalid/xlam",
          outputFile: "xlam.jsonl",
          license: "cc-by-4.0",
          homepage: "https://example.invalid/xlam",
          gated: true,
          status: "gated-manual-access",
          path: join(rawDir, "xlam.jsonl"),
        },
      ],
    });

    const processedReportPath = join(processedDir, "dataset_report.json");
    await writeJson(processedReportPath, {
      totalRaw: 6,
      accepted: 4,
      train: 3,
      validation: 1,
      evalSeed: 2,
      evalSeedBySource: { dolly: 1, oasst1_ready: 1 },
      evalSeedSkippedHighOverlap: 0,
      skipped: { "dolly:too-long": 1, "oasst1_ready:duplicate": 1 },
      bySource: {
        dolly: { raw: 3, accepted: 2 },
        oasst1_ready: { raw: 3, accepted: 2 },
      },
      files: [
        await fileReport(trainPath),
        await fileReport(validationPath),
        await fileReport(allPath),
        await fileReport(evalSeedPath),
      ],
    });

    const sftReportPath = join(mixtureDir, "production-sft.report.json");
    await writeJson(sftReportPath, {
      train: 3,
      validation: 1,
      maxSyntheticShare: 0.2,
      syntheticTrainShare: 0.1,
      sources: [
        sourceSummary("open_sft_train", trainPath, "open_sft", true, 4),
        sourceSummary("synthetic_behavior_sft", allPath, "synthetic", false, 1),
      ],
      files: [await fileReport(trainPath), await fileReport(validationPath), await fileReport(allPath)],
    });

    const preferencePath = join(preferenceDir, "production-dpo.train.jsonl");
    await writeLines(preferencePath, [preferenceRecord("pref-1"), preferenceRecord("pref-2")]);
    const preferenceReportPath = join(preferenceDir, "production-dpo.report.json");
    await writeJson(preferenceReportPath, {
      total: 2,
      syntheticOnly: true,
      syntheticShare: 1,
      sources: [sourceSummary("synthetic_tool_preferences", preferencePath, "synthetic", false, 2)],
      files: [await fileReport(preferencePath)],
    });

    const preparerSourcePath = join(sourceDir, "OpenDatasetPreparer.ts");
    await writeFile(
      preparerSourcePath,
      'const secretPatterns = [];\nconst sensitive = "sensitive";\nconst reasons = "too-long too-short duplicate";\nfunction selectBalancedEvalSeed() { return []; }\n',
      "utf8",
    );

    return {
      options: {
        rawManifestPath,
        processedReportPath,
        sftReportPath,
        preferenceReportPath,
        preparerSourcePath,
        minAcceptedRecords: 4,
        minValidationRecords: 1,
        minEvalSeedRecords: 2,
        minEvalSeedSourceShare: 0.25,
      },
    };
  }
});

interface FixtureOverrides {
  dollyExpectedSha256?: string;
  dollyLicense?: string;
  includeSecret?: boolean;
}

function checkStatus(checks: Array<{ id: string; status: string }>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.status;
}

async function writeJson(path: string, body: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

async function writeLines(path: string, rows: string[]): Promise<void> {
  await writeFile(path, `${rows.join("\n")}\n`, "utf8");
}

async function fileReport(path: string): Promise<{ path: string; lines: number; bytes: number; sha256: string }> {
  const body = await readFile(path);
  return {
    path,
    lines: body.toString("utf8").split(/\r?\n/).filter((line) => line.length > 0).length,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function sourceSummary(
  name: string,
  path: string,
  kind: string,
  required: boolean,
  accepted: number,
): Record<string, unknown> {
  return {
    name,
    path,
    required,
    present: true,
    kind,
    raw: accepted,
    accepted,
    skipped: 0,
  };
}

function chatRecord(id: string, source: string, license: string, split: string, includeSecret = false): string {
  const assistant =
    id === "oasst-train-1"
      ? "Here is a minimal route:\n@app.route('/health')\ndef health():\n    return 'ok'"
      : `Answer ${id}`;
  return JSON.stringify({
    messages: [
      { role: "system", content: "You are Irene." },
      { role: "user", content: `Question ${id}` },
      { role: "assistant", content: includeSecret ? "password=supersecret" : assistant },
    ],
    metadata: { id, source, license, split },
  });
}

function preferenceRecord(id: string): string {
  return JSON.stringify({
    prompt: `Prompt ${id}`,
    chosen: `Chosen ${id}`,
    rejected: `Rejected ${id}`,
    metadata: { id, source: "synthetic_tool_preferences" },
  });
}
