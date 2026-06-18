import { readFile } from "node:fs/promises";

export type TrainingIterationReportMode = "review" | "promotion";
export type TrainingIterationReportCheckStatus = "pass" | "warn" | "fail";

export interface TrainingIterationReportQualityOptions {
  reportPath: string;
  mode?: TrainingIterationReportMode;
  requirePromotion?: boolean;
  requireTool?: boolean;
  requireKnowledge?: boolean;
  requireBehavior?: boolean;
  requireRouter?: boolean;
}

export interface TrainingIterationReportCheck {
  id: string;
  status: TrainingIterationReportCheckStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface TrainingIterationReportQualityReport {
  status: "ready" | "not_ready";
  mode: TrainingIterationReportMode;
  reportPath: string;
  summary: {
    candidateRunName?: string;
    promotionStatus?: string;
    toolGateStatus?: string;
    knowledgeGateStatus?: string;
    behaviorGateStatus?: string;
    routerGateStatus?: string;
  };
  checks: TrainingIterationReportCheck[];
}

type JsonRecord = Record<string, unknown>;

export async function checkTrainingIterationReport(
  options: TrainingIterationReportQualityOptions,
): Promise<TrainingIterationReportQualityReport> {
  const mode = options.mode ?? "review";
  const requirePromotion = options.requirePromotion ?? true;
  const requireTool = options.requireTool ?? true;
  const requireKnowledge = options.requireKnowledge ?? true;
  const requireBehavior = options.requireBehavior ?? false;
  const requireRouter = options.requireRouter ?? false;
  const report = asRecord(JSON.parse(await readFile(options.reportPath, "utf8")));
  const checks: TrainingIterationReportCheck[] = [];

  const leaderboard = recordProp(report, "leaderboard");
  addCheck(
    checks,
    "leaderboard",
    leaderboard && numberProp(leaderboard, "totalRuns") > 0 ? "pass" : "fail",
    leaderboard ? "Leaderboard section is present" : "Leaderboard section is missing",
    leaderboard ? { totalRuns: numberProp(leaderboard, "totalRuns") } : {},
  );

  const promotion = recordProp(report, "promotion");
  const candidate = promotion ? recordProp(promotion, "candidate") : undefined;
  const candidateRunName = candidate ? stringProp(candidate, "runName") : undefined;
  const promotionStatus = promotion ? stringProp(promotion, "status") : undefined;

  checkPromotion({
    checks,
    mode,
    required: requirePromotion,
    promotion,
    promotionStatus,
    candidate,
  });
  checkEvidence({
    checks,
    mode,
    kind: "tool",
    required: requireTool,
    evidence: recordProp(report, "tool"),
  });
  checkEvidence({
    checks,
    mode,
    kind: "knowledge",
    required: requireKnowledge,
    evidence: recordProp(report, "knowledge"),
  });
  checkEvidence({
    checks,
    mode,
    kind: "behavior",
    required: requireBehavior,
    evidence: recordProp(report, "behavior"),
  });
  checkEvidence({
    checks,
    mode,
    kind: "router",
    required: requireRouter,
    evidence: recordProp(report, "router"),
  });

  return {
    status: checks.some((check) => check.status === "fail") ? "not_ready" : "ready",
    mode,
    reportPath: options.reportPath,
    summary: {
      ...(candidateRunName ? { candidateRunName } : {}),
      ...(promotionStatus ? { promotionStatus } : {}),
      ...evidenceStatus("tool", recordProp(report, "tool")),
      ...evidenceStatus("knowledge", recordProp(report, "knowledge")),
      ...evidenceStatus("behavior", recordProp(report, "behavior")),
      ...evidenceStatus("router", recordProp(report, "router")),
    },
    checks,
  };
}

function checkPromotion(input: {
  checks: TrainingIterationReportCheck[];
  mode: TrainingIterationReportMode;
  required: boolean;
  promotion?: JsonRecord;
  promotionStatus?: string;
  candidate?: JsonRecord;
}): void {
  if (!input.required) {
    addCheck(input.checks, "promotion-required", "pass", "Promotion section is optional for this check");
    return;
  }
  if (!input.promotion || !input.candidate) {
    addCheck(input.checks, "promotion-evidence", "fail", "Promotion candidate evidence is missing");
    return;
  }

  addCheck(input.checks, "promotion-evidence", "pass", "Promotion candidate evidence is present");
  const status = input.promotionStatus ?? "unknown";
  if (input.mode === "promotion") {
    addCheck(
      input.checks,
      "promotion-status",
      status === "accepted" ? "pass" : "fail",
      status === "accepted" ? "Candidate promotion status is accepted" : `Candidate promotion status is ${status}`,
      { status },
    );
  } else {
    addCheck(
      input.checks,
      "promotion-status",
      status === "accepted" ? "pass" : "warn",
      status === "accepted" ? "Candidate is promotable by loss/artifact gate" : `Candidate is review-only: ${status}`,
      { status, reasons: arrayProp(input.promotion, "reasons") },
    );
  }

  addCheck(
    input.checks,
    "candidate-artifacts",
    booleanProp(input.candidate, "allArtifactsPresent") ? "pass" : "fail",
    booleanProp(input.candidate, "allArtifactsPresent")
      ? "Candidate artifacts are present"
      : "Candidate has missing or empty artifacts",
  );

  const candidateWarnings = arrayProp(input.candidate, "warnings");
  addCheck(
    input.checks,
    "candidate-warnings",
    candidateWarnings.length === 0 ? "pass" : input.mode === "promotion" ? "fail" : "warn",
    candidateWarnings.length === 0 ? "Candidate has no run warnings" : "Candidate run warnings are present",
    { warnings: candidateWarnings },
  );
}

function checkEvidence(input: {
  checks: TrainingIterationReportCheck[];
  mode: TrainingIterationReportMode;
  kind: EvidenceKind;
  required: boolean;
  evidence?: JsonRecord;
}): void {
  const label = evidenceLabel(input.kind);
  if (!input.required) {
    addCheck(input.checks, `${input.kind}-required`, "pass", `${label} evidence is optional for this check`);
    return;
  }
  if (!input.evidence) {
    addCheck(input.checks, `${input.kind}-evidence`, "fail", `${label} evidence is missing`);
    return;
  }

  addCheck(input.checks, `${input.kind}-evidence`, "pass", `${label} evidence is present`);
  const predictionModels = arrayProp(input.evidence, "predictionModels");
  addCheck(
    input.checks,
    `${input.kind}-prediction-models`,
    predictionModels.length > 0 ? "pass" : "fail",
    predictionModels.length > 0 ? `${label} prediction model metadata is present` : `${label} prediction model metadata is missing`,
    { predictionModels },
  );

  const candidateModelMatched = booleanProp(input.evidence, "candidateModelMatched");
  addCheck(
    input.checks,
    `${input.kind}-candidate-match`,
    candidateModelMatched ? "pass" : "fail",
    candidateModelMatched
      ? `${label} predictions match the candidate run`
      : `${label} predictions do not match the candidate run`,
    { candidateRunName: stringProp(input.evidence, "candidateRunName"), predictionModels },
  );

  const evidenceWarnings = arrayProp(input.evidence, "warnings");
  addCheck(
    input.checks,
    `${input.kind}-warnings`,
    evidenceWarnings.length === 0 ? "pass" : "fail",
    evidenceWarnings.length === 0 ? `${label} evidence has no warnings` : `${label} evidence warnings are present`,
    { warnings: evidenceWarnings },
  );

  const gate = recordProp(input.evidence, "gate");
  const gateStatus = gate ? stringProp(gate, "status") : undefined;
  if (!gate) {
    addCheck(input.checks, `${input.kind}-gate`, "fail", `${label} gate result is missing`);
    return;
  }
  if (input.mode === "promotion") {
    addCheck(
      input.checks,
      `${input.kind}-gate`,
      gateStatus === "pass" ? "pass" : "fail",
      gateStatus === "pass" ? `${label} gate passed` : `${label} gate status is ${gateStatus ?? "unknown"}`,
      { status: gateStatus, failures: arrayProp(gate, "failures") },
    );
  } else {
    addCheck(
      input.checks,
      `${input.kind}-gate`,
      gateStatus === "pass" ? "pass" : "warn",
      gateStatus === "pass" ? `${label} gate passed` : `${label} gate is review-only: ${gateStatus ?? "unknown"}`,
      { status: gateStatus, failures: arrayProp(gate, "failures") },
    );
  }
}

type EvidenceKind = "tool" | "knowledge" | "behavior" | "router";

function evidenceStatus(kind: EvidenceKind, evidence?: JsonRecord): Record<string, string> {
  const gate = evidence ? recordProp(evidence, "gate") : undefined;
  const status = gate ? stringProp(gate, "status") : undefined;
  if (!status) return {};
  if (kind === "tool") return { toolGateStatus: status };
  if (kind === "knowledge") return { knowledgeGateStatus: status };
  if (kind === "behavior") return { behaviorGateStatus: status };
  return { routerGateStatus: status };
}

function evidenceLabel(kind: EvidenceKind): string {
  if (kind === "tool") return "Protocol";
  if (kind === "knowledge") return "Knowledge";
  if (kind === "behavior") return "Behavior";
  return "Router";
}

function addCheck(
  checks: TrainingIterationReportCheck[],
  id: string,
  status: TrainingIterationReportCheckStatus,
  summary: string,
  details?: Record<string, unknown>,
): void {
  checks.push({
    id,
    status,
    summary,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  });
}

function asRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("Training iteration report must be a JSON object");
  return value;
}

function recordProp(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringProp(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberProp(record: JsonRecord, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanProp(record: JsonRecord, key: string): boolean {
  return record[key] === true;
}

function arrayProp(record: JsonRecord, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
