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
# target platform (e.g. arm64 on GitHub's amd64 runners) — Rolldown/lightningcss's
# native binaries under emulation are dramatically slower and can hang for
# a very long time instead of the ~30s this takes natively.
#
# Base images are pinned by digest (the tag stays for readers and for
# Dependabot, which proposes digest updates): a re-pushed tag can't change
# what this builds.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder

WORKDIR /app

# Install client dependencies (includes devDeps for build tooling) exactly as
# client/package-lock.json pins them. The lockfile carries the linux gnu and
# musl entries of Rolldown/lightningcss's platform binaries, so `npm ci` finds
# the musl one this Alpine stage needs.
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci --no-audit --prefer-offline

# Copy client source and build.
# The root package.json is needed because vite.config.ts reads the panel version from it.
COPY package.json ./
COPY client/ ./client/

# The FRONTEND needs the sha too. client/vite.config.ts already prefers
# process.env.PANEL_BUILD_SHA over shelling out to git, and the builder stage has no .git
# either -- so without this the bundle bakes in "unknown" while the backend reports the real
# sha, and the build-compatibility gate compares "unknown" against it and blocks the UI.
# Both halves must be given the same value or the check compares two different things.
ARG PANEL_BUILD_SHA=""
ENV PANEL_BUILD_SHA=${PANEL_BUILD_SHA}
RUN cd client && npm run build

# --- Runtime stage ---
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# The panel supports arm64 for remote-server administration. SteamCMD itself
# is only usable on amd64, where its 32-bit runtime libraries are installed.
RUN set -eux; \
        apt-get update; \
        apt-get upgrade -y --no-install-recommends; \
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

# Install server dependencies only (no devDeps), exactly as package-lock.json
# pins them.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --prefer-offline --omit=dev \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm

# Copy server source
COPY server/ ./server/

# Copy built client from builder stage
COPY --from=builder /app/client/dist ./client/dist

# Copy PanelBridge mod so users can extract it (docker cp)
COPY pz-mod/ ./pz-mod/

# Runtime PUID/PGID support is handled before Node starts.
COPY docker/entrypoint.sh /usr/local/bin/zomboid-panel-entrypoint
RUN chmod 0755 /usr/local/bin/zomboid-panel-entrypoint
COPY docker/healthcheck.cjs /usr/local/lib/zomboid-panel/healthcheck.cjs

# The extension bundle is served when present, but its source is not currently
# tracked in Git and `release/` is intentionally excluded from Docker builds.
# Do not COPY a generated local ZIP here: that breaks clean GitHub/CI builds.

# Create runtime directories owned by the panel user (numeric IDs survive
# the case where we're reusing the base image's existing user).
RUN mkdir -p data logs && chown -R ${UID}:${GID} /app

# Build provenance. server/index.js prefers process.env.PANEL_BUILD_SHA over shelling out to
# `git rev-parse HEAD`, which cannot work in an image: there is no .git and no git binary. Passing
# the sha in makes the frontend/backend build-compatibility check meaningful in Docker rather than
# merely non-fatal. CI supplies this via --build-arg; a local `docker build` without it simply
# leaves the sha unknown, which is now harmless on its own.
ARG PANEL_BUILD_SHA=""
ENV PANEL_BUILD_SHA=${PANEL_BUILD_SHA}

EXPOSE 3001

ENV NODE_ENV=production \
    PUID=1000 \
    PGID=1000 \
    PANEL_PORT_FILE=/tmp/zomboid-panel.port

# start_period is generous because first-run DB init + JWT secret generation can be slow on cold disks.
# Hits the unauthenticated /api/health on the port the panel really listens
# on: it records that port in PANEL_PORT_FILE (PORT, the port saved in
# Settings, 3001, or a free one it picked), and the check falls back to
# PORT, then 3001, until it has.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD ["node", "/usr/local/lib/zomboid-panel/healthcheck.cjs"]

ENTRYPOINT ["/usr/local/bin/zomboid-panel-entrypoint"]
CMD ["node", "server/index.js"]
