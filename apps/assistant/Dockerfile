# syntax=docker/dockerfile:1.7
# Arcanada Assistant — multi-stage build (corepack-managed pnpm).

ARG NODE_VERSION=24-alpine

# ───────── Stage 1: builder ─────────
FROM node:${NODE_VERSION} AS builder
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY apps/assistant/package.json apps/assistant/

RUN pnpm install --frozen-lockfile

COPY packages/core ./packages/core
COPY apps/assistant ./apps/assistant

RUN pnpm --filter @arcanada/core build
RUN cd apps/assistant && DATABASE_URL=postgresql://stub:stub@stub/stub pnpm exec prisma generate
RUN pnpm --filter assistant build

RUN pnpm --filter assistant deploy --prod /deploy/assistant

# ───────── Stage 2: runner ─────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3800

RUN addgroup -g 1001 -S app && adduser -S -u 1001 -G app app

COPY --from=builder --chown=app:app /deploy/assistant ./
COPY --from=builder --chown=app:app /workspace/apps/assistant/prisma ./prisma

USER app
EXPOSE 3800

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3800/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
