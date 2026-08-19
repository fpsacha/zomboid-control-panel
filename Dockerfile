# Zomboid Control Panel - Docker
# Multi-stage build: build client in stage 1, lean runtime in stage 2.
#
# Runtime uses Debian slim because SteamCMD requires glibc, Bash, and 32-bit
# libraries on amd64. On CentOS/RHEL hosts with SELinux, use `:z` on
# bind-mount volumes (already set in docker-compose.yml).
#
# IMPORTANT: This image runs the *panel*, not the Project Zomboid server.
# PZ runs separately (on the host or in another container). See docker-compose.yml
# for realistic topology examples.

# --- Build stage ---
# Pinned to $BUILDPLATFORM (the build host's native arch, not the target
# one): this stage only produces static client assets (client/dist — plain
# JS/CSS/HTML, no native binaries in the output), so there's nothing
# architecture-specific to gain from building it per-target. Without this
# pin, buildx runs `npm install`/`vite build` under QEMU for every non-native
# target platform (e.g. arm64 on GitHub's amd64 runners) — esbuild/rollup's
# native binaries under emulation are dramatically slower and can hang for
# a very long time instead of the ~30s this takes natively.
FROM --platform=$BUILDPLATFORM node:26-alpine AS builder

WORKDIR /app

# Install client dependencies (includes devDeps for build tooling).
# We use `npm install` rather than `npm ci` because esbuild/@emnapi ship
# OS-specific optional binaries; a Windows-generated lockfile won't contain
# the linux/amd64 + linux/arm64 entries that `npm ci` requires.
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm install --no-audit --prefer-offline --include=optional

# Copy client source and build.
# The root package.json is needed because vite.config.ts reads the panel version from it.
COPY package.json ./
COPY client/ ./client/
RUN cd client && npm run build

# --- Runtime stage ---
FROM node:26-bookworm-slim

# The panel supports arm64 for remote-server administration. SteamCMD itself
# is only usable on amd64, where its 32-bit runtime libraries are installed.
RUN set -eux; \
        apt-get update; \
        apt-get install -y --no-install-recommends bash ca-certificates curl procps tar util-linux wget; \
        if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
            apt-get install -y --no-install-recommends lib32gcc-s1 lib32stdc++6; \
        fi; \
        rm -rf /var/lib/apt/lists/*

# Configurable UID/GID to match the host user — avoids bind-mount permission issues.
# Override at build time:
#   docker compose build --build-arg UID=$(id -u) --build-arg GID=$(id -g)
# node:22-bookworm-slim already ships with a `node` user at 1000:1000, so we
# reuse existing numeric IDs when possible.
ARG UID=1000
ARG GID=1000
RUN set -eux; \
    if getent group "$GID" >/dev/null 2>&1; then \
        groupname=$(getent group "$GID" | cut -d: -f1); \
    else \
        groupadd -g "$GID" panel; \
        groupname="panel"; \
    fi; \
    if getent passwd "$UID" >/dev/null 2>&1; then \
        :; \
    else \
        useradd -u "$UID" -g "$groupname" -M -s /usr/sbin/nologin panel; \
    fi

WORKDIR /app

# Install server dependencies only (no devDeps).
# Same reasoning as the client: cross-platform optional deps make `npm ci` fragile.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --prefer-offline --omit=dev

# Copy server source
COPY server/ ./server/

# Copy built client from builder stage
COPY --from=builder /app/client/dist ./client/dist

# Copy PanelBridge mod so users can extract it (docker cp)
COPY pz-mod/ ./pz-mod/

# Runtime PUID/PGID support is handled before Node starts.
COPY docker/entrypoint.sh /usr/local/bin/zomboid-panel-entrypoint
RUN chmod 0755 /usr/local/bin/zomboid-panel-entrypoint

# The extension bundle is served when present, but its source is not currently
# tracked in Git and `release/` is intentionally excluded from Docker builds.
# Do not COPY a generated local ZIP here: that breaks clean GitHub/CI builds.

# Create runtime directories owned by the panel user (numeric IDs survive
# the case where we're reusing the base image's existing user).
RUN mkdir -p data logs && chown -R ${UID}:${GID} /app

EXPOSE 3001

ENV NODE_ENV=production \
    PUID=1000 \
    PGID=1000

# Healthcheck hits the unauthenticated /api/health endpoint.
# start_period is generous because first-run DB init + JWT secret generation can be slow on cold disks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "import('http').then(h => h.get('http://localhost:3001/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1)))"

ENTRYPOINT ["/usr/local/bin/zomboid-panel-entrypoint"]
CMD ["node", "server/index.js"]
