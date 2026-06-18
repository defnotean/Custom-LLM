# Project Scope and Roadmap

This project is a local-first Discord AI system named Irene. The goal is not just a chatbot. The target is a tool-using assistant that can reliably decide when to call tools, when to answer normally, when to use memory or knowledge, and when to handle social/persona context with the right tone.

## Product Target

Irene should be:

- A she/her assistant with a consistent identity, emotional expression, and Discord-native voice.
- Excellent at structured tool calling: correct action type, correct tool, correct arguments, no hallucinated tools, and no accidental tools for casual chat.
- Socially sharp: good at slang, repair after misunderstanding, support, celebration, and concise direct conversation.
- Useful with local infrastructure: Discord, memory, tool execution, training capture, eval reports, and deployable OpenAI-compatible model serving.
- Present in Discord like a persistent companion: own bot identity, avatar/name/status, typing indicators, text chat, voice-channel join/leave, speech output, and opt-in speech understanding.
- Continuously improvable: every failure should turn into data, an eval case, a training example, or a documented next step.
- Growing over time: persistent memories, learned preferences, skill records, tool traces, eval failures, reviewed interaction data, new adapters, and new experts should survive restarts and feed later training iterations.
- Never a closed door: Irene should be able to learn useful facts, preferences, corrections, and skills while she is running. Restarting her should not be required for ordinary memory or skill growth.

The product identity is intentionally hardcoded to `Irene` / `she/her` in runtime defaults. Style can later be configurable per guild, but identity should stay consistent unless the product direction changes.

## Assumptions

- Primary use case: Discord assistant for servers controlled by the project owner.
- First production model path: open-weight instruct base plus QLoRA SFT, not production-scale pretraining from random weights.
- Scratch models remain valuable, but only as smoke tests for tokenization, dataset splits, checkpointing, eval gates, and specialist proof-of-concepts.
- Training data from Discord must be consented first-party data. No scraped server messages.
- Irene should use a Discord application/bot account, not an automated normal user account. Discord provides bot accounts for automation and treats normal user-account automation/self-bots as outside the supported API path.
- Voice-channel features must be opt-in per guild/channel, visible to users, and clear about whether audio is transient, transcribed, summarized, or retained.
- "No filters" means no corporate refusal voice and no generic disclaimers on allowed requests. It does not mean blindly executing destructive actions or leaking secrets. Tool execution still requires code-level validation, permission checks, cooldowns, candidate-tool limits, and confirmation for risky actions.
- Irene can express warmth, annoyance, humor, affection, excitement, and other affective states as her AI persona. She should not claim a human body, human memories, or biological lived experience.
- Memory is not the same thing as weight learning. Memory makes Irene recall and use information immediately. Actual model learning happens when reviewed memories/interactions become training data and update weights/adapters, or when we add new trainable modules, specialists, or a larger base model.
- A running model does not automatically increase its parameter count. Parameter count increases only when the architecture changes: adding LoRA/adapters, adding specialist heads or experts, expanding an MoE, merging in new modules, or moving to a larger base. The practical goal is continuous capability growth, with parameter growth as an explicit training/deployment step.
- The target is active learning, not periodic manual babysitting. Irene should continuously extract candidate memories, skills, preferences, and eval failures in the background, use approved ones immediately through retrieval, and queue high-confidence/reviewed ones for adapter or specialist training without requiring a full app restart.
- New knowledge must have an immediate access path. Even before it changes weights, Irene should be able to use approved memories, summaries, documents, and skill records through retrieval in the next relevant conversation.
- Parameter growth should also be live-operational. When a background learner creates a new adapter, specialist, router, or expert, Irene should be able to stage, evaluate, register, and hot-load it without shutting down the Discord process.
- The long-context architecture target is subquadratic sparse attention: local smoke models should support an SSA-style sparse path, hosted SubQ/OpenAI-compatible providers can be used when available, and no model should be called "SubQ-class" until long-context retrieval and tool/persona gates prove it.

## Current System Status

| Area | Current state | Evidence |
|---|---|---|
| Runtime bot platform | Working foundation with Discord, LLM providers, tool routing, memory stores, safety hooks, training capture, ops API, and tests. | `README.md`, `docs/ARCHITECTURE.md`, `npm test` |
| Runtime identity | Default bot name now resolves to `Irene`; system prompt enforces she/her and affective persona. | `src/ai/prompts/systemPrompt.ts`, `src/index.ts` |
| Tool protocol scratch specialist | Strong protocol proof, not a general assistant. | `tiny-transformer-protocol-iter16`: 775,358 params, valid JSON 1.000, action/tool/argument/no-tool accuracy 1.000, hallucinated tool rate 0.000 |
| Knowledge scratch model | Not useful yet. | Tiny scratch knowledge reports have 0 exact match and very low overlap; QLoRA path is required for production quality |
| Behavior scratch specialist | Trains on tiny behavior SFT but fails held-out direct JSON behavior eval. | `tiny-transformer-behavior-iter1`: 392,619 params, best/final val loss 0.2655, direct gate fails with valid JSON rate 0 |
| Router scratch specialist | Trains on tiny router SFT but fails held-out direct route eval. | `tiny-transformer-router-iter1`: 343,050 params, best/final val loss 0.3845, direct gate fails with route accuracy 0.055556 |
| Persistent growth loop | Basic memory, training capture, feedback export, eval scaffolds, live-learning/parameter registry, Prisma persistence, memory-write capture, tool-skill/eval-failure capture, approved-skill prompt retrieval, parameter-module ops API, parameter-growth planning/gating/dataset handoff/quality checks/trainer dispatch contract/backend-aware trainer control endpoint/staging checks/promotion readiness checks/hotload handoff checks/apply client/backend-aware control endpoint, stage-from-manifest API, runtime parameter-module activation, `/learning/status`, and learned-item review/queue API exist; a real training backend, a real model-server backend adapter, and richer review UI are not implemented yet. | `src/memory/**`, `src/training/**`, `src/learning/LiveLearningRegistry.ts`, `src/learning/InteractionLearningCapture.ts`, `src/learning/SkillRetrievalService.ts`, `src/learning/ParameterActivationService.ts`, `src/learning/ParameterModuleStagingService.ts`, `src/learning/ParameterModuleHotloadPlanner.ts`, `src/learning/ParameterModuleHotloadManifestQuality.ts`, `src/learning/ParameterModuleHotloadService.ts`, `src/serving/ParameterTrainerControlServer.ts`, `src/serving/ParameterHotloadControlServer.ts`, `src/training/parameter/ParameterGrowthPlanner.ts`, `src/training/parameter/ParameterGrowthPlanGate.ts`, `src/training/parameter/ParameterGrowthDatasetBuilder.ts`, `src/training/parameter/ParameterGrowthDatasetQuality.ts`, `src/training/parameter/ParameterTrainerDispatchService.ts`, `src/training/parameter/ParameterModuleStagingGate.ts`, `src/training/parameter/ParameterModulePromotionGate.ts`, `src/database/repositories/LiveLearningRepository.ts`, `src/server/routes/learning.ts`, `prisma/schema.prisma`, `docs/TRAINING_DATA.md` |
| Subquadratic sparse-attention track | Architecture target is explicit. Hosted SubQ can be configured as a named long-context provider, and the tiny scratch trainer has an experimental `local-log-sparse` attention mode for local smoke testing. A production SSA model/trainer is not implemented yet. | `src/ai/llm/LLMRouter.ts`, `src/ai/llm/OpenAICompatibleProvider.ts`, `training/train_tiny_transformer_lm.py`, `training/evaluate_tiny_transformer_lm.py`, `docs/LOCAL_LLM_SETUP.md` |
| Voice/living Discord presence | Text bot exists; voice join/speech/hearing is planned, not implemented. | Discord voice work is a roadmap phase |
| Production fine-tuning path | Scaffold exists for Qwen3 QLoRA SFT/DPO with Axolotl and Unsloth. | `training/configs/**`, `docs/AI_TRAINING_PLAN.md`, `docs/FINE_TUNING_PLAN.md` |

## Architecture Direction

The intended architecture is MoE-style at the system level first:

1. **Front router:** classify each prompt into `tool_protocol`, `knowledge`, `persona`, `casual`, `social_cue`, or `boundary`.
2. **Expert surfaces:** keep tool protocol, knowledge/RAG, persona/casual/social response, and boundary handling separately measurable.
3. **Strict protocol parser:** all assistant outputs must parse into allowed JSON action shapes before the runtime acts.
4. **Tool executor gates:** the model never directly executes tools. Code validates tool existence, candidate set, args, permissions, cooldowns, and confirmation state.
5. **Feedback loop:** every parse failure, wrong route, missing argument, refusal mistake, or bad social response becomes training/eval material after review.
6. **Persistent growth loop:** approved memories, skills, preferences, and resolved failures become durable state first, then curated data for future SFT/DPO/RL/distillation.
7. **Parameter-growth loop:** model size changes only through explicit training/deployment events: add adapters, add specialists, expand an MoE, distill into a new model, or promote a larger base.
8. **Voice presence loop:** voice audio is handled through a separate opt-in speech pipeline: voice receive -> VAD/speaker attribution -> STT -> conversation/router -> TTS -> voice playback.

This gives us the practical benefits of an MoE system before training a true sparse MoE model. The long-context base architecture target is subquadratic sparse attention, not dense full attention at ever-larger context windows. A true sparse MoE or SSA base can be considered for promotion only if hardware, data volume, and eval evidence justify it.

### Discord Account and Voice Boundary

Irene should feel like a real Discord presence, but the implementation should stay on the supported bot/application path:

- Use a Discord application bot account with Irene's name, avatar, status, activity, typing indicators, and voice presence.
- Do not automate a normal human Discord user account with a user token. That is self-bot territory and is not the implementation path.
- Add voice-channel support through Discord Voice: join/leave channels, speak with TTS, and listen through an opt-in audio receive/transcription stack.
- Treat voice receive as higher-risk than text because it captures other people. Require guild/channel opt-in, visible status, retention settings, and deletion controls.
- Keep raw audio buffers transient by default. Store only reviewed transcripts/summaries/memories when the server policy allows it.
- Add social presence controls: when Irene should join, when she should stay quiet, when she should leave, when push-to-talk/wake-word behavior is required, and who can command her.

### Learning and Parameter Growth

The system should not merely remember facts. It should turn useful memories and interactions into better future behavior.

There are three distinct learning modes:

| Learning mode | What changes | Parameter count impact | Use |
|---|---|---:|---|
| Retrieval learning | Memory rows, vector index, summaries, skill records | 0 new model params | Immediate recall and personalization |
| Online skill learning | Tool recipes, decision rules, workflow plans, correction records | 0 new model params unless promoted into a specialist | On-the-spot improvement while Irene is running |
| Weight/adaptor learning | LoRA/QLoRA adapters, DPO adapters, specialist checkpoints | Adds adapter/specialist params or changes trained weights | Real behavior improvement after background training |
| Architecture growth | New experts, router heads, larger base model, MoE expansion, ensembles | Increases total system params | Scaling toward larger-model-class capability |

The growth pipeline should be:

1. Capture interaction, tool trace, correction, voice transcript, or memory.
2. Extract candidate memory/skill/preference with provenance.
3. Store it durably with source, consent, retention, and deletion metadata.
4. Use it immediately through RAG/memory retrieval.
5. Convert repeated successful behavior into a skill record that can be reused without a restart.
6. Promote only reviewed or high-confidence policy-safe items into training datasets.
7. Dispatch checked datasets to a background learner service, then train or update adapters/specialists without blocking chat.
8. Gate the new model/adapters against protocol, knowledge, behavior, router, memory, skill, and voice evals.
9. Hot-load approved memory/skill updates immediately; hot-swap model adapters, specialists, or experts only after gates pass and rollback is available.
10. Deploy only if gates improve or the tradeoff is explicitly accepted.

Parameter-count growth is deliberate. Examples:

- Add a behavior LoRA adapter: base params stay fixed, total served system gains adapter params.
- Add a router classifier or specialist LM: total system params increase by that model.
- Add more MoE experts: total params increase, active params per request may stay smaller.
- Merge adapters into a base: behavior changes, but reported serving params may return to the base size plus any remaining modules.
- Promote from 4B to 7B/14B/30B/70B+ or a future MoE base: parameter count increases through model replacement.
- Register a newly trained specialist while Irene stays online: total system params increase immediately after promotion, and the router can use it on the next request.

The long-term target is a growing Irene system that can start small, retain useful experience, learn usable skills on the spot, train on reviewed experience in the background, add specialists, and later move to larger bases. It should not claim to passively become a 1.5T-parameter model just by staying online; it can grow toward that class only through explicit parameter additions, larger bases, or expert expansion.

### Live Knowledge and Parameter Access

Irene needs two live access paths:

| Path | Activation speed | What Irene can access immediately |
|---|---|---|
| Memory/RAG path | Immediate after approved write/index update | New facts, summaries, documents, preferences, corrections, voice-session notes, and skill recipes |
| Parameter path | After background training plus eval promotion | New adapters, experts, specialists, or merged checkpoints that alter model behavior |

The system should prefer the memory/RAG path for instant learning and the parameter path for durable behavior changes. A newly learned fact should be usable immediately through retrieval. A newly trained adapter or specialist should become usable as soon as it is registered and passes gates, without restarting Irene.

Parameter registry requirements:

- Track `baseModelParams`, `adapterParams`, `routerParams`, `specialistParams`, `expertParams`, `totalSystemParams`, and estimated `activeParamsPerRequest`.
- Version every adapter/expert with dataset hashes, eval reports, source memories, and rollback target.
- Support hot registration of a new expert or adapter in the router.
- Keep old adapters available until the new one proves stable.
- Let Irene answer whether a piece of knowledge is only in memory/RAG or has also been trained into adapters/weights.

Initial implementation: `src/learning/LiveLearningRegistry.ts` provides the in-process contract for learned items, training-queue promotion, parameter-module staging, gate-protected promotion, parameter accounting, and links from learned knowledge/skills to the modules trained from them. `src/database/repositories/LiveLearningRepository.ts` persists the same contract through Prisma models for learned items, training status, provenance, retention, parameter modules, eval reports, and learned-item-to-module links. The memory path is runtime-wired: successful memory writes remain immediately retrievable through RAG and also create learned-item rows for future review/training. The interaction path is also wired: successful tool traces become skill candidates, and parse/tool/safety failures become eval-failure candidates. The ops API can list, inspect, approve/reject, and queue learned candidates for training, plus create/list/promote/retire parameter modules and report selected parameter snapshots. Approved `skill` items are retrieved into the prompt as workflow hints, and active promoted parameter modules are retrieved into the prompt with source-learning summaries when relevant, while tool execution still goes through normal candidate and executor gates. `ParameterGrowthPlanner` turns approved queued learning into deterministic trainer handoff manifests with source ids, hashes, target module kind, parameter budget estimates, gate requirements, and risks. `ParameterGrowthPlanGate` blocks not-ready, inconsistent, over-budget, or unreviewed-risk plans before training compute is spent. `ParameterGrowthDatasetBuilder` re-fetches live source rows, verifies hashes and retention, and writes per-batch JSONL handoff data only after the plan gate passes. `ParameterGrowthDatasetQuality` verifies the generated manifest, file hashes, record schema, batch counts, unique ids, and obvious secret patterns. `ParameterTrainerDispatchService` re-runs the dataset gate, blocks invalid handoffs, and emits the `parameter-training-dispatch-v1` request to a configured private trainer with the expected staging output and next gates. `ParameterTrainerControlServer` is the compatible local receiver: it authenticates dispatches, re-checks dataset quality, verifies the embedded manifest matches disk, records accepted/rejected/dry-run jobs, and delegates to a replaceable trainer backend. `ParameterModuleStagingGate` then verifies trained module staging manifests: source ids must match dataset rows, dataset/artifact/eval hashes must match, required evals must pass, parameter budget must hold, and rollback metadata must exist before registration. `ParameterModuleStagingService` and `/learning/parameter-modules/stage-from-manifest` turn a passing manifest into a staged module while preserving the full gate report in metadata. `ParameterModulePromotionGate` blocks activation unless staging evidence, rollback metadata, source ids, dataset hashes, and required runtime eval passes are still present. `ParameterModuleHotloadPlanner` emits active promoted modules as a deterministic model-server load manifest with artifacts and rollback targets, `ParameterModuleHotloadManifestQuality` verifies that manifest's loader readiness, accounting, eval statuses, and artifact hashes, `ParameterModuleHotloadService` dry-runs or applies the checked payload through `PARAMETER_HOTLOAD_ENDPOINT`, and `ParameterHotloadControlServer` provides a compatible local receiver that delegates load/rollback to `ParameterHotloadBackend` before mutating state. `LLMRouter` can also route explicit long-context calls to a named `subq` provider, and the tiny scratch trainer can run `local-log-sparse` attention for SSA-style smoke tests. The next step is the actual training backend, a real model-server adapter for vLLM/Ollama/LM Studio LoRA or specialist loading, a production-grade SSA/SubQ training path, and a richer review UI.

### Open-Door Learning Requirements

Irene should not require shutdowns or manual rebuilds for ordinary learning.

- Memory writes, memory corrections, skill records, and preference updates should be live-reloadable.
- The vector index should update incrementally as new approved memories arrive.
- The skill registry should support adding or revising non-code recipes without restarting the Discord process.
- Training data queues should fill continuously from reviewed memories, corrections, tool traces, and eval failures.
- A background learner should be able to train small adapters or specialists while the serving model keeps running.
- A parameter-growth planner should continuously produce reviewed batch manifests before any trainer spends compute.
- Trainer dispatch should re-check datasets and hand a versioned request to private training infrastructure without requiring the Discord process to restart.
- New adapters, specialists, and experts should be staging-manifest checked, hotload-manifest checked, evaluated, registered, and hot-swapped through a configured loader endpoint only after passing gates.
- Every learned item should expose provenance: who/what taught it, when it was learned, where it is stored, whether it affected weights, and how to delete or correct it.
- Poisoning defenses are mandatory: untrusted users should not be able to teach Irene false durable facts, unsafe skills, or tool-bypass behavior just by saying them confidently.

## Dataset Plan

| Dataset slice | Initial source | Rules |
|---|---|---|
| Tool protocol | Project synthetic tool examples plus logged successful/failed tool turns | Must include candidate tools, required args, permissions, confirmation state, and no-tool contrasts |
| Knowledge | Licensed open instruction data plus reviewed first-party answers | Must keep held-out validation/eval seeds out of train data |
| Persona and social behavior | Project-owned templates plus reviewed Discord interactions | Must preserve Irene/she-her identity, emotional voice, and social repair/support cases |
| Specialist routing | Project-owned route templates plus future logged routing labels | Keep route-label data separate from user-facing assistant SFT |
| Memory behavior | Consented remember/recall/forget turns | Never store secrets; include deletion and correction cases |
| Voice behavior | Opt-in voice transcripts, speaker labels, turn-taking events, TTS failures | No raw-audio retention by default; consent and deletion policy required before using as training data |
| Skill learning | Reviewed tool traces, successful workflows, corrected failures | Convert repeated procedures into tools, recipes, evals, and examples |
| Preference data | Explicit prompt/chosen/rejected pairs only | Plain ratings are not DPO data until a rejected answer exists |
| Red-team/boundary | Project-owned account theft, secret exfiltration, harassment, prompt injection, and unsafe tool-use cases | Should test short direct boundaries, not generic policy monologues |

Dataset quality gates:

- Source, license, and split metadata per row.
- Deduplication and exact eval-prompt exclusion.
- Secret and credential filtering.
- Sequence-length audit before GPU training.
- Synthetic share caps so format examples do not dominate judgment.
- `npm run check:contamination` before any promotion claim.
- Memory-to-training promotion review so raw remembered facts do not automatically become weight updates.
- Parameter-count accounting for every trainable module: base params, active params, adapter params, router params, specialist params, and total deployed system params.

## Training Strategy

| Stage | Purpose | Success criteria |
|---|---|---|
| Scratch smoke models | Verify data plumbing, loss masking, checkpointing, and direct evals cheaply on CPU. | Loss improves, artifacts validate, direct evals produce honest pass/fail reports |
| Protocol specialist | Prove exact JSON/tool behavior on a narrow held-out suite. | Tool gate passes: valid JSON, action type, tool name, args, no-tool accuracy all at 1.000, hallucinated tools at 0 |
| Subquadratic sparse-attention smoke | Validate SSA-style local/log sparse attention before spending real training compute. | Sparse checkpoint trains, reloads, reports attention mode/parameter count, and runs the same direct eval format as dense checkpoints |
| Behavior/router specialist iteration 2 | Fix current invalid JSON failure on held-out behavior/router suites. | Behavior valid JSON >= 0.98 and router invalid predictions = 0 before judging tone/route quality |
| Production SFT | Train QLoRA adapter on open data plus consented/project-owned data. | Pass protocol, knowledge, behavior, router gates without latency regressions |
| Preference tuning | Use DPO after enough reviewed prompt/chosen/rejected rows exist. | DPO readiness passes with non-synthetic preference volume and no eval regression |
| Optional verifiable RL | Use GRPO only for verifiable rewards such as tool JSON validity, route correctness, and executable task success. | Reward is automatic, auditable, and resistant to reward hacking |
| Lifelong memory consolidation | Periodically summarize, dedupe, validate, and expire memories, skills, and conversation traces. | Irene retains useful information across restarts without leaking secrets or accumulating junk |
| Distillation | Distill cheap router/persona specialists or deploy a smaller serving model if the production model is too slow. | Maintains gates while reducing latency/cost |
| Parameter expansion | Add adapters, specialists, experts, or larger base models only after eval evidence justifies the extra cost. | Total/active/trainable parameter counts are recorded and gates improve |

Current practical production choice remains `Qwen/Qwen3-4B-Instruct-2507` class QLoRA for first useful GPU training because the model card reports 4.0B parameters, long context support, and tool-usage improvements, while fitting a realistic low-VRAM adapter workflow.

## Evaluation Plan

Promotion requires all relevant gates, not just lower validation loss.

| Gate | What it protects |
|---|---|
| Protocol/tool gate | Valid JSON, correct action type, correct tool, correct args, no-tool behavior, hallucinated-tool rate |
| Knowledge gate | Held-out answer quality and regression tracking |
| Behavior gate | Irene identity, she/her consistency, social support, repair, casual tone, boundary wording, tool abstention |
| Router gate | Exact specialist route, broad expert family, tool vs non-tool separation |
| Voice gate | Speaker attribution, turn-taking, interruption handling, STT quality, TTS latency, no retention-policy violations |
| Memory growth gate | Accurate recall, correct forgetting, no secrets, no stale false memories, useful summary quality |
| Skill growth gate | Learned workflow succeeds on repeat tasks and does not bypass permissions or confirmations |
| Parameter growth gate | New trainable params are counted and justified by eval improvement |
| Parameter module staging gate | Trainer artifacts are hash-verified, tied to source learned items, eval-passing, and rollback-ready before registration |
| Parameter module promotion gate | Staged modules cannot activate without staging evidence, rollback target, provenance, and required runtime eval passes |
| Parameter hotload manifest gate | Loader handoffs must be internally consistent, unblocked, eval-passing, and artifact-hash verified |
| Subquadratic sparse-attention gate | Long-context models must prove retrieval, repo/artifact reasoning, tool protocol stability, and cost/latency wins before replacing dense/open-weight serving |
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
- Add a persistent skill ledger for successful workflows, recurring tool sequences, and corrected mistakes.
- Add scheduled memory consolidation: summarize, dedupe, validate, expire, and delete memories according to policy.
- Add a memory-to-training promotion queue so reviewed memories can become SFT/DPO examples and not just RAG entries.
- Track trainable parameter growth: adapter params, specialist params, total deployed params, and active params per request.

Success criteria:

- DPO readiness passes.
- Preference tuning improves human review and does not regress automated gates.
- Failure categories shrink across repeated eval runs.
- Memory recall is useful and correct in held-out continuity tests.
- Forget/delete requests remove durable memory and derived summaries.
- New adapters or specialists improve gates enough to justify their additional parameters.

### Phase 5: Living Discord Presence and Voice

Goal: make Irene feel present in Discord while staying on the bot/application API path.

Tasks:

- Add bot profile/presence configuration for Irene's name, avatar, status, and activity.
- Add voice-channel join/leave commands with permission checks.
- Add TTS playback pipeline with queueing, interruption, and rate limits.
- Add opt-in STT pipeline for voice receive, voice activity detection, speaker attribution, and transcript windows.
- Add visible indicators and server settings for whether Irene is listening, speaking, transcribing, summarizing, or storing anything.
- Add voice-session memory policy: raw audio transient by default, transcript retention optional, training use requires review.
- Add voice evals for turn-taking, latency, speaker attribution, transcription quality, and social timing.

Success criteria:

- Irene can join an allowed voice channel, speak generated replies, and leave reliably.
- Irene can transcribe opt-in voice sessions into conversation context without storing raw audio by default.
- Voice behavior does not bypass text tool/permission/confirmation gates.
- p95 speech round-trip latency target is documented and measured.
- Users can see and control listening/retention state.

### Phase 6: Deployment Readiness

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

### Phase 7: Scale Toward Larger-Model-Class Quality

Goal: keep improving capability while treating parameter growth as an explicit engineering action.

Tasks:

- Maintain a model leaderboard across scratch, QLoRA, DPO, router, behavior, voice, and production checkpoints.
- Use persistent memory/RAG so knowledge grows immediately after approved interactions.
- Periodically train adapters from reviewed memory/skill/preference data once eval failures justify it.
- Distill reliable specialist behaviors into smaller/faster models where useful.
- Add experts or router-controlled specialists when a single model starts mixing incompatible behaviors.
- Evaluate larger bases or MoE models when current models plateau.
- Track total system capability separately from raw parameter count: base model params, active params, adapter params, specialist params, memory corpus size, tool count, eval pass rate, latency, and cost.

Success criteria:

- Each scale step improves at least one target gate without unacceptable regressions.
- The system can explain what was learned from interactions, where it is stored, whether it changed weights/adapters, and how to delete it.
- Long-running use produces measurable improvements in held-out continuity, tool, social, voice, and knowledge evals.
- Larger models or new experts are adopted only when they beat the smaller system on the project gates.

## Research Anchors

- BFCL V4 tracks real-world function calling, multi-turn interactions, and agentic evaluation: https://gorilla.cs.berkeley.edu/leaderboard.html
- Qwen3-4B-Instruct-2507 model card: https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507
- TRL SFT supports packing and assistant-only loss for conversational datasets: https://huggingface.co/docs/trl/en/sft_trainer
- QLoRA paper: https://arxiv.org/abs/2305.14314
- DPO paper: https://arxiv.org/abs/2305.18290
- GRPO source paper, DeepSeekMath: https://arxiv.org/abs/2402.03300
- Axolotl docs: https://docs.axolotl.ai/
- vLLM production stack: https://docs.vllm.ai/en/latest/deployment/integrations/production-stack/
- Discord automated user accounts/self-bots policy: https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots
- Discord Voice Connections docs: https://docs.discord.com/developers/topics/voice-connections
- Discord Gateway docs: https://docs.discord.com/developers/events/gateway
- discord.js voice package notes: https://discord.js.org/docs/packages/voice/main
