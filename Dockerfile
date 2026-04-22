# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Install system tools needed at runtime (openssl for DKIM, postfix-utils for postmap)
RUN apk add --no-cache openssl

# Create non-root user (but agent still needs root in production for postfix/dovecot)
RUN addgroup -S agentgroup && adduser -S agent -G agentgroup

COPY --from=builder /app/dist       ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Log directory
RUN mkdir -p /var/log/apex-vps-agent && chown agent:agentgroup /var/log/apex-vps-agent

EXPOSE 3001

# Health check using the liveness endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health/live || exit 1

USER agent
CMD ["node", "dist/index.js"]