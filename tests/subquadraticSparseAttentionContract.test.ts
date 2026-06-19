import { describe, expect, it } from "vitest";
import {
  buildLocalLogSparseTrainerArgs,
  buildSubqLongContextMetadata,
  DEFAULT_LOCAL_LOG_SPARSE_ATTENTION_PROFILE,
  isSubqLongContextMetadata,
  LOCAL_LOG_SPARSE_ATTENTION_MODE,
  SUBQ_ARCHITECTURE_GATE_COMMAND,
  SUBQ_ARCHITECTURE_TARGET,
  SUBQ_PROVIDER_ID,
} from "../src/ai/architecture/SubquadraticSparseAttentionContract";
import { analyzeLocalLogSparseAttentionBudget } from "../src/training/quality/SparseAttentionBudget";

describe("SubquadraticSparseAttentionContract", () => {
  it("pins long-context metadata to the SubQ/SSA route", () => {
    const metadata = buildSubqLongContextMetadata({ requestId: "lc-1", preferredProvider: "dense" });

    expect(metadata).toMatchObject({
      requestId: "lc-1",
      longContext: true,
      preferredProvider: SUBQ_PROVIDER_ID,
      architectureTarget: SUBQ_ARCHITECTURE_TARGET,
    });
    expect(isSubqLongContextMetadata(metadata)).toBe(true);
    expect(isSubqLongContextMetadata({ architectureTarget: SUBQ_ARCHITECTURE_TARGET })).toBe(true);
    expect(isSubqLongContextMetadata({ preferredProvider: SUBQ_PROVIDER_ID })).toBe(true);
    expect(isSubqLongContextMetadata({ preferredProvider: "openai-compatible" })).toBe(false);
  });

  it("keeps the default local/log sparse profile under the SubQ budget", () => {
    const profile = DEFAULT_LOCAL_LOG_SPARSE_ATTENTION_PROFILE;
    const budget = analyzeLocalLogSparseAttentionBudget({
      sequenceLengths: profile.sequenceLengths,
      localWindow: profile.localWindow,
      logBase: profile.logBase,
    });

    expect(profile.mode).toBe(LOCAL_LOG_SPARSE_ATTENTION_MODE);
    expect(budget.mode).toBe(LOCAL_LOG_SPARSE_ATTENTION_MODE);
    expect(budget.growthExponent).toBeLessThanOrEqual(profile.maxGrowthExponent);
    expect(budget.largest.denseEdgeRatio).toBeLessThanOrEqual(profile.maxLargestDenseEdgeRatio);
    expect(budget.largest.averageKeysPerToken).toBeLessThanOrEqual(profile.maxAverageKeysPerToken);
  });

  it("builds trainer flags from the same sparse profile", () => {
    expect(buildLocalLogSparseTrainerArgs()).toEqual([
      "--attention-mode",
      "local-log-sparse",
      "--sparse-local-window",
      "32",
      "--sparse-log-base",
      "2",
    ]);
    expect(SUBQ_ARCHITECTURE_GATE_COMMAND).toBe("npm run check:subq-architecture");
  });
});
