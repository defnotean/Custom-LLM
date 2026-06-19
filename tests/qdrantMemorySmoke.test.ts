import { describe, expect, it } from "vitest";
import { runQdrantMemorySmoke } from "../src/memory/QdrantMemorySmoke";
import { testLogger } from "./helpers";

describe("QdrantMemorySmoke", () => {
  it("passes collection, scoped memory search, lookup, delete, and cleanup checks", async () => {
    const fake = new FakeQdrant();

    const report = await runQdrantMemorySmoke({
      url: "http://qdrant.test",
      collection: "irene_smoke_test",
      dims: 32,
      logger: testLogger,
      fetchImpl: fake.fetch,
    });

    expect(report.status).toBe("pass");
    expect(report.checks.map((check) => check.id)).toEqual([
      "qdrant-collection-init",
      "qdrant-memory-write-search",
      "qdrant-scope-isolation",
      "qdrant-point-lookup-delete",
      "qdrant-smoke-cleanup",
    ]);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(fake.collections()).toEqual([]);
  });
});

interface PointRecord {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

class FakeQdrant {
  private readonly store = new Map<string, Map<string, PointRecord>>();

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const collection = collectionFromPath(path);

    if (method === "PUT" && /^\/collections\/[^/]+$/.test(path)) {
      this.store.set(collection, this.store.get(collection) ?? new Map());
      return jsonResponse({ result: true });
    }

    if (method === "DELETE" && /^\/collections\/[^/]+$/.test(path)) {
      const existed = this.store.delete(collection);
      return jsonResponse({ result: existed }, existed ? 200 : 404);
    }

    if (method === "PUT" && path.endsWith("/points")) {
      const body = parseBody<{ points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> }>(
        init,
      );
      const points = this.collection(collection);
      for (const point of body.points) {
        points.set(String(point.id), {
          id: String(point.id),
          vector: point.vector,
          payload: point.payload,
        });
      }
      return jsonResponse({ result: { operation_id: 1, status: "completed" } });
    }

    if (method === "POST" && path.endsWith("/points/search")) {
      const body = parseBody<{
        vector: number[];
        limit: number;
        filter?: { should?: unknown[] };
      }>(init);
      const result = [...this.collection(collection).values()]
        .filter((point) => matchesFilter(point.payload, body.filter))
        .map((point) => ({
          id: point.id,
          score: cosine(point.vector, body.vector),
          payload: point.payload,
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, body.limit);
      return jsonResponse({ result });
    }

    if (method === "POST" && path.endsWith("/points/delete")) {
      const body = parseBody<{ points: string[] }>(init);
      const points = this.collection(collection);
      for (const id of body.points) points.delete(String(id));
      return jsonResponse({ result: { operation_id: 2, status: "completed" } });
    }

    if (method === "POST" && path.endsWith("/points/count")) {
      return jsonResponse({ result: { count: this.collection(collection).size } });
    }

    if (method === "POST" && path.endsWith("/points")) {
      const body = parseBody<{ ids: string[] }>(init);
      const points = this.collection(collection);
      return jsonResponse({
        result: body.ids.flatMap((id) => {
          const point = points.get(String(id));
          return point ? [{ id: point.id, payload: point.payload }] : [];
        }),
      });
    }

    return jsonResponse({ status: { error: `unsupported ${method} ${path}` } }, 500);
  };

  collections(): string[] {
    return [...this.store.keys()].sort();
  }

  private collection(name: string): Map<string, PointRecord> {
    const existing = this.store.get(name);
    if (existing) return existing;
    const created = new Map<string, PointRecord>();
    this.store.set(name, created);
    return created;
  }
}

function parseBody<T>(init: RequestInit | undefined): T {
  return JSON.parse(String(init?.body ?? "{}")) as T;
}

function collectionFromPath(path: string): string {
  const [, collections, collection] = path.split("/");
  if (collections !== "collections" || !collection) throw new Error(`bad qdrant path: ${path}`);
  return decodeURIComponent(collection);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function matchesFilter(payload: Record<string, unknown>, filter: { should?: unknown[] } | undefined): boolean {
  if (!filter?.should || filter.should.length === 0) return true;
  return filter.should.some((condition) => matchesCondition(payload, condition));
}

function matchesCondition(payload: Record<string, unknown>, condition: unknown): boolean {
  if (!isRecord(condition)) return false;
  if (typeof condition.key === "string" && isRecord(condition.match)) {
    return payload[condition.key] === condition.match.value;
  }
  if (Array.isArray(condition.must)) return condition.must.every((item) => matchesCondition(payload, item));
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}
