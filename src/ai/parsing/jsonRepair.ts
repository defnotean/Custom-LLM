/**
 * Helpers for extracting and repairing JSON from LLM output. Local models
 * frequently wrap JSON in code fences, prepend prose, or emit small syntax
 * errors — we recover what we safely can and never throw.
 */

/** Strip markdown code fences (```json ... ```). */
export function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1] !== undefined) return fenced[1].trim();
  return text.trim();
}

/**
 * Extract the first balanced top-level JSON object from text, respecting
 * strings and escape sequences. Returns null when no object is found.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Try a sequence of progressively more aggressive repairs. Null if hopeless. */
export function tryParseJsonWithRepair(candidate: string): unknown | null {
  const attempts: string[] = [candidate];

  // Smart quotes → ASCII quotes.
  attempts.push(candidate.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));

  // Trailing commas before } or ].
  attempts.push(candidate.replace(/,\s*([}\]])/g, "$1"));

  // Both of the above.
  attempts.push(
    candidate
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1"),
  );

  // Python-style literals.
  attempts.push(
    candidate
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null"),
  );

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      // try next repair
    }
  }
  return null;
}

/**
 * Full pipeline: fence-strip → extract first object → parse with repair.
 * Returns the parsed value plus the extracted snippet (for training logs).
 */
export function extractAndParseJson(
  text: string,
): { value: unknown; extracted: string } | null {
  const cleaned = stripCodeFences(text);
  const candidate = extractFirstJsonObject(cleaned) ?? extractFirstJsonObject(text);
  if (!candidate) return null;
  const value = tryParseJsonWithRepair(candidate);
  if (value === null) return null;
  return { value, extracted: candidate };
}
