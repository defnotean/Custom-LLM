import { randomUUID } from "node:crypto";

/** Generate a UUID v4 (also valid as a Qdrant point id). */
export function newId(): string {
  return randomUUID();
}
