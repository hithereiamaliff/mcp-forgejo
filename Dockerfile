# Forgejo MCP Server - Streamable HTTP
# Multi-stage build: compile TypeScript in a builder image, ship only runtime files.

# ---- Build stage ---------------------------------------------------------------
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
# --ignore-scripts: skip the "prepare" build until the sources are copied
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build:tsc && npm prune --omit=dev

# ---- Runtime stage -------------------------------------------------------------
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    ANALYTICS_DIR=/app/data

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S mcp -u 1001 -G nodejs

COPY --from=builder --chown=mcp:nodejs /app/package.json ./
COPY --from=builder --chown=mcp:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=mcp:nodejs /app/dist ./dist

RUN mkdir -p /app/data && chown -R mcp:nodejs /app/data

USER mcp

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/http-server.js"]
