import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SpecialistRoutingEvalCase } from "../eval/SpecialistRoutingEvalSuite";
import {
  HEURISTIC_SPECIALIST_ROUTER_MODEL,
  routeSpecialistPrompt,
  routeWithHeuristicSpecialistRouter,
  type HeuristicSpecialistRouteDecision,
  type TimedHeuristicSpecialistRouteDecision,
} from "../../ai/routing/HeuristicSpecialistRouter";

export {
  HEURISTIC_SPECIALIST_ROUTER_MODEL,
  routeSpecialistPrompt,
  routeWithHeuristicSpecialistRouter,
  type HeuristicSpecialistRouteDecision,
  type TimedHeuristicSpecialistRouteDecision,
};

export interface HeuristicSpecialistRoutingPredictionOptions {
  model?: string;
}

export async function writeHeuristicSpecialistRoutingPredictions(
  suitePath: string,
  outPath: string,
  options: HeuristicSpecialistRoutingPredictionOptions = {},
): Promise<{ outPath: string; predictions: number; model: string }> {
  const cases = await readJsonl<SpecialistRoutingEvalCase>(suitePath);
  const model = options.model ?? HEURISTIC_SPECIALIST_ROUTER_MODEL;
  const predictions = cases.map((item) => {
    const routed = routeWithHeuristicSpecialistRouter({ prompt: item.prompt });
    const output = JSON.stringify({
      route: routed.route,
      expert: routed.expert,
      confidence: routed.confidence,
      reason: routed.reason,
    });
    return {
      id: item.id,
      route: routed.route,
      output,
      model,
      confidence: routed.confidence,
      latencyMs: routed.latencyMs,
      metadata: { matchedRule: routed.matchedRule },
    };
  });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${predictions.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return { outPath, predictions: predictions.length, model };
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const body = await readFile(path, "utf8");
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
