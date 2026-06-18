# Local LLM Setup

The bot talks to any OpenAI-compatible `/v1/chat/completions` endpoint, plus Ollama's native `/api/chat`. Pick one backend below, point `.env` at it, and verify with `npm run test-llm`.

## Option A — Ollama (easiest)

1. Install: <https://ollama.com/download> (Windows/macOS/Linux).
2. Pull a model:
   ```bash
   ollama pull qwen2.5:7b-instruct
   ollama pull nomic-embed-text          # embeddings for memory
   ```
3. Ollama serves on `http://localhost:11434` automatically, exposing **both** a native API and an OpenAI-compatible API at `/v1`.
4. `.env` (this is the default configuration):
   ```ini
   LLM_PROVIDER=openai-compatible
   LLM_BASE_URL=http://localhost:11434/v1
   LLM_MODEL=qwen2.5:7b-instruct
   EMBEDDING_BASE_URL=http://localhost:11434/v1
   EMBEDDING_MODEL=nomic-embed-text
   ```
   To use the native endpoint instead: `LLM_PROVIDER=ollama` (uses `OLLAMA_BASE_URL`/`OLLAMA_MODEL`).

## Option B — vLLM (production-grade throughput)

vLLM is the recommended server once you're past development — continuous batching gives roughly an order of magnitude more throughput than Ollama under concurrency.

```bash
pip install vllm
vllm serve Qwen/Qwen2.5-7B-Instruct --port 8000
```

```ini
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:8000/v1
LLM_MODEL=Qwen/Qwen2.5-7B-Instruct
```

## Option C — LM Studio (GUI)

1. Install <https://lmstudio.ai>, download a model in the UI.
2. Start the local server (Developer tab) — default `http://localhost:1234/v1`.
3. ```ini
   LLM_PROVIDER=openai-compatible
   LLM_BASE_URL=http://localhost:1234/v1
   LLM_MODEL=<model id shown in LM Studio>
   ```

## Option D — SubQ / Subquadratic Sparse Attention (long context)

Use SubQ when Irene needs multi-million-token context for full repositories, long-running memory/state reviews, or large artifact reasoning. SubQ's public materials describe an OpenAI-compatible API and a subquadratic sparse-attention architecture, so it plugs into the same provider path as vLLM or LM Studio once you have access.

Keep a local/open-weight model as the normal primary model. Enable SubQ as the named long-context provider so code paths can explicitly request it with `metadata.longContext=true` or `metadata.preferredProvider="subq"`:

```ini
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=local
LLM_MODEL=qwen2.5:7b-instruct

SUBQ_ENABLED=true
SUBQ_BASE_URL=<your SubQ OpenAI-compatible /v1 base URL>
SUBQ_API_KEY=<your SubQ API key>
SUBQ_MODEL=<your SubQ model id>
SUBQ_TIMEOUT_MS=600000
```

Do not hardcode guessed SubQ URLs or model ids. Use the values assigned to your account or private preview. Promotion still requires the same tool, behavior, memory, parameter-growth, and long-context eval gates; a longer context window does not by itself prove better tool-call reliability. For the first SubQ route check, run:

```bash
npm run build:long-context-eval
npm run eval:long-context:llm -- --preferred-provider subq --max-cases 25
npm run eval:long-context -- --predictions training/evals/long-context-llm.predictions.jsonl --out training/evals/long-context-llm.report.json
npm run eval:long-context:gate -- --candidate training/evals/long-context-llm.report.json
```

## Testing the endpoint

```bash
# Raw check
curl http://localhost:11434/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "qwen2.5:7b-instruct",
  "messages": [{"role": "user", "content": "Reply with the single word: pong"}]
}'

# Project check (chat + embeddings)
npm run test-llm
```

## Recommended models

Tool calling + strict JSON output quality is what matters most for this bot. Check the live Berkeley Function-Calling Leaderboard before committing — rankings move.

| Class | Models | Notes |
|---|---|---|
| Qwen 7B/14B Instruct | `qwen2.5:7b-instruct`, `qwen2.5:14b-instruct` (and newer Qwen3-family equivalents) | Best small-model JSON/tool discipline in our experience; default choice |
| Llama 8B class | `llama3.1:8b-instruct` and successors | Strong general chat |
| Gemma class | `gemma2:9b-it` and successors | Good quality/VRAM ratio |
| Mistral class | `mistral:7b-instruct`, Nemo-class | Fast, decent JSON |

## Hardware expectations

| Model size | Quantized (Q4-class) VRAM | Notes |
|---|---|---|
| 7–9B | ~8–12 GB | RTX 3060 12GB / 4070 territory; CPU-only works but is slow |
| 13–14B | ~16–24 GB | RTX 4090 / 3090 territory |
| 30B+ | 24–48+ GB | Multi-GPU or workstation cards |
| 70B | 2×24 GB+ or H100-class | Only when quality demands it |

Embeddings (`nomic-embed-text`) are tiny (<1 GB) and fine on CPU.

## Why fine-tune open weights instead of training from scratch?

Training a usable conversational LLM from scratch costs millions of GPU-hours and needs trillions of tokens — not a realistic path for this project, and not a useful one: open-weight instruct models already encode language, conversation, and reasoning. What they *don't* know is **your** tool protocol, your servers' tone, and your memory conventions. That delta is exactly what parameter-efficient fine-tuning (QLoRA) on a few thousand high-quality logged interactions teaches — for GPU-days, not GPU-years, on a single 24 GB card. The full plan is in `FINE_TUNING_PLAN.md`.

## Honest limitation: the hashing embedding fallback

`EMBEDDING_PROVIDER=hashing` exists so tests/offline dev run without a model server. It is character-trigram hashing — **lexical, not semantic**. "What's my timezone" will match "my timezone is CET" but not "I live in Berlin". Use a real embedding model for anything beyond development.
