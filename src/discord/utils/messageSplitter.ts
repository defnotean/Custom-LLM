/**
 * Discord caps messages at 2000 chars. Split long replies on natural
 * boundaries (paragraphs → lines → hard cut) and keep code fences balanced
 * across chunks so formatting survives the split.
 */

const MAX_CHUNK = 1900; // headroom under the 2000 limit

export function splitMessage(content: string, maxLength: number = MAX_CHUNK): string[] {
  const text = content.trim();
  if (text.length === 0) return ["(empty response)"];
  if (text.length <= maxLength) return [text];

  const rawChunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n\n", maxLength);
    if (cut < maxLength * 0.3) cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength * 0.3) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < maxLength * 0.3) cut = maxLength;
    rawChunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) rawChunks.push(remaining);

  return balanceCodeFences(rawChunks);
}

function balanceCodeFences(chunks: string[]): string[] {
  const out: string[] = [];
  let openFence: string | null = null;

  for (const chunk of chunks) {
    let current = chunk;
    if (openFence !== null) current = `${openFence}\n${current}`;

    openFence = findUnclosedFence(current);
    if (openFence !== null) current = `${current}\n\`\`\``;

    out.push(current);
  }
  return out;
}

/** Returns the opening fence line (e.g. "```json") if the chunk leaves one open. */
function findUnclosedFence(text: string): string | null {
  const fences = text.match(/^```[^\n]*$/gm) ?? [];
  if (fences.length % 2 === 0) return null;
  const last = fences[fences.length - 1];
  return last && last.length > 3 ? last : "```";
}
