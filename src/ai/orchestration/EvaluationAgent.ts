import type { InteractionTrace } from "../../types/ai";

/**
 * Heuristic quality scoring for logged interactions (0..1). This is a cheap
 * pre-filter for the training pipeline — real review happens later (the
 * `reviewed` flag on TrainingExample + human pass, see docs/TRAINING_DATA.md).
 * An LLM-as-judge scorer is a documented future upgrade behind this same API.
 */
export class EvaluationAgent {
  scoreInteraction(trace: InteractionTrace): number {
    let score = 0.5;

    if (trace.parseOk === true) score += 0.2;
    if (trace.parseOk === false) score -= 0.25;

    if (trace.toolCall) {
      if (trace.toolSuccess === true) score += 0.2;
      if (trace.toolSuccess === false) score -= 0.1;
      if (trace.toolDenied) score -= 0.15;
    }

    score -= Math.min(0.3, trace.errors.length * 0.15);

    const finalLen = trace.finalResponse.trim().length;
    if (finalLen === 0) score -= 0.3;
    else if (finalLen > 4 && finalLen < 1500) score += 0.05;

    return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  }
}
