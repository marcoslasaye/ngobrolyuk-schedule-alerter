# Schedule Alerter — production Docker image
#
# Multi-stage build:
#   deps   → install all dependencies (needed to compile TypeScript)
#   build  → compile to dist/
#   runtime→ minimal image with production deps + compiled output, non-root
#
# Build:    docker build -t schedule-alerter .
# Run once: docker run --rm --env-file .env -v $(pwd)/config.yaml:/app/config.yaml schedule-alerter run-once
# Daemon:   docker run -d --env-file .env \
#             -v $(pwd)/config.yaml:/home/nodeapp/.schedule-alerter/config.yaml \
#             -v schedule-cache:/home/nodeapp/.schedule-cache schedule-alerter start
#
# Configuration is injected in two ways:
#   - config.yaml (mount it into /app/config.yaml or ~/.schedule-alerter/), and
#   - secret values via environment variables (WHATSAPP_API_KEY, WHATSAPP_PHONE,
#     SMTP_USER, SMTP_PASS), which the config's ${VAR} placeholders read.
# The schedule cache lives at ~/.schedule-cache/ inside the app user's home.

# ---------------------------------------------------------------------------
# Stage 1 — deps
# ---------------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests first so dependency layers are cached independently of source.
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2 — build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Compile TypeScript to dist/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Copy the compiled output and the example config (as a reference; the real
# config.yaml contains secrets and is mounted at runtime).
COPY --from=build /app/dist ./dist
COPY --from=build /app/config.yaml.example ./config.yaml.example
# package-lock.json is required by `npm ci` below.
COPY package.json package-lock.json ./

# Install only production dependencies (no dev tooling in the final image).
RUN npm ci --omit=dev

# Non-root user — the container runs with least privilege. The app reads its
# config from cwd(config.yaml) or ~/.schedule-alerter/config.yaml, and its
# cache from ~/.schedule-cache/. Ensure the app user can write both.
RUN addgroup -S nodeapp && adduser -S nodeapp -G nodeapp \
  && mkdir -p /home/nodeapp/.schedule-alerter /home/nodeapp/.schedule-cache \
  && chown -R nodeapp:nodeapp /home/nodeapp

USER nodeapp

# Verify the compiled app is loadable on every healthy tick. Catches a broken
# build at run time without needing secrets or a network call.
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "import('./dist/index.js').then(function(){process.exit(0)},function(){process.exit(1)})"

# Default: run the continuous daemon. Override with "run-once" for a single
# cycle (e.g. scheduled runs) or "test-config" / "test-notifier".
CMD ["node", "dist/cli.js", "start"]
