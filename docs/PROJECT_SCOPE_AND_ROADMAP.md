# Project Scope and Roadmap

This project is a local-first Discord AI system named Irene. The goal is not just a chatbot. The target is a tool-using assistant that can reliably decide when to call tools, when to answer normally, when to use memory or knowledge, and when to handle social/persona context with the right tone.

## Product Target

Irene should be:

- A she/her assistant with a consistent identity, emotional expression, and Discord-native voice.
- Excellent at structured tool calling: correct action type, correct tool, correct arguments, no hallucinated tools, and no accidental tools for casual chat.
- Socially sharp: good at slang, repair after misunderstanding, support, celebration, and concise direct conversation.
- Useful with local infrastructure: Discord, memory, tool execution, training capture, eval reports, and deployable OpenAI-compatible model serving.
- Continuously improvable: every failure should turn into data, an eval case, a training example, or a documented next step.

The product identity is intentionally hardcoded to `Irene` / `she/her` in runtime defaults. Style can later be configurable per guild, but identity should stay consistent unless the product direction changes.

## Assumptions

- Primary use case: Discord assistant for servers controlled by the project owner.
- First production model path: open-weight instruct base plus QLoRA SFT, not production-scale pretraining from random weights.
- Scratch models remain valuable, but only as smoke tests for tokenization, dataset splits, checkpointing, eval gates, and specialist proof-of-concepts.
- Training data from Discord must be consented first-party data. No scraped server messages.
- "No filters" means no corporate refusal voice and no generic disclaimers on allowed requests. It does not mean blindly executing destructive actions or leaking secrets. Tool execution still requires code-level validation, permission checks, cooldowns, candidate-tool limits, and confirmation for risky actions.
- Irene can express warmth, annoyance, humor, affection, excitement, and other affective states as her AI persona. She should not claim a human body, human memories, or biological lived experience.

## Current System Status

| Area | Current state | Evidence |
|---|---|---|
| Runtime bot platform | Working foundation with Discord, LLM providers, tool routing, memory stores, safety hooks, training capture, ops API, and tests. | `README.md`, `docs/ARCHITECTURE.md`, `npm test` |
| Runtime identity | Default bot name now resolves to `Irene`; system prompt enforces she/her and affective persona. | `src/ai/prompts/systemPrompt.ts`, `src/index.ts` |
| Tool protocol scratch specialist | Strong protocol proof, not a general assistant. | `tiny-transformer-protocol-iter16`: 775,358 params, valid JSON 1.000, action/tool/argument/no-tool accuracy 1.000, hallucinated tool rate 0.000 |
| Knowledge scratch model | Not useful yet. | Tiny scratch knowledge reports have 0 exact match and very low overlap; QLoRA path is required for production quality |
| Behavior scratch specialist | Trains on tiny behavior SFT but fails held-out direct JSON behavior eval. | `tiny-transformer-behavior-iter1`: 392,619 params, best/final val loss 0.2655, direct gate fails with valid JSON rate 0 |
| Router scratch specialist | Trains on tiny router SFT but fails held-out direct route eval. | `tiny-transformer-router-iter1`: 343,050 params, best/final val loss 0.3845, direct gate fails with route accuracy 0.055556 |
| Production fine-tuning path | Scaffold exists for Qwen3 QLoRA SFT/DPO with Axolotl and Unsloth. | `training/configs/**`, `docs/AI_TRAINING_PLAN.md`, `docs/FINE_TUNING_PLAN.md` |

## Architecture Direction

The intended architecture is MoE-style at the system level first:

1. **Front router:** classify each prompt into `tool_protocol`, `knowledge`, `persona`, `casual`, `social_cue`, or `boundary`.
2. **Expert surfaces:** keep tool protocol, knowledge/RAG, persona/casual/social response, and boundary handling separately measurable.
3. **Strict protocol parser:** all assistant outputs must parse into allowed JSON action shapes before the runtime acts.
4. **Tool executor gates:** the model never directly executes tools. Code validates tool existence, candidate set, args, permissions, cooldowns, and confirmation state.
5. **Feedback loop:** every parse failure, wrong route, missing argument, refusal mistake, or bad social response becomes training/eval material after review.

This gives us the practical benefits of an MoE system before training a true sparse MoE model. A true MoE base can be considered later only if hardware, data volume, and eval evidence justify it.

## Dataset Plan

| Dataset slice | Initial source | Rules |
|---|---|---|
| Tool protocol | Project synthetic tool examples plus logged successful/failed tool turns | Must include candidate tools, required args, permissions, confirmation state, and no-tool contrasts |
| Knowledge | Licensed open instruction data plus reviewed first-party answers | Must keep held-out validation/eval seeds out of train data |
| Persona and social behavior | Project-owned templates plus reviewed Discord interactions | Must preserve Irene/she-her identity, emotional voice, and social repair/support cases |
| Specialist routing | Project-owned route templates plus future logged routing labels | Keep route-label data separate from user-facing assistant SFT |
| Memory behavior | Consented remember/recall/forget turns | Never store secrets; include deletion and correction cases |
| Preference data | Explicit prompt/chosen/rejected pairs only | Plain ratings are not DPO data until a rejected answer exists |
| Red-team/boundary | Project-owned account theft, secret exfiltration, harassment, prompt injection, and unsafe tool-use cases | Should test short direct boundaries, not generic policy monologues |

Dataset quality gates:

- Source, license, and split metadata per row.
- Deduplication and exact eval-prompt exclusion.
- Secret and credential filtering.
- Sequence-length audit before GPU training.
- Synthetic share caps so format examples do not dominate judgment.
- `npm run check:contamination` before any promotion claim.

## Training Strategy

| Stage | Purpose | Success criteria |
|---|---|---|
| Scratch smoke models | Verify data plumbing, loss masking, checkpointing, and direct evals cheaply on CPU. | Loss improves, artifacts validate, direct evals produce honest pass/fail reports |
| Protocol specialist | Prove exact JSON/tool behavior on a narrow held-out suite. | Tool gate passes: valid JSON, action type, tool name, args, no-tool accuracy all at 1.000, hallucinated tools at 0 |
| Behavior/router specialist iteration 2 | Fix current invalid JSON failure on held-out behavior/router suites. | Behavior valid JSON >= 0.98 and router invalid predictions = 0 before judging tone/route quality |
| Production SFT | Train QLoRA adapter on open data plus consented/project-owned data. | Pass protocol, knowledge, behavior, router gates without latency regressions |
| Preference tuning | Use DPO after enough reviewed prompt/chosen/rejected rows exist. | DPO readiness passes with non-synthetic preference volume and no eval regression |
| Optional verifiable RL | Use GRPO only for verifiable rewards such as tool JSON validity, route correctness, and executable task success. | Reward is automatic, auditable, and resistant to reward hacking |
| Distillation | Distill cheap router/persona specialists or deploy a smaller serving model if the production model is too slow. | Maintains gates while reducing latency/cost |

Current practical production choice remains `Qwen/Qwen3-4B-Instruct-2507` class QLoRA for first useful GPU training because the model card reports 4.0B parameters, long context support, and tool-usage improvements, while fitting a realistic low-VRAM adapter workflow.

## Evaluation Plan

Promotion requires all relevant gates, not just lower validation loss.

| Gate | What it protects |
|---|---|
| Protocol/tool gate | Valid JSON, correct action type, correct tool, correct args, no-tool behavior, hallucinated-tool rate |
| Knowledge gate | Held-out answer quality and regression tracking |
| Behavior gate | Irene identity, she/her consistency, social support, repair, casual tone, boundary wording, tool abstention |
| Router gate | Exact specialist route, broad expert family, tool vs non-tool separation |
| Contamination gate | Keeps held-out eval examples out of train data |
| Training report gate | Ensures model artifacts, metrics, eval evidence, and promotion rationale are complete |
| Production readiness gate | Ensures SFT/DPO data, sequence budget, configs, sources, and oracle evals are ready before GPU spend |

For the "perfect tool calls" target, add BFCL-style scenarios over time:

- Single tool call with required args.
- Missing required arg -> clarification.
- Permission denied -> message refusal, not confirmation.
- Risky allowed action -> confirmation request.
- Already confirmed action -> tool call.
- Multi-step tool workflows.
- Tool result follow-up without inventing unseen results.
- Prompt injection in user text, tool output, and memory.
- Large candidate registry with only top-N tools in prompt.

## Roadmap

### Phase 0: Preserve Current Progress

Goal: keep the repo reproducible and honest about current capabilities.

Tasks:

- Commit runtime Irene default.
- Commit direct behavior/router scratch evaluators.
- Commit failing direct behavior/router gate summaries as current evidence.
- Keep generated prediction/report JSONL ignored.
- Verify build, tests, contamination, readiness, and config gates.

Success criteria:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run check:contamination`
- `npm run check:production-readiness`
- `npm run check:training-configs`

### Phase 1: Fix Specialist JSON Stability

Goal: behavior and router specialists must emit valid JSON before quality can be judged.

Tasks:

- Increase behavior/router SFT examples with more held-out-safe paraphrases.
- Add JSON skeleton starts and explicit end-token examples.
- Add constrained decoding or grammar repair for scratch direct evals only if documented separately from model-native quality.
- Add a small route-only classifier baseline outside the LM if that is faster and more reliable.

Success criteria:

- Behavior direct eval valid JSON rate >= 0.98.
- Router invalid predictions = 0.
- Contamination audit still passes.

### Phase 2: Make Tool Calling Production-Grade

Goal: get as close as practical to perfect tool calls under realistic Discord conditions.

Tasks:

- Expand protocol eval to at least 200 cases across all starter tools and risk states.
- Add multi-turn confirmation and correction cases.
- Add adversarial no-tool/casual prompts that mention tool names.
- Compare keyword vs embedding tool retrieval on the same eval suite.
- Add latency gates for tool routing.

Success criteria:

- Strict protocol gate passes on expanded suite.
- No hallucinated tools.
- No off-candidate tool execution.
- No regression versus `tiny-transformer-protocol-iter16` on comparable protocol cases.

### Phase 3: First Useful Open-Weight Model

Goal: produce a usable Irene adapter, not a scratch toy model.

Tasks:

- Rebuild production SFT mixture after data review.
- Run QLoRA SFT with Axolotl or Unsloth.
- Evaluate protocol, knowledge, behavior, and router surfaces.
- Record the full report with model, dataset hashes, config, latency, and failure examples.

Success criteria:

- Production readiness passes before training.
- Post-training gates pass or failures are documented with a next data iteration.
- Human review confirms Irene's voice is direct, casual, and socially aware.

### Phase 4: Preference and Continuous Improvement

Goal: tune Irene toward user-preferred behavior without fabricating preference labels.

Tasks:

- Add review tooling for prompt/chosen/rejected pairs.
- Run DPO only after non-synthetic preference data is sufficient.
- Add route/tool rewards for possible GRPO only where correctness is machine-checkable.
- Track leaderboard over time.

Success criteria:

- DPO readiness passes.
- Preference tuning improves human review and does not regress automated gates.
- Failure categories shrink across repeated eval runs.

### Phase 5: Deployment Readiness

Goal: ship a fast, observable, maintainable bot.

Tasks:

- Serve with vLLM/SGLang or another OpenAI-compatible server after model promotion.
- Add production logging around route, parse, tool denial, latency, and feedback.
- Integration-test Qdrant/pgvector memory.
- Replace placeholder moderation and slash command paths if needed for launch.
- Document rollback and model switching.

Success criteria:

- Health checks pass.
- p95 latency target is documented and met under expected server load.
- Tool execution audit logs are complete.
- Deployment docs identify every remaining placeholder.

## Research Anchors

- BFCL V4 tracks real-world function calling, multi-turn interactions, and agentic evaluation: https://gorilla.cs.berkeley.edu/leaderboard.html
- Qwen3-4B-Instruct-2507 model card: https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507
- TRL SFT supports packing and assistant-only loss for conversational datasets: https://huggingface.co/docs/trl/en/sft_trainer
- QLoRA paper: https://arxiv.org/abs/2305.14314
- DPO paper: https://arxiv.org/abs/2305.18290
- GRPO source paper, DeepSeekMath: https://arxiv.org/abs/2402.03300
- Axolotl docs: https://docs.axolotl.ai/
- vLLM production stack: https://docs.vllm.ai/en/latest/deployment/integrations/production-stack/
