# syntax=docker/dockerfile:1.7

# ---- Database operations image ---------------------------------------------
# Restic encrypts every repository object before upload.  Keeping pg_dump and
# restic in a separate target means neither binary is added to the application
# runtime image.
FROM restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510 AS restic

FROM postgres:16-alpine AS db-ops

COPY --from=restic /usr/bin/restic /usr/local/bin/restic

ENV RESTIC_CACHE_DIR=/tmp/restic-cache

# A named volume may be initialized by either the API or backup image first.
# The sticky shared directory lets the non-root backup UID atomically replace
# its world-readable marker while the API receives the same volume read-only.
RUN mkdir -p /var/lib/seat-sniper-backup-status && \
    chmod 1777 /var/lib/seat-sniper-backup-status

USER postgres

# ---- Stage 1: builder -------------------------------------------------------
# Installs all deps (including devDependencies needed for tsc + vite), typechecks,
# and produces the compiled SPA in dist/web.
FROM node:22-slim AS builder

WORKDIR /app

# Copy manifests first so the layer is cached as long as they don't change.
COPY package.json package-lock.json ./

# Install ALL deps (devDependencies are needed for tsc + vite build).
RUN npm ci

# Copy source. .dockerignore keeps node_modules and dist out of the context.
COPY . .

# tsc --noEmit (typecheck) + vite build → dist/web
RUN npm run build

# ---- Stage 2: runtime -------------------------------------------------------
# Lean image: only production deps + the built SPA. Non-root user, secrets from env.
FROM node:22-slim AS app

# Label for image metadata (no secrets here).
LABEL org.opencontainers.image.source="https://github.com/CL3364/berkeley-seat-sniper"

WORKDIR /app

# Create a non-root user/group before copying any files.
RUN groupadd --gid 1001 appgroup && \
    useradd --uid 1001 --gid appgroup --shell /bin/sh --create-home appuser

# Copy manifests and install ONLY production dependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the compiled SPA from the builder stage.
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist

# Copy application source (tsx runs TypeScript directly in production, as designed).
COPY --chown=appuser:appgroup src ./src

# Copy DB migrations (needed by db:migrate / migrate.ts at startup).
COPY --chown=appuser:appgroup drizzle ./drizzle
COPY --chown=appuser:appgroup drizzle.config.ts ./drizzle.config.ts
COPY --chown=appuser:appgroup tsconfig.json ./tsconfig.json

# The runtime heartbeat is writable by the app user. The backup-status
# directory initializes a cross-image named volume safely regardless of which
# service mounts it first; production mounts it read-only in the API.
RUN mkdir -p /app/runtime /app/backup-status && \
    chown appuser:appgroup /app/runtime && \
    chmod 1777 /app/backup-status

# Drop to non-root.
USER appuser

# All secrets come from the environment — never baked in.
# TOKEN_SECRET, DATABASE_URL, MAIL_TRANSPORT, etc. are injected at runtime.
ENV NODE_ENV=production

EXPOSE 8787
STOPSIGNAL SIGTERM

# Healthcheck against the API liveness probe. /api/health returns 200 { status: 'ok' }
# (src/server/app.ts). Treat ANY non-200 response (or a fetch error) as unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/api/health').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

# Run the Hono server via tsx (it is a production dependency).
CMD ["node_modules/.bin/tsx", "src/server/index.ts"]
