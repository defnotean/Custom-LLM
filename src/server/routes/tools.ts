import type { FastifyInstance } from "fastify";
import type { ToolRegistry } from "../../tools/ToolRegistry";

export function registerToolRoutes(app: FastifyInstance, registry: ToolRegistry): void {
  app.get("/tools", async (request) => {
    const { q } = request.query as { q?: string };
    const metadata = registry.exportToolMetadata();
    if (q && q.trim().length > 0) {
      const matched = new Set(registry.searchTools(q, { limit: 25 }).map((t) => t.name));
      return { count: matched.size, tools: metadata.filter((m) => matched.has(m.name)) };
    }
    return { count: metadata.length, tools: metadata };
  });

  app.get("/tools/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const meta = registry.exportToolMetadata().find((m) => m.name === name);
    if (!meta) {
      return reply.status(404).send({ error: `tool "${name}" not found` });
    }
    return meta;
  });
}
