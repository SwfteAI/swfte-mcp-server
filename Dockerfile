# syntax=docker/dockerfile:1.7
# ---- build stage ----
# Base image pinned by digest (node:22-alpine as of 2026-09-30); bump deliberately.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

LABEL org.opencontainers.image.title="Swfte MCP Server" \
      org.opencontainers.image.description="Official Model Context Protocol server for the Swfte AI platform — agents, chatflows, workflows, RAG, voice, marketplace." \
      org.opencontainers.image.url="https://www.swfte.com" \
      org.opencontainers.image.source="https://github.com/SwfteAI/swfte-mcp-server" \
      org.opencontainers.image.documentation="https://www.swfte.com/developers" \
      org.opencontainers.image.vendor="Swfte, Inc." \
      org.opencontainers.image.licenses="MIT"

USER node
ENTRYPOINT ["node", "dist/index.js"]
