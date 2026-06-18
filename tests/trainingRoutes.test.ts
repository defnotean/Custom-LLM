import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTrainingRoutes, type FeedbackPreferenceInput } from "../src/server/routes/training";

describe("training routes", () => {
  it("records explicit reviewed feedback preference pairs", async () => {
    const app = Fastify({ logger: false });
    const calls: FeedbackPreferenceInput[] = [];
    registerTrainingRoutes(app, {
      exportAll: async () => ({ files: [], totalExamples: 0, skipped: 0, feedbackPreferences: 0 }),
      recordFeedbackPreference: async (input) => {
        calls.push(input);
        return "feedback-id";
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/training/feedback/preference",
      payload: {
        conversationId: "conversation-1",
        userId: "user-1",
        rating: 1,
        feedbackText: "The revised answer is better.",
        preferredResponse: "Use pgvector for embeddings in Postgres.",
        rejectedResponse: "Use a random database.",
        reviewed: true,
        metadataJson: { reviewer: "admin" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: "feedback-id", reviewed: true });
    expect(calls).toEqual([
      {
        conversationId: "conversation-1",
        userId: "user-1",
        rating: 1,
        feedbackText: "The revised answer is better.",
        preferredResponse: "Use pgvector for embeddings in Postgres.",
        rejectedResponse: "Use a random database.",
        reviewed: true,
        metadataJson: { reviewer: "admin" },
      },
    ]);
    await app.close();
  });

  it("rejects invalid or fabricated preference pairs", async () => {
    const app = Fastify({ logger: false });
    registerTrainingRoutes(app, {
      exportAll: null,
      recordFeedbackPreference: async () => "unused",
    });

    const response = await app.inject({
      method: "POST",
      url: "/training/feedback/preference",
      payload: {
        conversationId: "conversation-1",
        preferredResponse: "same answer",
        rejectedResponse: "same answer",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid feedback preference" });
    await app.close();
  });

  it("returns unavailable when feedback persistence is not configured", async () => {
    const app = Fastify({ logger: false });
    registerTrainingRoutes(app, { exportAll: null, recordFeedbackPreference: null });

    const response = await app.inject({
      method: "POST",
      url: "/training/feedback/preference",
      payload: {
        conversationId: "conversation-1",
        preferredResponse: "preferred",
        rejectedResponse: "rejected",
      },
    });

    expect(response.statusCode).toBe(503);
    await app.close();
  });

  it("returns not found when the conversation is missing", async () => {
    const app = Fastify({ logger: false });
    registerTrainingRoutes(app, {
      exportAll: null,
      recordFeedbackPreference: async () => {
        throw new Error("Conversation not found for feedback: missing");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/training/feedback/preference",
      payload: {
        conversationId: "missing",
        preferredResponse: "preferred",
        rejectedResponse: "rejected",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "conversation not found" });
    await app.close();
  });
});
