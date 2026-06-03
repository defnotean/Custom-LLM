# Training Data Pipeline

Every interaction the bot handles is captured with full fidelity so it can become fine-tuning data later. This is the asset the whole project compounds on.

## What gets logged

`TrainingDataLogger` writes two rows per handled message (when the DB is up and `TRAINING_LOGGING_ENABLED=true`):

1. **Conversation** — the user-facing exchange (message, reply, metadata).
2. **TrainingExample** — the full trace:
   - `inputJson`: system prompt **version + full text**, user message, recent transcript, retrieved memories, candidate tools shown, router verdict, ids.
   - `outputJson`: raw model output, parse success, parsed action, tool call + real tool result, denial reason if gated, final response, errors, latencies, model name.
   - `qualityScore`: heuristic 0–1 (`EvaluationAgent`) used as an export filter; **not** a substitute for review.
   - `reviewed`: defaults false — flip after human review.

Parse failures and tool denials are logged too: failure data is signal (format-following negatives, refusal training).

## Export formats (`npm run export:training`)

Writes to `exports/training/`:

| File | Shape | Use |
|---|---|---|
| `chatml.jsonl` | `{"messages":[{system},{user},{assistant}]}` | SFT for conversational turns |
| `alpaca.jsonl` | `{"instruction","input","output"}` | Alpaca-style configs |
| `tool-calling.jsonl` | system → user → assistant(`tool_call` JSON) → tool(result) → assistant(final) | SFT for tool selection + argument filling |
| `dpo-placeholder.jsonl` | `{"prompt","chosen","rejected"}` | Preference tuning (DPO) |

Export filters (current defaults): `qualityScore >= 0.3`; conversational turns with `parseOk: false` are excluded from SFT (we don't teach format violations); rows missing user/assistant text are skipped.

**DPO honesty note:** real preference pairs need human feedback. The `UserFeedback` table exists for it (👍/👎 reaction capture is a TODO). Today the only pairs exported are synthetic (valid tool call vs hallucinated tool name) from the generator below — useful for anti-hallucination, clearly tagged, never fabricated from thin air.

## Synthetic examples (`npm run generate:examples`)

`ToolExampleGenerator` derives deterministic template examples from the live registry — per tool: direct request, casual phrasing, missing-argument → clarification, permission-denied refusal, success, failure, confirmation-request (gated tools), plus a DPO pair; plus global no-tool chat cases. No external APIs, no randomness. Output: `exports/training/synthetic-tools.jsonl` + DB rows (source=SYNTHETIC) when available.

Synthetic data teaches *format*, not *judgment*. Cap its share of any training mixture (see FINE_TUNING_PLAN.md).

## Review workflow (before any training run)

1. Export → sample-read each file.
2. Redact/drop anything sensitive (the MemoryPolicy blocks secrets from *memory*, but raw user messages in traces can still contain anything).
3. Flip `reviewed=true` on vetted rows; train only on reviewed slices once volume allows.
4. Hold out an eval slice (never train on it) for the metrics in FINE_TUNING_PLAN.md.

## Privacy & compliance (read this one twice)

- Discord's Developer Policy prohibits using Discord message content to train ML models without permission. **Use logs only from servers you control, with explicit member consent and a posted privacy policy.** Do not scrape.
- Honor deletion requests end-to-end: Conversation/TrainingExample rows, memories, and any exported files.
- Secrets: never logged into memory by policy; traces are raw — treat the DB and exports as sensitive data stores.
