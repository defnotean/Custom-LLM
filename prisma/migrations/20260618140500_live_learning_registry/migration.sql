CREATE TYPE "LearningKind" AS ENUM (
    'MEMORY',
    'SKILL',
    'PREFERENCE',
    'CORRECTION',
    'EVAL_FAILURE',
    'VOICE_SUMMARY',
    'DOCUMENT'
);

CREATE TYPE "LearningReviewStatus" AS ENUM (
    'CANDIDATE',
    'APPROVED',
    'REJECTED'
);

CREATE TYPE "TrainingPromotionStatus" AS ENUM (
    'NOT_QUEUED',
    'QUEUED',
    'TRAINED',
    'BLOCKED'
);

CREATE TYPE "ParameterModuleKind" AS ENUM (
    'BASE_MODEL',
    'ADAPTER',
    'ROUTER',
    'SPECIALIST',
    'EXPERT',
    'MERGED_CHECKPOINT',
    'ENSEMBLE_MEMBER'
);

CREATE TYPE "ParameterModuleStatus" AS ENUM (
    'STAGED',
    'ACTIVE',
    'RETIRED',
    'REJECTED'
);

CREATE TABLE "LearnedItem" (
    "id" TEXT NOT NULL,
    "kind" "LearningKind" NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "reviewStatus" "LearningReviewStatus" NOT NULL DEFAULT 'CANDIDATE',
    "trainingStatus" "TrainingPromotionStatus" NOT NULL DEFAULT 'NOT_QUEUED',
    "accessPathsJson" JSONB NOT NULL DEFAULT '[]',
    "provenanceJson" JSONB NOT NULL DEFAULT '{}',
    "retentionJson" JSONB NOT NULL DEFAULT '{}',
    "trainingJson" JSONB NOT NULL DEFAULT '{}',
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnedItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ParameterModuleRecord" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ParameterModuleKind" NOT NULL,
    "parameters" BIGINT NOT NULL,
    "activeParameters" BIGINT NOT NULL,
    "trainableParameters" BIGINT NOT NULL,
    "status" "ParameterModuleStatus" NOT NULL DEFAULT 'STAGED',
    "baseModuleId" TEXT,
    "route" TEXT,
    "datasetHashesJson" JSONB NOT NULL DEFAULT '[]',
    "evalReportsJson" JSONB NOT NULL DEFAULT '[]',
    "sourceLearningItemIdsJson" JSONB NOT NULL DEFAULT '[]',
    "rollbackTargetId" TEXT,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "ParameterModuleRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearnedParameterModule" (
    "learnedItemId" TEXT NOT NULL,
    "parameterModuleId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearnedParameterModule_pkey" PRIMARY KEY ("learnedItemId", "parameterModuleId")
);

CREATE INDEX "LearnedItem_kind_createdAt_idx" ON "LearnedItem"("kind", "createdAt");
CREATE INDEX "LearnedItem_reviewStatus_idx" ON "LearnedItem"("reviewStatus");
CREATE INDEX "LearnedItem_trainingStatus_idx" ON "LearnedItem"("trainingStatus");

CREATE UNIQUE INDEX "ParameterModuleRecord_name_key" ON "ParameterModuleRecord"("name");
CREATE INDEX "ParameterModuleRecord_kind_status_idx" ON "ParameterModuleRecord"("kind", "status");
CREATE INDEX "ParameterModuleRecord_status_idx" ON "ParameterModuleRecord"("status");

ALTER TABLE "LearnedParameterModule"
ADD CONSTRAINT "LearnedParameterModule_learnedItemId_fkey"
FOREIGN KEY ("learnedItemId") REFERENCES "LearnedItem"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LearnedParameterModule"
ADD CONSTRAINT "LearnedParameterModule_parameterModuleId_fkey"
FOREIGN KEY ("parameterModuleId") REFERENCES "ParameterModuleRecord"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
