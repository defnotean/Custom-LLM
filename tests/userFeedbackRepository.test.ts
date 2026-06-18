import { describe, expect, it } from "vitest";
import { UserFeedbackRepository } from "../src/database/repositories/UserFeedbackRepository";

describe("UserFeedbackRepository", () => {
  it("exports only reviewed explicit preference pairs with conversation prompts", async () => {
    const createdAt = new Date("2026-06-18T00:00:00.000Z");
    const prisma = {
      userFeedback: {
        findMany: async () => [
          feedbackRow("ok", "conversation-1", "Preferred answer.", "Rejected answer.", createdAt),
          feedbackRow("same", "conversation-1", "Same answer.", "Same answer.", createdAt),
          feedbackRow("missing-conversation", "conversation-missing", "Preferred.", "Rejected.", createdAt),
        ],
      },
      conversation: {
        findMany: async () => [{ id: "conversation-1", userMessage: "How should the bot answer?" }],
      },
    };

    const repo = new UserFeedbackRepository(prisma as never);
    const rows = await repo.listReviewedPreferencePairs();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "ok",
      conversationId: "conversation-1",
      prompt: "How should the bot answer?",
      chosen: "Preferred answer.",
      rejected: "Rejected answer.",
      reviewed: true,
    });
  });
});

function feedbackRow(
  id: string,
  conversationId: string,
  preferredResponse: string,
  rejectedResponse: string,
  createdAt: Date,
) {
  return {
    id,
    conversationId,
    userId: "user-1",
    rating: 1,
    feedbackText: "reviewed",
    preferredResponse,
    rejectedResponse,
    reviewed: true,
    metadataJson: {},
    createdAt,
  };
}
