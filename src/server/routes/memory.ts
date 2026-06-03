import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryHit } from "../../types/ai";

export interface MemoryRouteDeps {
  search:
    | ((query: string, ctx: { userId: string; guildId: string | null; channelId: string }, topK?: number) => Promise<MemoryHit[]>)
    | null;
}

const querySchema = z.object({
  q: z.string().min(1),
  userId: z.string().default("api"),
  guildId: z.string().optional(),
  channelId: z.string().default("api"),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRouteDeps): void {
  app.get("/memory/search", async (request, reply) => {
    if (!deps.search) {
      return reply.status(503).send({ error: "memory system disabled" });
    }
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "bad query" });
    }
    const { q, userId, guildId, channelId, limit } = parsed.data;
    const hits = await deps.search(q, { userId, guildId: guildId ?? null, channelId }, limit);
    return { query: q, count: hits.length, hits };
  });
}
