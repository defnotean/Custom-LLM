export const SUBQ_PROVIDER_ID = "subq" as const;
export const SUBQ_ARCHITECTURE_TARGET = "subquadratic-sparse-attention" as const;
export const LOCAL_LOG_SPARSE_ATTENTION_MODE = "local-log-sparse" as const;
export const SUBQ_ARCHITECTURE_GATE_SCRIPT = "check:subq-architecture" as const;
export const SUBQ_ARCHITECTURE_GATE_COMMAND = "npm run check:subq-architecture" as const;

export interface SubqLongContextMetadata {
  longContext: true;
  preferredProvider: typeof SUBQ_PROVIDER_ID;
  architectureTarget: typeof SUBQ_ARCHITECTURE_TARGET;
}

export interface LocalLogSparseAttentionProfile {
  mode: typeof LOCAL_LOG_SPARSE_ATTENTION_MODE;
  sequenceLengths: number[];
  localWindow: number;
  logBase: number;
  maxGrowthExponent: number;
  maxLargestDenseEdgeRatio: number;
  maxAverageKeysPerToken: number;
}

export const DEFAULT_LOCAL_LOG_SPARSE_ATTENTION_PROFILE: LocalLogSparseAttentionProfile = Object.freeze({
  mode: LOCAL_LOG_SPARSE_ATTENTION_MODE,
  sequenceLengths: [2048, 8192, 64000],
  localWindow: 32,
  logBase: 2,
  maxGrowthExponent: 1.25,
  maxLargestDenseEdgeRatio: 0.01,
  maxAverageKeysPerToken: 96,
});

export function buildSubqLongContextMetadata(
  metadata: Record<string, unknown> = {},
): Record<string, unknown> & SubqLongContextMetadata {
  return {
    ...metadata,
    longContext: true,
    preferredProvider: SUBQ_PROVIDER_ID,
    architectureTarget: SUBQ_ARCHITECTURE_TARGET,
  };
}

export function isSubqLongContextMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return (
    metadata?.longContext === true ||
    metadata?.preferredProvider === SUBQ_PROVIDER_ID ||
    metadata?.architectureTarget === SUBQ_ARCHITECTURE_TARGET
  );
}

export function buildLocalLogSparseTrainerArgs(
  profile: Pick<LocalLogSparseAttentionProfile, "mode" | "localWindow" | "logBase"> =
    DEFAULT_LOCAL_LOG_SPARSE_ATTENTION_PROFILE,
): string[] {
  return [
    "--attention-mode",
    profile.mode,
    "--sparse-local-window",
    String(profile.localWindow),
    "--sparse-log-base",
    String(profile.logBase),
  ];
}
