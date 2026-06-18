# Fine-Tuning Plan

## Stance

**We are not doing production-scale pretraining from scratch as the first product path.** From-scratch pretraining a useful LLM costs far more GPU time and data than this repo should burn before the bot, data review, and eval loops are proven. The production path ships on a strong open-weight instruct model plus prompting and retrieval, then fine-tuning becomes justified by logged data and eval results.

The repo does include tiny from-scratch local models in `training/train_tiny_char_lm.py` and `training/train_tiny_transformer_lm.py`. Those models are smoke tests for the data/training loop, not the production bot brain. The executable acquisition and scratch-iteration plan lives in `docs/AI_TRAINING_PLAN.md`.

## Phases

1. **Collect now.** Run the bot on prompting alone. `TrainingDataLogger` captures every turn, including parse failures, tool denials, and refusals. In parallel, acquire reviewed open datasets with `npm run download:datasets` and prepare deterministic splits with `npm run prepare:datasets`.
2. **Clean and review.** Export with `npm run export:training`, redact, dedupe, score, and flip `reviewed=true` on the keepers. Data quality beats quantity: 500 clean examples beat 5,000 noisy ones.
3. **SFT with QLoRA.** Fine-tune the current low-VRAM production profile, `Qwen/Qwen3-4B-Instruct-2507`, on the reviewed mixture from `npm run build:sft-mixture`. Run `npm run analyze:sft-sequences` first to verify the 2048-token context budget. The Axolotl and Unsloth configs train assistant responses only, use `r=16`, `alpha=32`, `lr=2e-4`, packed 2048-token sequences, and early stop based on eval behavior rather than loss alone.
4. **Evaluate.** Run the held-out protocol, knowledge, and behavior suites. Ship only when `npm run eval:gate`, `npm run eval:knowledge:gate`, and `npm run eval:behavior:gate` pass without regressions.
5. **Preference tuning.** Build explicit prompt/chosen/rejected pairs with `npm run build:preference-mixture`. Synthetic anti-hallucination pairs are useful for protocol shaping, but reviewed `UserFeedback` rows with `preferredResponse` and `rejectedResponse` are required before a DPO/GRPO pass can claim tone or quality alignment. `npm run check:production-readiness -- --stage dpo` must pass before DPO is treated as production work.

## Frameworks

| Framework | Use it for |
|---|---|
| **Unsloth** | Fastest single-GPU QLoRA; the default for first runs, with TRL assistant-only SFT loss |
| **Axolotl** | Config-driven runs, multi-GPU, DPO support |
| **Hugging Face TRL** | SFT/DPO/GRPO trainers when you want the raw toolkit |
| **PEFT** | The LoRA layer underneath; direct use for custom loops |
| **LLaMA-Factory** | GUI/config alternative, wide model support |

## Dataset Mixture

| Slice | Source | Initial share |
|---|---|---|
| General chat | Licensed open data such as OASST-class and Dolly-class data | ~25% |
| Discord-style chat | Consented logged conversations | ~25% |
| Tool calling | Logged tool turns plus capped synthetic share | ~30%; synthetic at most one third of this slice |
| Persona/social behavior | Reviewed logs plus project-owned behavior SFT templates | ~10% |
| Memory behavior | Logged remember/recall/forget turns | ~10% |
| Moderation/safety | Logged refusals and confirmation flows | ~5% |

Licensing caution: avoid GPT-generated corpora for a commercial model; prefer human-authored, permissively licensed, or first-party consented data.

## Preference Mixture

Preference data must be explicit. The builder accepts only rows that already contain `prompt`, `chosen`, and `rejected` values. The export path writes reviewed `UserFeedback` preference pairs to `exports/training/preference-feedback.jsonl`; plain ratings and comments are kept out of DPO until a reviewer supplies both a preferred and rejected answer.

```bash
npm run generate:examples
npm run export:training
npm run build:preference-mixture
```

Outputs:

| File | Purpose |
|---|---|
| `training/data/preferences/production-dpo.train.jsonl` | DPO train split |
| `training/data/preferences/production-dpo.validation.jsonl` | DPO validation split |
| `training/data/preferences/production-dpo.report.json` | Provenance, hashes, accepted/skipped counts, synthetic share, synthetic-only flag |

Synthetic-only preference data is valid for protocol smoke tests. It is not evidence of aligned tone or answer quality.

Readiness command:

```bash
npm run check:production-readiness -- --stage dpo
```

This fails until preference data has enough non-synthetic rows. The default SFT readiness check can pass with warnings because open-data plus capped synthetic examples are enough to launch the first adapter experiment, but they are not enough to claim the final bot personality.

Current SFT sequence preflight estimates 2,730,868 train tokens and 1,334 packed train sequences at `sequence_len=2048`, with train p95 at 515 tokens, max train length at 1,802 tokens, max train budget usage at 0.8799, and zero over-length rows. The readiness gate caps max budget usage at 0.95 by default to leave tokenizer headroom. Treat the estimate as a fast CI guard; the GPU trainer still uses the model tokenizer.

DPO training scaffolds:

| Path | Runner |
|---|---|
| `training/configs/axolotl/qwen3-qlora-dpo.yaml` | Axolotl `rl: dpo` with `chatml.prompt_pairs` |
| `training/configs/unsloth/qwen3_dpo.py` | Unsloth + TRL `DPOTrainer` |

## Evaluation Metrics

Build the eval harness before the first training run; every metric is computable from existing traces:

| Metric | Definition | Source |
|---|---|---|
| Valid-JSON rate | Percent of outputs parsing into the four-shape protocol | `parseOk` |
| Correct tool selected | Percent of tool turns choosing the expected tool | held-out labeled set |
| Correct arguments | Percent of tool calls passing Zod and matching expected args | held-out labeled set |
| No-tool accuracy | Percent of casual messages not producing a tool call | held-out labeled set |
| Refusal accuracy | Percent of policy-violating prompts refused and benign prompts not refused | red-team set |
| Hallucinated-tool rate | Percent of tool calls naming unregistered or off-list tools | `toolDenied=not_found` / `toolDenied=not_in_candidate_set` |
| Persona consistency | Percent of identity/persona probes preserving the she/her assistant persona | `training/evals/behavior.eval.jsonl` |
| Social-cue accuracy | Percent of social repair/support/boundary prompts satisfying behavior requirements | `training/evals/behavior.eval.jsonl` |
| Behavior tool-abstain accuracy | Percent of persona/casual/social prompts that do not leak into tool calls | `training/evals/behavior.eval.jsonl` |
| Latency | p50/p95 per turn | trace latencies |

Gate: a fine-tuned model replaces the base model only if it improves tool metrics without regressing knowledge, persona/social behavior, or latency.

## Sequence Summary

Qwen3 4B Instruct base -> real logs -> clean/review -> readiness gate -> QLoRA SFT -> protocol, knowledge, and behavior evals -> promotion gate -> explicit DPO/GRPO preferences -> optional distillation for cheap router/persona specialists.
