export interface SparseAttentionBudgetOptions {
  sequenceLengths: number[];
  localWindow: number;
  logBase: number;
}

export interface SparseAttentionBudgetPoint {
  sequenceLength: number;
  sparseEdges: number;
  denseCausalEdges: number;
  denseEdgeRatio: number;
  averageKeysPerToken: number;
  maxKeysPerToken: number;
  lastTokenKeys: number;
}

export interface SparseAttentionBudgetReport {
  mode: "local-log-sparse";
  localWindow: number;
  logBase: number;
  points: SparseAttentionBudgetPoint[];
  largest: SparseAttentionBudgetPoint;
  growthExponent: number;
}

export function analyzeLocalLogSparseAttentionBudget(
  options: SparseAttentionBudgetOptions,
): SparseAttentionBudgetReport {
  validateBudgetOptions(options);
  const sequenceLengths = [...new Set(options.sequenceLengths)].sort((left, right) => left - right);
  const points = sequenceLengths.map((sequenceLength) =>
    budgetPoint(sequenceLength, options.localWindow, options.logBase),
  );
  const first = points[0];
  const largest = points[points.length - 1];
  if (!first || !largest) throw new Error("At least one sequence length is required");

  const growthExponent =
    points.length < 2 || first.sequenceLength === largest.sequenceLength
      ? 1
      : Math.log(largest.sparseEdges / first.sparseEdges) /
        Math.log(largest.sequenceLength / first.sequenceLength);

  return {
    mode: "local-log-sparse",
    localWindow: options.localWindow,
    logBase: options.logBase,
    points,
    largest,
    growthExponent: round(growthExponent),
  };
}

export function localLogSparseKeyCount(step: number, localWindow: number, logBase: number): number {
  if (!Number.isInteger(step) || step < 0) throw new Error("step must be a nonnegative integer");
  if (!Number.isInteger(localWindow) || localWindow < 1) throw new Error("localWindow must be an integer >= 1");
  if (!Number.isInteger(logBase) || logBase < 2) throw new Error("logBase must be an integer >= 2");

  const indices = new Set<number>();
  const localStart = Math.max(0, step - localWindow + 1);
  for (let index = localStart; index <= step; index++) indices.add(index);

  let distance = localWindow;
  while (distance <= step) {
    indices.add(step - distance);
    distance *= logBase;
  }
  indices.add(0);
  indices.add(step);
  return indices.size;
}

function budgetPoint(sequenceLength: number, localWindow: number, logBase: number): SparseAttentionBudgetPoint {
  let sparseEdges = 0;
  let maxKeysPerToken = 0;
  let lastTokenKeys = 0;
  for (let step = 0; step < sequenceLength; step++) {
    const keys = localLogSparseKeyCount(step, localWindow, logBase);
    sparseEdges += keys;
    maxKeysPerToken = Math.max(maxKeysPerToken, keys);
    if (step === sequenceLength - 1) lastTokenKeys = keys;
  }

  const denseCausalEdges = (sequenceLength * (sequenceLength + 1)) / 2;
  return {
    sequenceLength,
    sparseEdges,
    denseCausalEdges,
    denseEdgeRatio: round(sparseEdges / denseCausalEdges),
    averageKeysPerToken: round(sparseEdges / sequenceLength),
    maxKeysPerToken,
    lastTokenKeys,
  };
}

function validateBudgetOptions(options: SparseAttentionBudgetOptions): void {
  if (options.sequenceLengths.length === 0) throw new Error("At least one sequence length is required");
  for (const sequenceLength of options.sequenceLengths) {
    if (!Number.isInteger(sequenceLength) || sequenceLength < 1) {
      throw new Error(`sequenceLength must be an integer >= 1: ${sequenceLength}`);
    }
  }
  if (!Number.isInteger(options.localWindow) || options.localWindow < 1) {
    throw new Error("localWindow must be an integer >= 1");
  }
  if (!Number.isInteger(options.logBase) || options.logBase < 2) {
    throw new Error("logBase must be an integer >= 2");
  }
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
