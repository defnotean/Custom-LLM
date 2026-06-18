import type { Prisma, PrismaClient } from "@prisma/client";
import { toJsonValue } from "../../types/common";

export interface ReviewedFeedbackPreferenceRow {
  id: string;
  conversationId: string;
  userId: string | null;
  rating: number | null;
  feedbackText: string | null;
  prompt: string;
  chosen: string;
  rejected: string;
  reviewed: boolean;
  metadataJson: unknown;
  createdAt: Date;
}

export interface CreateFeedbackPreferenceInput {
  conversationId: string;
  userId?: string | null;
  rating?: number | null;
  feedbackText?: string | null;
  preferredResponse: string;
  rejectedResponse: string;
  reviewed?: boolean;
  metadataJson?: Record<string, unknown>;
}

export class UserFeedbackRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createPreferencePair(input: CreateFeedbackPreferenceInput): Promise<string> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { id: true },
    });
    if (!conversation) throw new Error(`Conversation not found for feedback: ${input.conversationId}`);

    const row = await this.prisma.userFeedback.create({
      data: {
        conversationId: input.conversationId,
        userId: input.userId ?? null,
        rating: input.rating ?? null,
        feedbackText: input.feedbackText ?? null,
        preferredResponse: input.preferredResponse,
        rejectedResponse: input.rejectedResponse,
        reviewed: input.reviewed ?? false,
        metadataJson: toJsonValue(input.metadataJson ?? {}) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  }

  async listReviewedPreferencePairs(limit = 100_000): Promise<ReviewedFeedbackPreferenceRow[]> {
    const rows = await this.prisma.userFeedback.findMany({
      where: {
        reviewed: true,
        preferredResponse: { not: null },
        rejectedResponse: { not: null },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    const conversationIds = [...new Set(rows.map((row) => row.conversationId))];
    const conversations = await this.prisma.conversation.findMany({
      where: { id: { in: conversationIds } },
      select: { id: true, userMessage: true },
    });
    const prompts = new Map(conversations.map((row) => [row.id, row.userMessage]));

    return rows.flatMap((row) => {
      const prompt = prompts.get(row.conversationId)?.trim();
      const chosen = row.preferredResponse?.trim();
      const rejected = row.rejectedResponse?.trim();
      if (!prompt || !chosen || !rejected || chosen === rejected) return [];
      return [
        {
          id: row.id,
          conversationId: row.conversationId,
          userId: row.userId,
          rating: row.rating,
          feedbackText: row.feedbackText,
          prompt,
          chosen,
          rejected,
          reviewed: row.reviewed,
          metadataJson: row.metadataJson,
          createdAt: row.createdAt,
        },
      ];
    });
  }
}
