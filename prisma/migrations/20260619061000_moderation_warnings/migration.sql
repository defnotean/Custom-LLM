-- CreateTable
CREATE TABLE "ModerationWarning" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "moderatorUserId" TEXT NOT NULL,
    "warnedUserId" TEXT NOT NULL,
    "warnedUsername" TEXT,
    "reason" TEXT NOT NULL,
    "dmDelivered" BOOLEAN NOT NULL DEFAULT false,
    "moderatorMessageId" TEXT,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModerationWarning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModerationWarning_guildId_warnedUserId_createdAt_idx" ON "ModerationWarning"("guildId", "warnedUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationWarning_guildId_moderatorUserId_createdAt_idx" ON "ModerationWarning"("guildId", "moderatorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationWarning_createdAt_idx" ON "ModerationWarning"("createdAt");
