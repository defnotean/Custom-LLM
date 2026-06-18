import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

export type ParameterModuleHotloadQualityStatus = "pass" | "fail";

export interface ParameterModuleHotloadQualityCheck {
  id: string;
  status: ParameterModuleHotloadQualityStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ParameterModuleHotloadQualityReport {
  status: ParameterModuleHotloadQualityStatus;
  manifestPath: string;
  generatedAt: string;
  summary: {
    manifestStatus: string;
    loadRequests: number;
    skippedModules: number;
    artifacts: number;
    totalLoadedParameters: number;
    activeParametersPerRequest: number;
  };
  checks: ParameterModuleHotloadQualityCheck[];
}

const artifactSchema = z.object({
  kind: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative().optional(),
});

const evalReportSchema = z.object({
  kind: z.enum(["protocol", "knowledge", "behavior", "router", "memory", "skill", "voice", "composite"]),
  path: z.string().min(1),
  status: z.enum(["pass", "fail", "warn"]),
  summary: z.string().optional(),
});

const hotloadManifestSchema = z.object({
  id: z.string().min(1),
  generatedAt: z.string().min(1),
  status: z.enum(["ready", "blocked", "empty"]),
  runtimeContract: z.literal("parameter-module-hotload-v1"),
  summary: z.object({
    activeModulesScanned: z.number().int().nonnegative(),
    loadRequests: z.number().int().nonnegative(),
    skippedModules: z.number().int().nonnegative(),
    totalLoadedParameters: z.number().int().nonnegative(),
    activeParametersPerRequest: z.number().int().nonnegative(),
  }),
  requests: z.array(
    z.object({
      action: z.literal("load"),
      moduleId: z.string().min(1),
      name: z.string().min(1),
      kind: z.enum(["adapter", "router", "specialist", "expert", "merged_checkpoint", "ensemble_member"]),
      parameters: z.number().int().positive(),
      activeParameters: z.number().int().positive(),
      trainableParameters: z.number().int().nonnegative(),
      route: z.string().min(1).optional(),
      baseModuleId: z.string().min(1).optional(),
      rollbackTargetId: z.string().min(1),
      stagingManifestPath: z.string().min(1).optional(),
      trainedAt: z.string().min(1).optional(),
      trainer: z.string().min(1).optional(),
      artifacts: z.array(artifactSchema).min(1),
      datasetHashes: z.array(z.string().min(1)).min(1),
      sourceLearningItemIds: z.array(z.string().min(1)).min(1),
      evalReports: z.array(evalReportSchema).min(1),
    }),
  ),
  skipped: z.array(
    z.object({
      moduleId: z.string().min(1),
      name: z.string().min(1),
      kind: z.string().min(1),
      reasons: z.array(z.string().min(1)).min(1),
    }),
  ),
});

type HotloadManifest = z.infer<typeof hotloadManifestSchema>;
type HotloadRequest = HotloadManifest["requests"][number];

export async function checkParameterModuleHotloadManifestQuality(
  manifestPath: string,
): Promise<ParameterModuleHotloadQualityReport> {
  const checks: ParameterModuleHotloadQualityCheck[] = [];
  const manifest = hotloadManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));

  checks.push(...manifestStatusChecks(manifest));
  checks.push(...identityChecks(manifest));
  checks.push(...requestChecks(manifest));
  checks.push(...(await artifactChecks(manifest, manifestPath)));

  return {
    status: checks.some((check) => check.status === "fail") ? "fail" : "pass",
    manifestPath,
    generatedAt: new Date().toISOString(),
    summary: {
      manifestStatus: manifest.status,
      loadRequests: manifest.requests.length,
      skippedModules: manifest.skipped.length,
      artifacts: manifest.requests.reduce((sum, request) => sum + request.artifacts.length, 0),
      totalLoadedParameters: manifest.summary.totalLoadedParameters,
      activeParametersPerRequest: manifest.summary.activeParametersPerRequest,
    },
    checks,
  };
}

function manifestStatusChecks(manifest: HotloadManifest): ParameterModuleHotloadQualityCheck[] {
  const expectedStatus = manifest.skipped.length > 0 ? "blocked" : manifest.requests.length > 0 ? "ready" : "empty";
  return [
    manifest.status === expectedStatus
      ? pass("manifest-status", `Hotload manifest status is ${manifest.status}`)
      : fail("manifest-status", "Hotload manifest status does not match requests/skipped modules", {
          expectedStatus,
          actualStatus: manifest.status,
        }),
    manifest.status === "ready" || manifest.status === "empty"
      ? pass("loader-ready-status", "Hotload manifest is not blocked")
      : fail("loader-ready-status", "Hotload manifest is blocked and must not be consumed by a loader", {
          skipped: manifest.skipped,
        }),
    manifest.summary.loadRequests === manifest.requests.length && manifest.summary.skippedModules === manifest.skipped.length
      ? pass("summary-counts", "Hotload manifest summary counts match payload")
      : fail("summary-counts", "Hotload manifest summary counts do not match payload", {
          summary: manifest.summary,
          requests: manifest.requests.length,
          skipped: manifest.skipped.length,
        }),
    manifest.summary.totalLoadedParameters === manifest.requests.reduce((sum, request) => sum + request.parameters, 0) &&
    manifest.summary.activeParametersPerRequest === manifest.requests.reduce((sum, request) => sum + request.activeParameters, 0)
      ? pass("summary-parameters", "Hotload parameter totals match load requests")
      : fail("summary-parameters", "Hotload parameter totals do not match load requests", {
          summary: manifest.summary,
        }),
  ];
}

function identityChecks(manifest: HotloadManifest): ParameterModuleHotloadQualityCheck[] {
  const requestIds = manifest.requests.map((request) => request.moduleId);
  const skippedIds = manifest.skipped.map((item) => item.moduleId);
  const duplicateRequestIds = duplicates(requestIds);
  const duplicateSkippedIds = duplicates(skippedIds);
  const both = requestIds.filter((id) => skippedIds.includes(id)).sort();
  return [
    duplicateRequestIds.length === 0
      ? pass("unique-load-request-ids", "Load request module ids are unique")
      : fail("unique-load-request-ids", "Load request module ids are duplicated", { duplicateRequestIds }),
    duplicateSkippedIds.length === 0
      ? pass("unique-skipped-module-ids", "Skipped module ids are unique")
      : fail("unique-skipped-module-ids", "Skipped module ids are duplicated", { duplicateSkippedIds }),
    both.length === 0
      ? pass("request-skip-disjoint", "No module is both loadable and skipped")
      : fail("request-skip-disjoint", "Some modules are both loadable and skipped", { moduleIds: both }),
  ];
}

function requestChecks(manifest: HotloadManifest): ParameterModuleHotloadQualityCheck[] {
  const checks: ParameterModuleHotloadQualityCheck[] = [];
  for (const request of manifest.requests) {
    const artifactKinds = new Set(request.artifacts.map((artifact) => artifact.kind));
    checks.push(
      request.parameters >= request.activeParameters && request.parameters >= request.trainableParameters
        ? pass(`parameter-counts:${request.moduleId}`, `Parameter counts are coherent for ${request.name}`)
        : fail(`parameter-counts:${request.moduleId}`, "Hotload request parameter counts are inconsistent", {
            parameters: request.parameters,
            activeParameters: request.activeParameters,
            trainableParameters: request.trainableParameters,
          }),
    );
    checks.push(
      artifactKinds.has("config") && (artifactKinds.has("checkpoint") || artifactKinds.has("adapter"))
        ? pass(`required-artifacts:${request.moduleId}`, `Required load artifacts are present for ${request.name}`)
        : fail(`required-artifacts:${request.moduleId}`, "Hotload request is missing config plus checkpoint/adapter artifacts", {
            artifactKinds: [...artifactKinds].sort(),
          }),
    );
    checks.push(
      request.evalReports.every((report) => report.status !== "fail")
        ? pass(`eval-report-statuses:${request.moduleId}`, `No failed eval reports for ${request.name}`)
        : fail(`eval-report-statuses:${request.moduleId}`, "Hotload request includes failed eval reports", {
            failedReports: request.evalReports.filter((report) => report.status === "fail"),
          }),
    );
  }
  return checks;
}

async function artifactChecks(
  manifest: HotloadManifest,
  manifestPath: string,
): Promise<ParameterModuleHotloadQualityCheck[]> {
  const checks: ParameterModuleHotloadQualityCheck[] = [];
  for (const request of manifest.requests) {
    for (const artifact of request.artifacts) {
      const path = resolveArtifactPath(artifact.path, manifestPath, request.stagingManifestPath);
      let body: Buffer;
      try {
        body = await readFile(path);
      } catch (err) {
        checks.push(
          fail(`artifact-readable:${request.moduleId}:${artifact.kind}`, "Hotload artifact could not be read", {
            path,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        continue;
      }
      const actualBytes = body.byteLength;
      const actualSha256 = createHash("sha256").update(body).digest("hex");
      const expectedBytes = artifact.bytes;
      const bytesMatch = expectedBytes === undefined || expectedBytes === actualBytes;
      checks.push(
        bytesMatch && actualSha256 === artifact.sha256
          ? pass(`artifact-hash:${request.moduleId}:${artifact.kind}`, `Verified ${artifact.kind} artifact for ${request.name}`)
          : fail(`artifact-hash:${request.moduleId}:${artifact.kind}`, "Hotload artifact bytes/hash verification failed", {
              path,
              expectedBytes,
              actualBytes,
              expectedSha256: artifact.sha256,
              actualSha256,
            }),
      );
    }
  }
  return checks;
}

function resolveArtifactPath(path: string, manifestPath: string, stagingManifestPath?: string): string {
  if (isAbsolute(path)) return path;
  if (stagingManifestPath) return join(dirname(stagingManifestPath), path);
  return join(dirname(manifestPath), path);
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function pass(id: string, summary: string, details?: Record<string, unknown>): ParameterModuleHotloadQualityCheck {
  return { id, status: "pass", summary, ...(details ? { details } : {}) };
}

function fail(id: string, summary: string, details?: Record<string, unknown>): ParameterModuleHotloadQualityCheck {
  return { id, status: "fail", summary, ...(details ? { details } : {}) };
}
