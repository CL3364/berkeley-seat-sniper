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
FROM node:22-slim AS runtime

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
COPY --from=builder /app/dist ./dist

# Copy application source (tsx runs TypeScript directly in production, as designed).
COPY src ./src

# Copy DB migrations (needed by db:migrate / migrate.ts at startup).
COPY drizzle ./drizzle
COPY drizzle.config.ts ./drizzle.config.ts
COPY tsconfig.json ./tsconfig.json

# Drop to non-root.
USER appuser

# All secrets come from the environment — never baked in.
# TOKEN_SECRET, DATABASE_URL, MAIL_TRANSPORT, etc. are injected at runtime.
ENV NODE_ENV=production

EXPOSE 8787

# Healthcheck against the API. The server currently mounts /api/* routes; if the
# api teammate adds /api/health explicitly, update the path here. Until then we
# probe the root path (Hono returns 404 JSON which is still "alive").
# See coordination note in the infra report.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/api/health').then(r => { if (!r.ok && r.status !== 404) process.exit(1) }).catch(() => process.exit(1))"

# Run the Hono server via tsx (it is a production dependency).
CMD ["node_modules/.bin/tsx", "src/server/index.ts"]
