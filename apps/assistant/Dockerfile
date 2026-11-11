# syntax=docker/dockerfile:1.7
# Arcanada Assistant — single-stage runtime image (corepack-managed pnpm).
# Multi-stage was reverted: pnpm deploy --legacy doesn't copy generated
# `.prisma/client` (lives outside any workspace pkg) — leads to MODULE_NOT_FOUND
# at runtime. Single stage keeps the workspace intact so Prisma's generated
# files stay reachable via the same .pnpm symlinks the build used.

FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
WORKDIR /workspace
ENV NODE_ENV=production \
    PORT=3800

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY apps/assistant/package.json apps/assistant/

RUN pnpm install --frozen-lockfile

COPY packages/core ./packages/core
COPY apps/assistant ./apps/assistant

RUN pnpm --filter @arcanada/core build \
 && cd apps/assistant \
 && DATABASE_URL=postgresql://stub:stub@stub/stub pnpm exec prisma generate \
 && cd .. \
 && pnpm --filter assistant build

EXPOSE 3800

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3800/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

WORKDIR /workspace/apps/assistant
CMD ["node", "dist/main.js"]
