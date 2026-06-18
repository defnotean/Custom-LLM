import { createHash } from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import { LLMProviderError, toErrorMessage } from "../utils/errors";
import { l2Normalize } from "../utils/vectorMath";

/**
 * Embedding abstraction for memory and embedding-based tool routing. Two
 * implementations:
 *
 *  - OpenAICompatibleEmbeddingProvider — real semantic embeddings from any
 *    /v1/embeddings endpoint (Ollama with nomic-embed-text, vLLM, etc).
 *  - HashingEmbeddingProvider — deterministic character-trigram hashing.
 *    NOT semantic: it only matches lexically-similar text. It exists so
 *    tests and offline dev work without a model server. Honest limitation,
 *    documented in docs/LOCAL_LLM_SETUP.md.
 */

export interface EmbeddingProvider {
  readonly name: string;
  /** Dimensions; -1 until known (resolved on first call for remote providers). */
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

const embeddingsResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })).min(1),
});

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  private dimsInternal = -1;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    fetchImpl?: typeof fetch;
    logger?: Logger;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? "local";
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.name = `openai-compatible:${this.model}`;
  }

  get dims(): number {
    return this.dimsInternal;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (err) {
      throw new LLMProviderError(
        `Embedding endpoint unreachable at ${this.baseUrl}: ${toErrorMessage(err)}`,
        { cause: err },
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMProviderError(`Embedding endpoint returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const raw: unknown = await res.json();
    const parsed = embeddingsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new LLMProviderError("Unexpected embeddings response shape");
    }
    const vectors = parsed.data.data.map((d) => d.embedding);
    const first = vectors[0];
    if (this.dimsInternal === -1 && first) {
      this.dimsInternal = first.length;
      this.logger?.debug({ dims: this.dimsInternal }, "embedding dimensions resolved");
    }
    return vectors;
  }
}

/** Deterministic offline fallback — lexical, not semantic. */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hashing-trigram (non-semantic fallback)";
  readonly dims: number;

  constructor(dims = 256) {
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dims).fill(0);
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    const padded = `  ${normalized}  `;
    for (let i = 0; i < padded.length - 2; i++) {
      const trigram = padded.slice(i, i + 3);
      const digest = createHash("md5").update(trigram).digest();
      const index = digest.readUInt32BE(0) % this.dims;
      vector[index] = (vector[index] ?? 0) + 1;
    }
    return l2Normalize(vector);
  }
}
