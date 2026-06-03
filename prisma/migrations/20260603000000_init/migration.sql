-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MemoryScope" AS ENUM ('USER', 'GUILD', 'CHANNEL', 'GLOBAL');

-- CreateEnum
CREATE TYPE "TrainingSource" AS ENUM ('CONVERSATION', 'TOOL_CALL', 'SYNTHETIC', 'FEEDBACK');

-- CreateEnum
CREATE TYPE "TrainingFormat" AS ENUM ('CHATML', 'ALPACA', 'TOOL_CALLING_JSONL');

-- CreateEnum
CREATE TYPE "ToolRisk" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuildProfile" (
    "id" TEXT NOT NULL,
    "discordGuildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "settingsJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuildProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelProfile" (
    "id" TEXT NOT NULL,
    "discordChannelId" TEXT NOT NULL,
    "guildId" TEXT,
    "name" TEXT NOT NULL,
    "settingsJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "guildId" TEXT,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "discordMessageId" TEXT NOT NULL,
    "userMessage" TEXT NOT NULL,
    "assistantResponse" TEXT,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "guildId" TEXT,
    "channelId" TEXT,
    "scope" "MemoryScope" NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "importance" INTEGER NOT NULL DEFAULT 1,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "vectorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolLog" (
    "id" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolCategory" TEXT NOT NULL,
    "guildId" TEXT,
    "channelId" TEXT,
    "userId" TEXT,
    "inputJson" JSONB NOT NULL,
    "outputJson" JSONB,
    "error" TEXT,
    "latencyMs" INTEGER,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingExample" (
    "id" TEXT NOT NULL,
    "source" "TrainingSource" NOT NULL,
    "format" "TrainingFormat" NOT NULL,
    "inputJson" JSONB NOT NULL,
    "outputJson" JSONB NOT NULL,
    "qualityScore" DOUBLE PRECISION,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingExample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFeedback" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT,
    "rating" INTEGER,
    "feedbackText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolDefinitionRecord" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "schemaJson" JSONB NOT NULL,
    "riskLevel" "ToolRisk" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "requiredPermissionsJson" JSONB NOT NULL DEFAULT '[]',
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolDefinitionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_discordUserId_key" ON "UserProfile"("discordUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GuildProfile_discordGuildId_key" ON "GuildProfile"("discordGuildId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelProfile_discordChannelId_key" ON "ChannelProfile"("discordChannelId");

-- CreateIndex
CREATE INDEX "Conversation_channelId_createdAt_idx" ON "Conversation"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "Conversation_userId_createdAt_idx" ON "Conversation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Memory_scope_userId_idx" ON "Memory"("scope", "userId");

-- CreateIndex
CREATE INDEX "Memory_scope_guildId_idx" ON "Memory"("scope", "guildId");

-- CreateIndex
CREATE INDEX "Memory_scope_channelId_idx" ON "Memory"("scope", "channelId");

-- CreateIndex
CREATE INDEX "ToolLog_toolName_createdAt_idx" ON "ToolLog"("toolName", "createdAt");

-- CreateIndex
CREATE INDEX "ToolLog_success_idx" ON "ToolLog"("success");

-- CreateIndex
CREATE INDEX "TrainingExample_format_createdAt_idx" ON "TrainingExample"("format", "createdAt");

-- CreateIndex
CREATE INDEX "TrainingExample_source_idx" ON "TrainingExample"("source");

-- CreateIndex
CREATE INDEX "UserFeedback_conversationId_idx" ON "UserFeedback"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolDefinitionRecord_name_key" ON "ToolDefinitionRecord"("name");

