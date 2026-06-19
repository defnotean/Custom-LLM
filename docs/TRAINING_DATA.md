# Training Data Pipeline

Every interaction the bot handles is captured with full fidelity so it can become fine-tuning data later. This is the asset the whole project compounds on.

## What Gets Logged

`TrainingDataLogger` writes two rows per handled message when the DB is up and `TRAINING_LOGGING_ENABLED=true`:

1. **Conversation** - the user-facing exchange: message, reply, and metadata.
2. **TrainingExample** - the full trace:
   - `inputJson`: system prompt version and full text, user message, recent transcript, retrieved memories, retrieved skills, activated parameter modules, candidate tools shown, router verdict, ids.
   - `outputJson`: raw model output, parse success, parsed action, tool call and real tool result, denial reason if gated, final response, errors, latencies, model name.
   - `qualityScore`: heuristic 0-1 score from `EvaluationAgent`; useful as a filter, not a substitute for review.
   - `reviewed`: defaults false; flip after human review.

Parse failures and tool denials are logged too. Failure data is signal for format-following negatives and refusal training.

## Live Learning Candidates

`InteractionLearningCapture` writes lightweight `LearnedItem` candidates after each handled message when live-learning persistence is configured:

- Successful tool calls become `skill` candidates with `skill_registry` access, tool name, scrubbed arguments, and trace/training provenance.
- Parse failures, safety blocks, tool denials, and tool execution failures become `eval_failure` candidates with `training_queue` access.
- Candidate content and metadata are scrubbed for obvious tokens/API keys before storage.
- Candidates are not automatically trained into weights or promoted into parameter modules. They require review, queueing, background training, eval gates, and parameter-module promotion.
- Approved `skill` candidates with `skill_registry` access are retrieved into future prompts as workflow hints. They do not bypass tool retrieval, permissions, confirmations, or executor gates.
- Active promoted parameter modules are selected per request and retrieved into future prompts with any retrievable source-learning summaries. This makes a newly promoted adapter/specialist/expert visible to Irene immediately. Real model-weight loading uses the checked hotload handoff and requires a configured model-server control endpoint.
- Approved queued candidates are also scanned by `ParameterGrowthPlanner`, which writes trainer handoff manifests with source ids, content/metadata hashes, target module type, parameter budget estimates, gate requirements, and risk flags. These manifests do not train weights; they tell the future trainer exactly what to train and what must pass before promotion.
- `ParameterTrainerDispatchService` re-checks generated parameter-growth datasets, blocks stale or tampered files, and emits a versioned `parameter-training-dispatch-v1` request for a private trainer. Dry runs let Irene's operator inspect the exact request before spending training compute. `ParameterTrainerControlServer` is the local compatible receiver: it authenticates dispatches, re-runs the dataset quality gate server-side, rejects embedded-manifest mismatches, records job state, and delegates to a replaceable backend. `ParameterTrainerRunner` is the repo-owned executable handoff: in plan mode it writes a SubQ/SSA-compatible run plan, and in import mode it turns trusted trainer artifacts plus eval reports into a checked staging manifest.
- Trained parameter-module candidates must ship a staging manifest checked by `ParameterModuleStagingGate`: dataset manifest hash, emitted dataset hashes, artifact hashes, source learned-item ids, required eval passes, and rollback target all have to match before the module should be registered or promoted.

Review and queue candidates through the private ops API:

```bash
curl "http://127.0.0.1:3000/learning/items?reviewStatus=candidate&limit=25"
curl "http://127.0.0.1:3000/learning/review"

curl -X POST http://127.0.0.1:3000/learning/items/<learned-item-id>/review \
  -H "content-type: application/json" \
  -d '{"status":"approved","reviewerId":"admin","reason":"useful reusable skill"}'

curl -X POST http://127.0.0.1:3000/learning/items/<learned-item-id>/queue \
  -H "content-type: application/json" \
  -d '{"datasetId":"skill-ledger-v1","reason":"approved for next adapter/specialist run"}'

curl -X POST http://127.0.0.1:3000/learning/items/batch-review \
  -H "content-type: application/json" \
  -d '{"filter":{"kind":"skill","reviewStatus":"candidate","trainingStatus":"not_queued","limit":25},"reviewStatus":"approved","queue":true,"datasetId":"skill-ledger-v1","dryRun":true}'

curl -X POST http://127.0.0.1:3000/learning/items/batch-review \
  -H "content-type: application/json" \
  -d '{"filter":{"kind":"skill","reviewStatus":"candidate","trainingStatus":"not_queued","limit":25},"reviewStatus":"approved","reviewerId":"admin","reviewReason":"approved reusable skills","queue":true,"queueReason":"ready for next adapter/specialist run","datasetId":"skill-ledger-v1","execute":true}'

curl -X POST http://127.0.0.1:3000/learning/parameter-growth/plan \
  -H "content-type: application/json" \
  -d '{"limit":250,"minItems":2,"gate":{"allowRiskReview":true}}'

curl -X POST http://127.0.0.1:3000/learning/parameter-growth/plan \
  -H "content-type: application/json" \
  -d '{"limit":250,"minItems":2,"gate":{"allowRiskReview":true},"execute":true}'

curl -X POST http://127.0.0.1:3000/learning/parameter-growth/dataset \
  -H "content-type: application/json" \
  -d '{"planPath":"training/plans/parameter-growth/latest.json","gate":{"allowRiskReview":true}}'

curl -X POST http://127.0.0.1:3000/learning/parameter-growth/dataset \
  -H "content-type: application/json" \
  -d '{"planPath":"training/plans/parameter-growth/latest.json","gate":{"allowRiskReview":true},"execute":true}'

curl -X POST http://127.0.0.1:3000/learning/parameter-training/dispatch \
  -H "content-type: application/json" \
  -d '{"manifestPath":"training/data/parameter-growth/<plan-id>/manifest.json","trainerProfile":"qlora-sft-smoke"}'

curl -X POST http://127.0.0.1:3000/learning/parameter-training/dispatch \
  -H "content-type: application/json" \
  -d '{"manifestPath":"training/data/parameter-growth/<plan-id>/manifest.json","trainerProfile":"qlora-sft-smoke","execute":true}'

npm run plan:parameter-growth
npm run check:parameter-growth-plan -- --allow-risk-review
npm run build:parameter-growth-data -- --allow-risk-review
npm run check:parameter-growth-data -- --manifest training/data/parameter-growth/<plan-id>/manifest.json
npm run dispatch:parameter-training -- --manifest training/data/parameter-growth/<plan-id>/manifest.json --dry-run
npm run serve:parameter-trainer -- --host 127.0.0.1 --port 8090 --api-key local-dev
npm run serve:parameter-trainer -- --host 127.0.0.1 --port 8090 --api-key local-dev --backend command --command python --arg training/run_parameter_trainer.py --arg --request --arg "{requestPath}"
npm run dispatch:parameter-training -- --manifest training/data/parameter-growth/<plan-id>/manifest.json --endpoint-url http://127.0.0.1:8090/parameter-training/dispatch --api-key local-dev
npm run run:parameter-trainer -- --request training/runs/parameter-modules/<run-id>/trainer-dispatch-request.json --mode plan --framework axolotl
npm run run:parameter-trainer -- --request training/runs/parameter-modules/<run-id>/trainer-dispatch-request.json --mode execute-training --framework axolotl
npm run run:parameter-trainer -- --request training/runs/parameter-modules/<run-id>/trainer-dispatch-request.json --mode execute-training --framework axolotl --execute
npm run run:parameter-trainer -- --request training/runs/parameter-modules/<run-id>/trainer-dispatch-request.json --mode import-artifacts --framework axolotl --artifact-dir training/runs/qwen3-qlora-sft --parameters 2000000 --active-parameters 500000 --trainable-parameters 2000000 --rollback-target-id <module-id> --eval-report kind=dataset_quality,path=training/reports/dataset-quality.json,status=pass --eval-report kind=parameter_growth,path=training/reports/parameter-growth.json,status=pass --eval-report kind=training_report,path=training/reports/training-report.json,status=pass --eval-report kind=contamination,path=training/reports/contamination.json,status=pass --eval-report kind=protocol,path=training/evals/protocol.json,status=pass --eval-report kind=knowledge,path=training/evals/knowledge.json,status=pass --eval-report kind=behavior,path=training/evals/behavior.json,status=pass
npm run check:parameter-module-staging -- --manifest training/runs/parameter-modules/<run-id>/staging-manifest.json

curl -X POST http://127.0.0.1:3000/learning/parameter-modules/stage-from-manifest \
  -H "content-type: application/json" \
  -d '{"manifestPath":"training/runs/parameter-modules/<run-id>/staging-manifest.json","metadata":{"operator":"admin"}}'

curl -X POST http://127.0.0.1:3000/learning/parameter-modules/<module-id>/promote \
  -H "content-type: application/json" \
  -d '{"gateStatus":"pass","evalReport":{"kind":"skill","path":"training/evals/skill-retrieval.report.json","status":"pass"}}'

npm run build:parameter-hotload
npm run check:parameter-hotload -- --manifest training/plans/parameter-hotload/latest.json
npm run apply:parameter-hotload -- --manifest training/plans/parameter-hotload/latest.json --dry-run
npm run serve:model-adapter-sidecar -- --provider vllm --model-server-base-url http://127.0.0.1:8000 --api-key sidecar-dev
npm run validate:model-adapter-sidecar -- --manifest training/plans/parameter-hotload/latest.json --dry-run
npm run validate:model-adapter-sidecar -- --manifest training/plans/parameter-hotload/latest.json --endpoint-url http://127.0.0.1:9099 --api-key sidecar-dev --execute
npm run serve:parameter-hotload -- --host 127.0.0.1 --port 8088 --api-key local-dev
npm run serve:parameter-hotload -- --host 127.0.0.1 --port 8088 --api-key local-dev --backend http --backend-url http://127.0.0.1:9099/parameter-modules --backend-api-key sidecar-dev
npm run apply:parameter-hotload -- --manifest training/plans/parameter-hotload/latest.json --endpoint-url http://127.0.0.1:8088/parameter-hotload

curl -X POST http://127.0.0.1:3000/learning/parameter-hotload/apply \
  -H "content-type: application/json" \
  -d '{"manifestPath":"training/plans/parameter-hotload/latest.json","dryRun":true}'

curl "http://127.0.0.1:3000/learning/parameter-snapshot?selectedModuleIds=<module-id>"
```

`GET /learning/review` serves a self-contained browser console for live-learning review. It lists filtered learned items, shows learning/parameter metrics, lets an operator approve, reject, queue, dry-run batch approve+queue, execute batch approve+queue, and dry-run parameter-growth planning through the same ops endpoints below. It adds no separate frontend build and still relies on the API's dry-run-first mutation rules.

`POST /learning/items/batch-review` is the operator handoff between "Irene learned candidates while running" and "these items may feed parameter growth." It accepts explicit ids or a typed filter, dry-runs by default, and only mutates when `execute:true` is present. The response uses `learning-batch-review-v1` and lists matched ids, missing ids, reviewed items, queued items, skips, and per-item errors. Queueing still honors retention, rejection, approval, confidence, and `force` rules; a dry run never calls the review or queue mutators.

`POST /learning/parameter-growth/plan` lets the running ops API produce the same parameter-growth handoff as `npm run plan:parameter-growth`. Without `execute:true`, it builds the plan in memory and returns a `parameter-growth-plan-run-v1` report with the plan, gate report, and next actions. With `execute:true`, it writes the timestamped plan plus `training/plans/parameter-growth/latest.json`. This still does not train weights; it closes the gap between reviewed live learning and a fresh trainer handoff artifact without waiting for the six-hour worker.

`POST /learning/parameter-growth/dataset` builds the next handoff artifact from a checked plan. Dry-run mode reads the plan and returns a `parameter-growth-dataset-build-v1` gate preflight without writing files. With `execute:true`, it writes per-batch JSONL plus `manifest.json`, immediately runs the dataset quality gate, and reports pass/fail before trainer dispatch. The builder still re-fetches learned items by id, verifies approval, queued status, retention, and content/metadata hashes, so stale or unreviewed learning cannot silently become training data.

`POST /learning/parameter-training/dispatch` exposes `ParameterTrainerDispatchService` through the running ops API. It dry-runs by default, re-checks the dataset quality gate, and returns the exact `parameter-training-dispatch-v1` request with expected run/staging paths and next gates. With `execute:true`, it sends the checked request to `PARAMETER_TRAINER_ENDPOINT`; if no private trainer backend is configured, execution returns a 503 instead of pretending training happened.

The scheduled worker also writes parameter-growth plans to `training/plans/parameter-growth/` every six hours when the DB-backed learning repository is available. That directory is generated output and is intentionally ignored by Git.

`check:parameter-growth-plan` fails plans that are not ready, have too few ready batches, exceed the parameter budget, include inconsistent record/hash counts, miss required gates, or still need risk review. Use `--allow-risk-review` only after a human has reviewed the plan's risk flags and source provenance.

`build:parameter-growth-data` re-fetches every source learned item from the live store, verifies the plan's content and metadata hashes, re-checks review/training/retention state, then writes per-batch JSONL plus a manifest under `training/data/parameter-growth/`. If any source item changed after planning, the build fails instead of training on stale or unreviewed data.

`check:parameter-growth-data` verifies the generated manifest and JSONL files after the build: recorded hashes and byte counts must match, record schemas must be valid, batch counts must line up, record ids must be unique, and obvious token/API-key patterns must be absent.

`dispatch:parameter-training` runs the same dataset quality gate before trainer handoff. Dry runs return the exact `parameter-training-dispatch-v1` request, including the dataset manifest, expected run directory, expected staging manifest path, and next gates (`check:parameter-module-staging`, stage-from-manifest, promotion, hotload build/check/apply). Non-dry-run dispatch requires `PARAMETER_TRAINER_ENDPOINT` or `--endpoint-url`; invalid datasets are blocked before the private trainer is called.

`serve:parameter-trainer` starts the local compatible trainer control endpoint. It accepts `POST /parameter-training/dispatch`, verifies the request contract, re-runs dataset quality checks from `datasetManifestPath`, confirms the embedded manifest matches the file on disk, records accepted/rejected/dry-run jobs, and exposes `GET /parameter-training/status`. The default backend is `state-only`: it proves dispatch compatibility and job accounting, but it does not train weights or write staging artifacts. Use `--backend command --command <trainer executable> --arg ...` or `PARAMETER_TRAINER_BACKEND=command` to run a configured private trainer after gates pass. The command backend writes `trainer-dispatch-request.json` and `trainer-quality-report.json` into the expected run directory, passes paths through environment variables, expands placeholders such as `{requestPath}` and `{stagingManifestPath}` in args, and requires the expected staging manifest by default before accepting the job. `run:parameter-trainer` can be used as that command in safe plan mode, as an explicit `--execute` launcher for Axolotl/Unsloth/custom trainer commands, or after a trainer finishes to import artifacts into a staging manifest. Execute-training mode writes `trainer-preflight-report.json` first, requiring parameter-growth dataset quality, SubQ/SSA architecture readiness, and production training readiness before launch; a failed preflight blocks `--execute`. It records `architectureTarget=subquadratic-sparse-attention`, passes trainer environment variables, writes stdout/stderr logs plus `trainer-execution-report.json`, and points long-context runs through `check:subq-architecture`; live GPU validation and artifact-producing trainer integration are still required before promotion claims.

`check:parameter-module-staging` verifies the trainer's output before registry creation/promotion: module parameter counts must be within budget, source learned-item ids must match the dataset records, dataset and artifact hashes must match the staging manifest, required eval reports must pass, eval report evidence must be hash-verified, and rollback metadata must exist. `POST /learning/parameter-modules/stage-from-manifest` runs the same gate, creates a staged module from the manifest, records runtime-compatible eval reports, and stores the full staging report in module metadata. Promotion has its own readiness gate too: the module must still be staged, have rollback metadata, source ids, dataset hashes, passing stage-from-manifest evidence, no failed eval reports, and required runtime eval kinds for the module type. This is the handoff gate between "a trainer produced files" and "Irene may activate a new adapter/specialist/expert."

`build:parameter-hotload` writes `training/plans/parameter-hotload/latest.json`, a deterministic model-server handoff manifest for active non-base modules. It includes load actions, artifact paths and hashes, routes/base-module ids, rollback targets, dataset hashes, source learned-item ids, and eval summaries. The command exits blocked if any active non-base module lacks staging artifacts or rollback evidence, because active prompt visibility should not drift away from model-server loadability.

`check:parameter-hotload` verifies that handoff before a model server consumes it: manifest status must match the request/skipped payload, blocked manifests fail loader readiness, summary counts and parameter totals must be internally consistent, load request ids must be unique, required config plus checkpoint/adapter artifacts must exist, eval reports must not be failed, and artifact byte counts/hashes must match disk.

`apply:parameter-hotload` and `POST /learning/parameter-hotload/apply` run the same quality gate first. Dry runs return the exact `parameter-module-hotload-apply-v1` payload without calling a loader. Non-dry-run applies require `PARAMETER_HOTLOAD_ENDPOINT` or `--endpoint-url`; the service posts the checked manifest to that private model-server control endpoint and reports accepted/rejected module ids. If the manifest is blocked or hash-invalid, the loader is never called.

`serve:parameter-hotload` starts the local compatible control endpoint used during development or serving-integration tests. It accepts `POST /parameter-hotload`, verifies the payload and artifact hashes again server-side, delegates accepted loads/rollbacks to a `ParameterHotloadBackend`, records loaded module state only after backend acceptance, exposes `GET /parameter-hotload/status`, and supports `POST /parameter-hotload/rollback`. The default backend is `state-only`: it exercises the control-plane contract and rollback bookkeeping. Use `--backend http --backend-url <private model-server adapter URL>` or `PARAMETER_HOTLOAD_BACKEND=http` plus `PARAMETER_HOTLOAD_BACKEND_URL` to delegate checked loads/rollbacks through the `parameter-hotload-backend-v1` contract. `serve:model-adapter-sidecar` is the included private receiver for that backend: the `vllm` provider calls runtime LoRA load/unload endpoints, and the `ollama` provider creates adapter models from a Modelfile and unloads them from memory on rollback. `validate:model-adapter-sidecar` talks directly to that private receiver: dry-run mode emits the exact load/rollback sidecar payload after the same manifest-quality gate, while `--execute` calls `/health`, posts load, reads status, rolls back by default, and reads final status. A failed hotload quality report blocks all HTTP calls. Live validation against a real serving process is still required before promotion; direct LM Studio LoRA hot-swap remains a later provider-specific integration.

## Export Formats

Run:

```bash
npm run export:training
```

Writes to `exports/training/`:

| File | Shape | Use |
|---|---|---|
| `chatml.jsonl` | `{"messages":[{system},{user},{assistant}]}` | SFT for conversational turns |
| `alpaca.jsonl` | `{"instruction","input","output"}` | Alpaca-style configs |
| `tool-calling.jsonl` | system -> user -> assistant(`tool_call` JSON) -> tool(result) -> assistant(final) | SFT for tool selection and argument filling |
| `dpo-placeholder.jsonl` | `{"prompt","chosen","rejected","metadata"}` | Synthetic/exported preference pairs for DPO-style trainers |
| `preference-feedback.jsonl` | `{"prompt","chosen","rejected","metadata"}` | Explicit `source=FEEDBACK` preference pairs with provenance |

Export filters: `qualityScore >= 0.3`; conversational turns with `parseOk: false` are excluded from SFT; rows missing user/assistant text are skipped.

## Preference Data

Real preference pairs need human feedback. `UserFeedback` now has explicit `preferredResponse`, `rejectedResponse`, `reviewed`, and `metadataJson` fields for reviewed DPO pairs. The exporter separates reviewed feedback pairs into `preference-feedback.jsonl` and keeps synthetic/template pairs in `dpo-placeholder.jsonl`. Plain ratings or feedback text are not enough for DPO; a prompt, chosen answer, and rejected answer must exist. Today the only guaranteed pairs are synthetic valid-tool-call vs hallucinated-tool-name pairs from the generator below. Those are useful for anti-hallucination protocol shaping, clearly tagged, and never fabricated from ordinary chat logs.

Run:

```bash
npm run build:preference-mixture
```

The builder converts explicit DPO rows from `exports/training/dpo-placeholder.jsonl`, `exports/training/preference-feedback.jsonl`, and synthetic tool examples into deterministic `training/data/preferences/production-dpo.*.jsonl` files plus a provenance report. Synthetic-only reports are acceptable for protocol smoke tests, not final preference alignment.

To collect a reviewed preference pair through the private ops API:

```bash
curl -X POST http://127.0.0.1:3000/training/feedback/preference \
  -H "content-type: application/json" \
  -d '{"conversationId":"<conversation id>","preferredResponse":"<better answer>","rejectedResponse":"<worse answer>","reviewed":true}'
```

The endpoint rejects missing or identical preferred/rejected answers. It references an existing `Conversation` row for the prompt and writes `UserFeedback`; it does not generate rejected answers.

## Open SFT Dataset Governance

For licensed open SFT data, run:

```bash
npm run download:datasets -- --all-open
npm run prepare:datasets -- --max-per-source 8000
npm run build:sft-mixture
npm run build:preference-mixture
npm run check:dataset-governance
```

`check:dataset-governance` verifies raw source provenance, allowed licenses, checksums, gated-source boundaries, processed source coverage, source-balanced eval seeds, output hashes, capped synthetic share, and obvious secret/PII scans. `check:contamination` audits train JSONL against held-out eval suites for exact ID matches, exact text matches, and high n-gram overlap. Both checks are included in `npm run check:production-readiness`, so a production training preflight fails if dataset governance or eval isolation regresses.

## Synthetic Examples

Run:

```bash
npm run generate:examples
```

`ToolExampleGenerator` derives deterministic template examples from the live registry: direct request, direct exact-tool-name request, casual phrasing, argument-explicit direct requests with `providedArgs`, natural direct hard cases, missing-argument clarification and hard cases with `missingArg` metadata, permission-denied refusal, permission-denied-with-args precedence rows, permission hard cases, success, failure, confirmation request and confirmation-with-args hard cases for gated tools, one DPO pair per tool, and global no-tool chat cases. It makes no external API calls and uses no randomness. Output: `exports/training/synthetic-tools.jsonl` plus DB rows with `source=SYNTHETIC` when the DB is reachable.

Synthetic data teaches format, not judgment. Cap its share of any training mixture.

For local scratch protocol experiments, run:

```bash
npm run build:protocol-sft
```

This writes `training/data/protocol/sft.train.jsonl`, `sft.validation.jsonl`, `sft.all.jsonl`, and `dataset_report.json`. The builder keeps synthetic provenance in metadata, strips synthetic tags from model-visible system prompts, excludes exact held-out protocol eval prompts, and adds deterministic paraphrases that stay outside the held-out prompt set. Protocol SFT rows also carry self-contained candidate-tool, exact candidate-tool-name, required-argument, provided-argument, missing-argument, no-tool, permission, and confirmation context when needed, so direct rows teach when required details are present, refusal rows teach "message, not tool_call or confirmation_request", no-tool rows teach that no candidate tool is available, and confirmed risky-tool rows teach that execution is allowed. Missing-argument examples are generated only for schema-required arguments, not optional/defaulted fields. The open-data preparer writes a source-balanced `eval.seed.jsonl` so the knowledge suite does not collapse to whichever source sorts first.

For local scratch behavior/persona experiments, run:

```bash
npm run build:behavior-sft
```

This writes `training/data/behavior/sft.train.jsonl`, `sft.validation.jsonl`, `sft.all.jsonl`, and `dataset_report.json`. Rows are project-owned ChatML examples whose assistant messages are strict protocol JSON (`message` or `clarification`). The builder skips exact prompts from `training/evals/behavior.eval.jsonl`, records `source=synthetic_behavior`, and tags each row by `kind` and `route` so a future router/MoE-style training split can isolate persona, casual, social-cue, boundary, and tool-abstain behavior.

For persona/social behavior regressions, run:

```bash
npm run build:behavior-eval
npm run eval:behavior:oracle
npm run eval:behavior -- --predictions training/evals/behavior-oracle.predictions.jsonl --out training/evals/behavior-oracle.report.json
npm run eval:behavior:gate -- --candidate training/evals/behavior-oracle.report.json

# Live configured model sample, then score it
npm run eval:behavior:llm -- --max-cases 5
npm run eval:behavior -- --predictions training/evals/behavior-llm.predictions.jsonl --out training/evals/behavior-llm.report.json
npm run eval:behavior:gate -- --candidate training/evals/behavior-llm.report.json
```

The behavior suite is held out from training and checks the she/her persona contract, affective persona wording, Discord-native casual replies, no generic refusal/filter language for allowed prompts, social support/repair, direct safety boundaries, and tool abstention for no-tool prompts. It is deliberately small today so it can act as a fast CI gate; grow it with reviewed first-party examples before using DPO to tune persona.

For voice-facing regressions, run:

```bash
npm run build:voice-eval
npm run eval:voice:oracle
npm run eval:voice -- --predictions training/evals/voice-oracle.predictions.jsonl --out training/evals/voice-oracle.report.json
npm run eval:voice:gate -- --candidate training/evals/voice-oracle.report.json
```

The voice suite is held out from training and checks transcript exact/F1 quality, speaker attribution, no-reply turn-taking, response latency, social timing, and raw-audio/training retention defaults. Live end-to-end Discord speak/listen validation is still required before treating voice as production quality.

For the MoE-style specialist router path, run:

```bash
npm run build:router-eval
npm run build:router-sft
npm run eval:router:oracle
npm run eval:router
npm run eval:router:gate -- --out training/evals/specialist-routing-oracle.gate.json
```

This writes a separate router SFT set under `training/data/router/` and a held-out `training/evals/specialist-routing.eval.jsonl` suite. The router rows are not mixed into the main assistant SFT because their assistant output is route-label JSON, not a user-facing assistant action. The current routes are `tool_protocol`, `knowledge`, `persona`, `casual`, `social_cue`, and `boundary`, mapped onto tool, knowledge, conversation, and safety experts.

For approved-skill retrieval regressions, run:

```bash
npm run build:skill-eval
npm run eval:skill
npm run eval:skill:gate
```

The skill retrieval suite checks direct tool matches, paraphrases, no-hit cases, and filtering of unapproved/non-retrievable skill records. Promotion requires perfect recall, precision, top-1 accuracy for expected skills, no-hit accuracy, and zero forbidden hits before changing runtime retrieval behavior.

For memory-continuity regressions, run:

```bash
npm run build:memory-eval
npm run eval:memory
npm run eval:memory:gate
```

The memory continuity suite checks explicit remember/recall, implicit stable-preference capture, USER/GUILD/CHANNEL scope isolation, owner/admin forget behavior, non-owner delete denial, secret/one-off policy rejection, and learned-item capture. Promotion requires perfect pass, recall, isolation, forget, rejection, and learned-item rates before changing runtime memory behavior.

## Review Workflow

1. Export and sample-read each file.
2. Redact or drop anything sensitive. `MemoryPolicy` blocks secrets from memory, but raw traces can still contain arbitrary user text.
3. Flip `reviewed=true` on vetted rows; train only on reviewed slices once volume allows.
4. Hold out an eval slice and never train on it.

## Privacy And Compliance

- Discord's Developer Policy prohibits using Discord message content to train ML models without permission. Use logs only from servers you control, with explicit member consent and a posted privacy policy. Do not scrape.
- Honor deletion requests end-to-end: conversations, training examples, memories, and exported files.
- Treat the DB and exports as sensitive data stores.
