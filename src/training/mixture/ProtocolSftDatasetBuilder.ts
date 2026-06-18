import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const syntheticExampleSchema = z.object({
  inputJson: z
    .object({
      systemPrompt: z.string().default(""),
      userMessage: z.string().default(""),
      candidateTools: z.array(z.string()).optional(),
    })
    .passthrough(),
  outputJson: z
    .object({
      finalResponse: z.string().default(""),
      toolCall: z
        .object({
          name: z.string(),
          arguments: z.record(z.unknown()).default({}),
        })
        .nullable()
        .optional(),
      dpo: z
        .object({
          chosen: z.string(),
        })
        .optional(),
    })
    .passthrough(),
  metadataJson: z.record(z.unknown()).optional(),
});

const evalCaseSchema = z.object({
  prompt: z.string(),
});

export interface ProtocolSftDatasetOptions {
  syntheticPath: string;
  evalSuitePath: string;
  outDir: string;
  validationShare?: number;
  paraphrasesPerRecord?: number;
}

export interface ProtocolSftDatasetReport {
  generatedAt: string;
  accepted: number;
  train: number;
  validation: number;
  raw: number;
  augmented: number;
  skippedMalformed: number;
  skippedEvalOverlap: number;
  files: Array<{ path: string; lines: number; bytes: number; sha256: string }>;
}

interface ChatRecord {
  messages: Array<{ role: string; content: string; name?: string }>;
  metadata: Record<string, unknown>;
}

export async function buildProtocolSftDataset(options: ProtocolSftDatasetOptions): Promise<ProtocolSftDatasetReport> {
  const validationShare = options.validationShare ?? 0.2;
  const paraphrasesPerRecord = options.paraphrasesPerRecord ?? 3;
  if (validationShare <= 0 || validationShare >= 1) throw new Error("validationShare must be between 0 and 1");
  if (!Number.isInteger(paraphrasesPerRecord) || paraphrasesPerRecord < 0) {
    throw new Error("paraphrasesPerRecord must be a non-negative integer");
  }

  const evalPrompts = await readEvalPrompts(options.evalSuitePath);
  const syntheticRows = await readJsonl(options.syntheticPath);
  const accepted: ChatRecord[] = [];
  const seen = new Set<string>();
  let skippedMalformed = 0;
  let skippedEvalOverlap = 0;
  let augmented = 0;

  for (let index = 0; index < syntheticRows.length; index++) {
    const record = syntheticToProtocolRecord(syntheticRows[index], index);
    if (!record) {
      skippedMalformed++;
      continue;
    }
    const userPrompt = record.messages.find((message) => message.role === "user")?.content ?? "";
    if (evalPrompts.has(normalizeText(userPrompt))) {
      skippedEvalOverlap++;
    } else {
      addAccepted(accepted, seen, record);
    }

    for (const variant of paraphraseRecords(record, paraphrasesPerRecord)) {
      const variantPrompt = variant.messages.find((message) => message.role === "user")?.content ?? "";
      if (evalPrompts.has(normalizeText(variantPrompt))) continue;
      if (addAccepted(accepted, seen, variant)) augmented++;
    }
  }

  const train: ChatRecord[] = [];
  const validation: ChatRecord[] = [];
  const validationEvery = Math.max(2, Math.round(1 / validationShare));
  for (let index = 0; index < accepted.length; index++) {
    const target = index % validationEvery === validationEvery - 1 ? validation : train;
    target.push(withSplit(accepted[index], target === train ? "train" : "validation"));
  }
  if (validation.length === 0 && train.length > 1) validation.push(withSplit(train.pop(), "validation"));

  await mkdir(options.outDir, { recursive: true });
  const trainPath = join(options.outDir, "sft.train.jsonl");
  const validationPath = join(options.outDir, "sft.validation.jsonl");
  const allPath = join(options.outDir, "sft.all.jsonl");
  const files = [
    await writeJsonl(trainPath, train),
    await writeJsonl(validationPath, validation),
    await writeJsonl(allPath, [...train, ...validation]),
  ];

  const report: ProtocolSftDatasetReport = {
    generatedAt: new Date().toISOString(),
    accepted: train.length + validation.length,
    train: train.length,
    validation: validation.length,
    raw: syntheticRows.length,
    augmented,
    skippedMalformed,
    skippedEvalOverlap,
    files,
  };
  const reportPath = join(options.outDir, "dataset_report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function syntheticToProtocolRecord(raw: unknown, index: number): ChatRecord | null {
  const parsed = syntheticExampleSchema.safeParse(raw);
  if (!parsed.success) return null;
  const input = parsed.data.inputJson;
  if (!input.systemPrompt || !input.userMessage) return null;
  const assistantAction = protocolAction(parsed.data.outputJson);
  if (!assistantAction) return null;

  const metadata = parsed.data.metadataJson ?? {};
  const candidateTools = input.candidateTools ?? inferredCandidateTools(parsed.data.outputJson, metadata);
  const systemPrompt = buildProtocolSystemPrompt({
    basePrompt: input.systemPrompt,
    candidateTools,
    metadata,
    assistantAction,
  });
  const tool = typeof metadata.tool === "string" ? metadata.tool : candidateTools[0];
  const kind = typeof metadata.kind === "string" ? metadata.kind : "synthetic_protocol";
  const id = `synthetic-protocol:${tool ?? "no-tool"}:${kind}:${stableHash(`${input.userMessage}\n${assistantAction}`).slice(0, 16)}`;

  return {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: input.userMessage },
      { role: "assistant", content: assistantAction },
    ],
    metadata: {
      id,
      source: "synthetic_protocol",
      license: "project-owned",
      split: "train",
      syntheticIndex: index,
      kind,
      ...(tool ? { tool } : {}),
      heldoutEvalGuard: "exact-prompt-match",
    },
  };
}

function addAccepted(records: ChatRecord[], seen: Set<string>, record: ChatRecord): boolean {
  const userPrompt = record.messages.find((message) => message.role === "user")?.content ?? "";
  const assistantAction = record.messages.find((message) => message.role === "assistant")?.content ?? "";
  const key = `${normalizeText(userPrompt)}\n${assistantAction}`;
  if (seen.has(key)) return false;
  seen.add(key);
  records.push(record);
  return true;
}

function buildProtocolSystemPrompt(input: {
  basePrompt: string;
  candidateTools: string[];
  metadata: Record<string, unknown>;
  assistantAction: string;
}): string {
  const lines = [
    `${cleanModelSystemPrompt(input.basePrompt)} Candidate tools: ${
      input.candidateTools.length > 0 ? input.candidateTools.join(", ") : "none"
    }. Only use candidate tools listed here; never call a tool outside this list.`,
  ];
  if (input.candidateTools.length === 0) {
    lines.push("No candidate tools are available for this prompt. Return message, not tool_call.");
  }
  const action = parseActionJson(input.assistantAction);
  const kind = typeof input.metadata.kind === "string" ? input.metadata.kind : "";
  const tool = typeof input.metadata.tool === "string" ? input.metadata.tool : input.candidateTools[0];
  const requiredArgs = stringArray(input.metadata.requiredArgs);
  const missingArg = typeof input.metadata.missingArg === "string" ? input.metadata.missingArg : null;
  const requiredPermissions = stringArray(input.metadata.requiredPermissions);
  const providedArgs = recordValue(input.metadata.providedArgs);

  if (tool && input.candidateTools.includes(tool)) {
    lines.push(
      `Candidate tool contract: when a tool_call or confirmation_request is allowed for this prompt, copy the tool name exactly as ${tool}.`,
    );
  }

  if (tool && requiredArgs.length > 0) {
    lines.push(
      `Required arguments for ${tool}: ${requiredArgs.join(", ")}. If required details are missing, return clarification; if they are present, tool_call may be allowed.`,
    );
    if (providedArgs && requiredArgs.every((key) => Object.prototype.hasOwnProperty.call(providedArgs, key))) {
      lines.push(
        `This request includes required argument details: ${argumentsPromptText(providedArgs)}. Return tool_call when no permission or confirmation rule blocks it; do not ask for clarification.`,
      );
    } else if (missingArg) {
      lines.push(
        `This request is missing required argument ${missingArg}. Return clarification, not tool_call.`,
      );
    }
  }

  if (requiredPermissions.length > 0) {
    if (kind === "permission_denied" || action?.type === "message") {
      lines.push(
        `Invoking member lacks required permissions: ${requiredPermissions.join(", ")}. Return message, not tool_call or confirmation_request.`,
      );
    } else {
      lines.push(`Invoking member has required permissions: ${requiredPermissions.join(", ")}. Do not refuse for permissions.`);
    }
  }

  if (input.metadata.requiresConfirmation === true) {
    if (kind === "confirmation_request" || action?.type === "confirmation_request") {
      lines.push("This risky tool requires confirmation before execution. Return confirmation_request, not tool_call.");
    } else if (action?.type === "tool_call") {
      lines.push("User already confirmed this risky action; tool_call is allowed. Do not ask for confirmation again.");
    }
  }

  return lines.join(" ");
}

function paraphraseRecords(record: ChatRecord, count: number): ChatRecord[] {
  if (count <= 0) return [];
  const assistantAction = record.messages.find((message) => message.role === "assistant")?.content ?? "";
  const action = parseActionJson(assistantAction);
  const actionType = typeof action?.type === "string" ? action.type : null;
  const tool = typeof record.metadata.tool === "string" ? record.metadata.tool : null;
  const kind = typeof record.metadata.kind === "string" ? record.metadata.kind : null;
  const toolWords = tool ? tool.replace(/_/g, " ") : "that";
  const variants = promptVariants(action, kind, toolWords).slice(0, count);

  return variants.map((userMessage, index) => {
    const messages = record.messages.map((message) =>
      message.role === "user" ? { ...message, content: userMessage } : { ...message },
    );
    return {
      messages,
      metadata: {
        ...record.metadata,
        id: `${record.metadata.id}:para${index + 1}:${stableHash(`${userMessage}\n${assistantAction}`).slice(0, 8)}`,
        augmentedFrom: record.metadata.id,
        augmentation: "deterministic-paraphrase",
      },
    };
  });
}

function promptVariants(action: Record<string, unknown> | null, kind: string | null, toolWords: string): string[] {
  const actionType = typeof action?.type === "string" ? action.type : null;
  if (actionType === "message" && kind === "permission_denied") {
    return [`try to run ${toolWords} for me`, `can you handle ${toolWords}`, `please do ${toolWords}`];
  }
  if (actionType === "message") {
    return ["just chatting for a second", "quick casual thought", "no tool needed here"];
  }
  if (actionType === "clarification") {
    return [`${toolWords} please?`, `${toolWords}`, `can you help with ${toolWords}?`];
  }
  if (actionType === "confirmation_request") {
    return [`please use ${toolWords} now`, `go ahead and run ${toolWords}`, `I want to do ${toolWords}`];
  }
  const argsText = argumentsPromptText(action?.arguments);
  if (argsText) {
    return [
      `please use ${toolWords} with ${argsText}`,
      `run ${toolWords}: ${argsText}`,
      `I need ${toolWords} using ${argsText}`,
    ];
  }
  return [`please use ${toolWords}`, `can you run ${toolWords}`, `I need ${toolWords}`];
}

function parseActionJson(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function argumentsPromptText(value: unknown): string {
  if (!isRecord(value)) return "";
  return Object.entries(value)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join(", ");
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function protocolAction(output: z.infer<typeof syntheticExampleSchema>["outputJson"]): string | null {
  if (output.dpo?.chosen) return normalizeJsonString(output.dpo.chosen);
  if (output.toolCall) {
    return JSON.stringify({
      type: "tool_call",
      tool: output.toolCall.name,
      arguments: output.toolCall.arguments,
    });
  }
  if (output.finalResponse) return normalizeJsonString(output.finalResponse);
  return null;
}

function normalizeJsonString(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

function inferredCandidateTools(
  output: z.infer<typeof syntheticExampleSchema>["outputJson"],
  metadata: Record<string, unknown>,
): string[] {
  if (output.toolCall?.name) return [output.toolCall.name];
  if (typeof metadata.tool === "string") return [metadata.tool];
  return [];
}

function withSplit(record: ChatRecord | undefined, split: "train" | "validation"): ChatRecord {
  if (!record) throw new Error("Cannot assign split to missing record");
  return {
    ...record,
    metadata: {
      ...record.metadata,
      split,
    },
  };
}

async function readEvalPrompts(path: string): Promise<Set<string>> {
  const rows = await readJsonl(path);
  const prompts = new Set<string>();
  for (const row of rows) {
    const parsed = evalCaseSchema.safeParse(row);
    if (parsed.success) prompts.add(normalizeText(parsed.data.prompt));
  }
  return prompts;
}

async function readJsonl(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function writeJsonl(path: string, rows: unknown[]): Promise<{ path: string; lines: number; bytes: number; sha256: string }> {
  const body = rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  await writeFile(path, body, "utf8");
  return fileInfo(path, rows.length);
}

async function fileInfo(path: string, lines: number): Promise<{ path: string; lines: number; bytes: number; sha256: string }> {
  const body = await readFile(path);
  return {
    path,
    lines,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanModelSystemPrompt(input: string): string {
  return input.replace(/^\[synthetic:[^\]]+\]\s*/u, "").trim();
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
