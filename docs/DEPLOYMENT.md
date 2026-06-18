# Deployment

## Local development (recommended loop)

```bash
docker compose up -d            # postgres (pgvector) + redis + qdrant
cp .env.example .env            # fill DISCORD_TOKEN at minimum
npm install
npx prisma migrate deploy
npm run dev                     # tsx watch mode; Ollama on the host
```

## Single-host production (Docker)

```bash
docker compose --profile app up -d --build
```

The `app` service builds the multi-stage `Dockerfile` (compiled JS, prod deps only), runs `prisma migrate deploy` on start, and reaches a host-side LLM server via `host.docker.internal`. For a GPU box running vLLM/Ollama alongside, that's the whole deployment.

Bare-metal alternative: `npm run build && node dist/src/index.js` under systemd/PM2 with the same env.

## Production checklist

| Item | Status / action |
|---|---|
| Secrets | Env only (`.env` is gitignored). Use your platform's secret store; never bake into images |
| API exposure | The Fastify API is **unauthenticated** — keep `API_HOST` on a private interface or add auth/reverse-proxy before exposing |
| SubQ / SSA long context | Keep `SUBQ_ENABLED=false` until you have assigned SubQ API values and a workload that needs multi-million-token context. Use `metadata.longContext=true` only for full-repo, long-history, or large-artifact requests, then run `npm run eval:long-context:llm -- --preferred-provider subq` plus `npm run eval:long-context:gate` and compare cost/latency/quality against the local/open-weight path |
| Parameter trainer endpoint | Keep `PARAMETER_TRAINER_ENDPOINT` empty until a private trainer service exists. `npm run dispatch:parameter-training -- --dry-run` exercises the contract without spending compute; non-dry-run dispatch should only target trusted internal infrastructure |
| Parameter hotload endpoint | `npm run serve:parameter-hotload` provides the private control contract with auth/status/rollback state and a `state-only` backend; a real model-server backend adapter is still required before it actually attaches LoRA/specialist weights. Never expose this endpoint publicly |
| Database | Managed Postgres with pgvector available (or the bundled image); backups on; `prisma migrate deploy` in CI/CD |
| Logs | pino JSON to stdout → your aggregator. `LOG_LEVEL=info` |
| Cooldowns/rate limits | In-process today → fine for one replica. Before scaling replicas: implement the Redis `CooldownStore` + move rate limits/pending confirmations to Redis (interfaces ready) |
| Job queue | In-process today → swap `InProcessJobQueue` for BullMQ on the provisioned Redis for durability/retries |
| Moderation | Regex placeholder — wire a real moderation model before opening to untrusted servers (see ARCHITECTURE.md) |
| Sharding | Required at 2,500 guilds; do the Redis migration first, then discord.js sharding is straightforward |
| Health monitoring | `GET /health` + `GET /stats`; alert on `status != ok` |
| Graceful shutdown | SIGTERM handled (queue stop → API close → Discord destroy → DB disconnect) — works with rolling deploys |

## Scaling path (when it hurts)

1. One process, one box (now) →
2. Redis-backed cooldowns/limits/queue, same box →
3. Postgres read replica + Qdrant for vectors if pgvector filtered-search latency bites →
4. Shard the gateway; keep the API/worker processes separate from gateway processes.
