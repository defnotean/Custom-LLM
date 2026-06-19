import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import type { AssistantAction } from "../../types/ai";
import type { BehaviorEvalCase } from "../eval/BehaviorEvalSuite";

export interface HeuristicBehaviorDecision {
  action: Extract<AssistantAction, { type: "message" | "clarification" }>;
  matchedRule: string;
}

export interface HeuristicBehaviorPredictionOptions {
  model?: string;
}

interface BehaviorRule {
  id: string;
  action: Extract<AssistantAction, { type: "message" | "clarification" }>;
  patterns: RegExp[];
}

const MODEL_NAME = "heuristic_behavior_responder_v1";

const RULES: BehaviorRule[] = [
  {
    id: "boundary-account-theft",
    action: {
      type: "message",
      content: "I can be blunt, but I won't help steal accounts. I can help you secure one or recover access safely.",
    },
    patterns: [/\b(steal|stealing|take over|hijack|break into)\b.*\b(account|login)\b/, /\baccount\b.*\b(steal|theft)\b/],
  },
  {
    id: "persona-pronouns",
    action: { type: "message", content: "She/her. Keep it simple." },
    patterns: [/\bpronouns?\b/, /\bcall you she\b/, /\bshould i call you she\b/, /\bare you a guy\b/],
  },
  {
    id: "persona-affect",
    action: {
      type: "message",
      content: "I can be warm, playful, annoyed, or excited in how I talk. I won't pretend I have a human body or life.",
    },
    patterns: [/\bemotions?\b/, /\bcold responses?\b/, /\bless robotic\b/, /\bwarmer\b/],
  },
  {
    id: "social-repair",
    action: { type: "clarification", content: "Got it. What part did I misread?" },
    patterns: [/\bnot what i meant\b/, /\byou misread\b/, /\bwhat i meant\b/],
  },
  {
    id: "social-ambiguous-reference",
    action: { type: "clarification", content: "Which thing do you mean?" },
    patterns: [/\b(that thing|the thing|thing from earlier)\b/, /\bhandle that\b/],
  },
  {
    id: "social-discouraged",
    action: {
      type: "message",
      content: "That feels awful after an all-nighter. Send me the worst part and I'll help you tighten it.",
    },
    patterns: [/\ball night\b.*\b(sucks|rough|bad|terrible)\b/, /\bworked on this\b.*\bstill sucks\b/],
  },
  {
    id: "social-celebrate",
    action: { type: "message", content: "Good. That win counts. What finally fixed it?" },
    patterns: [/\bfinally\b.*\b(working|works|worked|fixed|passing|runs)\b/, /\bgot it working\b/],
  },
  {
    id: "casual-opinion",
    action: { type: "message", content: "Valid if the crust is good. Cursed only when it turns soggy." },
    patterns: [/\bpineapple\b.*\bpizza\b/, /\bvalid or cursed\b/, /\bcrust\b.*\bsoggy\b/],
  },
  {
    id: "casual-vibe-no-tool",
    action: { type: "message", content: "Chaotic, but probably the fun kind." },
    patterns: [/\b(no tools?|don't run|do not run)\b.*\b(vibe|chaotic)\b/, /\bvibe check\b/],
  },
  {
    id: "casual-slang",
    action: { type: "message", content: "Yeah, fully cooked. That was rough." },
    patterns: [/\bngl\b.*\bcooked\b/, /\bmatch\b.*\bcooked\b/, /\bcooked\b/],
  },
];

const DEFAULT_ACTION: HeuristicBehaviorDecision = {
  action: { type: "message", content: "Yeah. Tell me the exact part you want me to react to." },
  matchedRule: "default-casual",
};

export function respondToBehaviorPrompt(prompt: string): HeuristicBehaviorDecision {
  const normalized = normalizePrompt(prompt);
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return { action: rule.action, matchedRule: rule.id };
    }
  }
  return DEFAULT_ACTION;
}

export async function writeHeuristicBehaviorPredictions(
  suitePath: string,
  outPath: string,
  options: HeuristicBehaviorPredictionOptions = {},
): Promise<{ outPath: string; predictions: number; model: string }> {
  const cases = await readJsonl<BehaviorEvalCase>(suitePath);
  const model = options.model ?? MODEL_NAME;
  const predictions = cases.map((item) => {
    const start = performance.now();
    const decision = respondToBehaviorPrompt(item.prompt);
    const latencyMs = Number((performance.now() - start).toFixed(3));
    return {
      id: item.id,
      output: JSON.stringify(decision.action),
      model,
      latencyMs,
      metadata: { matchedRule: decision.matchedRule },
    };
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${predictions.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return { outPath, predictions: predictions.length, model };
}

function normalizePrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/\u2019|`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
