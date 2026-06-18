ALTER TABLE "UserFeedback" ADD COLUMN "preferredResponse" TEXT;
ALTER TABLE "UserFeedback" ADD COLUMN "rejectedResponse" TEXT;
ALTER TABLE "UserFeedback" ADD COLUMN "reviewed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserFeedback" ADD COLUMN "metadataJson" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX "UserFeedback_reviewed_idx" ON "UserFeedback"("reviewed");
