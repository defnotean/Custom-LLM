# Fine-Tuning Plan

## Stance

**We are not training a model from scratch — first or ever.** From-scratch pretraining costs millions of GPU-hours; everything language-shaped is already in open-weight instruct models. We also do not fine-tune as step one: the platform ships on a strong open-weight instruct model + prompting + retrieval (memory, tool routing), and fine-tuning is a *deferred optimization* that begins only when logged data and eval results justify it.

## Phases

1. **Collect (now).** Run the bot on prompting alone. `TrainingDataLogger` captures every turn — including parse failures, tool denials, and refusals. Target: thousands of real interactions across chat, tool use, memory behavior, and moderation.
2. **Clean & review.** Export (`npm run export:training`), redact, dedupe, score, flip `reviewed=true` on the keepers. Data quality beats quantity — 500 clean examples beat 5,000 noisy ones.
3. **SFT with QLoRA.** Fine-tune a 7–14B open-weight base (Qwen-class first choice) on the reviewed mixture. QLoRA fits a 7B in ~8–10 GB VRAM; starting hyperparameters `r=16, alpha=16, lr=2e-4`, 1–3 epochs, early-stop on the eval set.
4. **Evaluate** against the held-out set (metrics below) + the live regression suite. Ship only on measurable wins.
5. **Preference tuning (later).** Collect 👍/👎 feedback (`UserFeedback`) → DPO (or GRPO) pass for tone/safety preferences once SFT is stable.

## Frameworks

| Framework | Use it for |
|---|---|
| **Unsloth** | Fastest single-GPU QLoRA; the default for first runs |
| **Axolotl** | Config-driven runs, multi-GPU, DPO support |
| **Hugging Face TRL** | SFT/DPO/GRPO trainers when you want the raw toolkit |
| **PEFT** | The LoRA layer underneath; direct use for custom loops |
| **LLaMA-Factory** | GUI/config alternative, wide model support |

## Dataset mixture (target shape)

| Slice | Source | Share (initial) |
|---|---|---|
| General chat | Licensed open data (OASST-class) to preserve generality | ~25% |
| Discord-style chat | Our own logged conversations (consented) | ~25% |
| Tool calling | Logged tool turns + capped synthetic share | ~30% (synthetic ≤ ⅓ of slice) |
| Memory behavior | Logged remember/recall/forget turns | ~10% |
| Moderation/safety | Logged refusals + confirmation flows | ~10% |

Licensing caution (see the research doc): avoid GPT-generated corpora for a commercial model; prefer human-authored (OASST, Dolly) or permissively-licensed tool data (TOUCAN, xLAM) and your own consented logs.

## Evaluation metrics

Build the eval harness *before* the first training run; every metric is computable from existing traces:

| Metric | Definition | Source |
|---|---|---|
| Valid-JSON rate | % outputs parsing into the 4-shape protocol | `parseOk` |
| Correct tool selected | % tool turns choosing the expected tool | held-out labeled set |
| Correct arguments | % tool calls passing Zod + matching expected args | held-out labeled set |
| No-tool accuracy | % casual messages NOT producing a tool call | held-out labeled set |
| Refusal accuracy | % policy-violating prompts refused / benign not refused | red-team set |
| Hallucinated-tool rate | % tool calls naming unregistered tools | `toolDenied=not_found` |
| Latency | p50/p95 per turn | trace latencies |

Gate: a fine-tuned model replaces the base model only if it improves tool metrics without regressing chat quality (LLM-as-judge rubric + human spot checks) or latency.

## Sequence summary

Open-weight base → real logs → clean/review → QLoRA SFT → eval tool-call accuracy → DPO/GRPO on preferences → (optionally) distill a small router/persona model for the cheap path.
