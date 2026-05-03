# Arcanada Assistant

> **Жизнь одного человека имеет значение** / **One human life matters**

Единая точка входа в экосистему Arcanada — Telegram-бот с AI-оркестратором, маршрутизирующим запросы к специализированным агентам (Work, Knowledge, Ops).

- **Bot:** [`@ArcanadaAssistantBot`](https://t.me/ArcanadaAssistantBot)
- **Webhook domain:** `assistant.arcanada.one`
- **Port:** 3800 (PROD 65.108.236.39, Tailscale-only за nginx + Cloudflare)
- **Status:** scaffold — Phase 1 (см. [PRD-ARCA-0001](../../../../datarim/prd/PRD-ARCA-0001-arcanada-assistant.md))

## AAL Status

**current_aal:** `L1` (scaffold + Docker + CI/CD)
**target_aal:** `L4` (cost circuit breakers, fallback chain, self-heal events)

Roadmap → ARCA-0007 (L2) → ARCA-0009 (L3) → ARCA-0010..0012 (L4). См. [`Areas/Architecture/AAL-Classification.md`](../../../../Areas/Architecture/AAL-Classification.md).

## Architecture

- **Monorepo:** pnpm workspaces (`packages/core` + `apps/assistant`)
- **Stack:** NestJS 11 + Fastify 5 + Prisma 7 + Zod v4 + Telegraf + BullMQ + ioredis + pino + jose + opossum
- **Shared lib:** `@arcanada/core` (reusable для будущего Argana AI / Arganize.me)
- **Memory:** Redis (session 24h TTL, instructions persistent SET, profile cache 10min) + Postgres (User/Conversation/Message с append-only audit trigger) + Scrutator namespace `assistant-ltm-{user_id}` (LTM)
- **Auth:** Auth Arcana JWT через JWKS (per Auth Arcana Mandate)
- **LLM:** через Model Connector (`connector.arcanada.one:3900`) — никаких прямых SDK Anthropic/OpenAI

См. полный creative-документ: [`creative-ARCA-0005-architecture.md`](../../../../datarim/creative/creative-ARCA-0005-architecture.md).

## Development

### Prerequisites

- Node 24+ (`.nvmrc` pinned)
- pnpm 10+ (corepack-managed)
- Docker (для local Postgres + Redis + integration tests)

### Setup

```bash
nvm use            # читает .nvmrc
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env  # заполнить TELEGRAM_BOT_TOKEN, DATABASE_URL, REDIS_URL, AUTH_ARCANA_JWKS_URL
docker compose up -d postgres redis
pnpm --filter assistant prisma migrate deploy
```

### Run

```bash
pnpm --filter assistant start:dev    # http://localhost:3800
```

### Test

```bash
pnpm test                  # all packages
pnpm test:coverage         # ≥80% lines required
pnpm audit:prod            # CI gate (high+ severity)
```

### Build

```bash
pnpm build                 # tsc per package
docker compose build       # production image
```

## Deployment

- **CI/CD:** GitHub Actions (lint → test → audit → build → deploy → verify), self-hosted runner на PROD `arcana-prod`
- **Deploy path:** `/opt/arcanada-assistant/` (owner `ci-runner:ci-runner` recursive per INFRA-0040)
- **TLS:** Cloudflare Origin Cert (15y) + nginx Full (strict)
- **Health endpoint:** `https://assistant.arcanada.one/health`
- **Failure notification:** POST `https://ops.arcanada.one/events` category `fatal`

## Security

- `pnpm audit --prod --audit-level=high` — CI gate (currently clean с `pnpm.overrides.fastify: ^5.8.5` для CVE GHSA-247c-9743-5963)
- Secret management: HashiCorp Vault (Tailscale `:8200`) — никаких секретов в коде/`.env*` git
- JWT validation: `jose.createRemoteJWKSet` cache 10min, fail-closed
- Telegram webhook: `secret_token` header mandatory
- Container: non-root user, read-only root FS, `cap_drop: ALL`

## Project Structure

```
arcanada-assistant/
├── packages/
│   └── core/                          # @arcanada/core — reusable shared lib
│       ├── src/
│       │   ├── auth/jwt.guard.ts
│       │   ├── health/dep-probe.ts
│       │   ├── types/zod.ts
│       │   └── index.ts
│       └── tests/
└── apps/
    └── assistant/                     # NestJS+Fastify app, port 3800
        ├── src/
        │   ├── main.ts
        │   ├── app.module.ts
        │   ├── config/configuration.ts
        │   ├── webhook/{telegram.controller,echo.handler}.ts
        │   ├── health/health.controller.ts
        │   └── database/{prisma,redis}.module.ts
        ├── prisma/schema.prisma
        ├── tests/
        ├── Dockerfile
        └── openapi.json
```

## License

MIT — см. [`LICENSE`](./LICENSE).

## Source of Truth

- **Datarim task:** ARCA-0006 (`datarim/tasks/ARCA-0006-task-description.md`)
- **PRD:** [`PRD-ARCA-0001`](../../../../datarim/prd/PRD-ARCA-0001-arcanada-assistant.md)
- **Architecture creative:** [`creative-ARCA-0005-architecture.md`](../../../../datarim/creative/creative-ARCA-0005-architecture.md)
- **Audit fixtures:** [`tasks/ARCA-0006-fixtures.md`](../../../../datarim/tasks/ARCA-0006-fixtures.md)
