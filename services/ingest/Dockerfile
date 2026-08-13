# Tollway ingest + dashboard v1. Build from the repo root:
#   docker build -f services/ingest/Dockerfile -t tollway-ingest .
#   docker run -p 8787:8787 -v tollway-data:/data \
#     -e TW_API_KEYS='sk_live_x:acct_9d2' -e TW_DATA_DIR=/data tollway-ingest
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY services/ingest/package.json services/ingest/
COPY packages/ingest/package.json packages/ingest/
RUN pnpm install --frozen-lockfile --filter @tollway/service-ingest... --filter @tollway/core...
COPY packages/core packages/core
COPY packages/ingest packages/ingest
COPY services/ingest services/ingest
RUN pnpm --filter @tollway/core build && pnpm --filter @tollway/service-ingest build

FROM node:22-slim
ENV NODE_ENV=production PORT=8787 TW_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app /app
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "services/ingest/dist/main.js"]
