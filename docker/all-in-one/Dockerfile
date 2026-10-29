# Base images are pinned by digest (the tag stays for readers and for
# Dependabot, which proposes digest updates for .github/dependabot.yml's
# docker entry): a re-pushed tag can't change what this builds.
#
# The official Node.js image. The client is built in it, and the runtime
# stage below copies Node.js out of it.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS node-image

FROM node-image AS client-build

WORKDIR /src
COPY package.json ./
# npm ci: exactly what client/package-lock.json pins (it carries the linux
# gnu and musl entries of every platform package the build needs).
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci --no-audit --prefer-offline
COPY client/ ./client/
# Same reasoning as the root Dockerfile: the frontend and the backend must be given the SAME
# build sha, or the build-compatibility gate compares "unknown" against a real sha and blocks
# the UI. No .git and no git binary exists in either stage.
ARG PANEL_BUILD_SHA=""
ENV PANEL_BUILD_SHA=${PANEL_BUILD_SHA}
RUN cd client && npm run build

# amd64 only (no arm64 build of SteamCMD); Debian trixie at the pinned digest.
FROM cm2network/steamcmd:root@sha256:e6b6b3503bf0e41feafe12dc709c90151afba193e1292cac55d28a7d470b1493

ARG PANEL_BUILD_SHA=""
ENV PANEL_BUILD_SHA=${PANEL_BUILD_SHA}

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
    curl ca-certificates lib32gcc-s1 lib32stdc++6 procps \
    && rm -rf /var/lib/apt/lists/*

# Node.js from the official image above instead of piping NodeSource's setup
# script into a root shell. Same Node 22 line; its binary needs glibc 2.28+
# and libstdc++, which the Debian base has. npm/npx are the image's own
# symlinks, recreated here; the version check fails the build, not the
# first start, if the binary can't run on this base.
COPY --from=node-image /usr/local/bin/node /usr/local/bin/node
COPY --from=node-image /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-image /usr/local/include/node /usr/local/include/node
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version \
    && npm --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --prefer-offline --omit=dev \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm

COPY server/ ./server/
COPY --from=client-build /src/client/dist ./client/dist
COPY pz-mod/ ./pz-mod/
COPY browser-extension/ ./browser-extension/
COPY docker/all-in-one/entrypoint.sh /entrypoint.sh
COPY docker/healthcheck.cjs /usr/local/lib/zomboid-panel/healthcheck.cjs

# setpriv (util-linux) is how the entrypoint drops to the steam user; fail the
# build, not the first start, if a base image update ever drops it.
RUN chmod +x /entrypoint.sh \
    && command -v setpriv >/dev/null \
    && mkdir -p /pz-server /pz-servers /zomboid /app/data /app/logs

# PANEL_ALL_IN_ONE tells the panel it runs in this image. The two PZ_*
# values below are what an older compose file (no pz-servers volume, only
# 16261-16262 published) gives it; the current docker-compose.yml overrides
# PZ_PUBLISHED_GAME_PORTS with its own range. The panel suggests
# PZ_EXTRA_SERVERS_PATH only when it is really a mounted volume.
ENV NODE_ENV=production \
    PANEL_ALL_IN_ONE=true \
    PZ_SERVER_PATH=/pz-server \
    PZ_SAVE_PATH=/zomboid \
    PZ_EXTRA_SERVERS_PATH=/pz-servers \
    PZ_PUBLISHED_GAME_PORTS=16261-16262 \
    PZ_SERVER_BAT=start-server.sh \
    RCON_HOST=127.0.0.1 \
    RCON_PORT=27015 \
    PANEL_PORT_FILE=/tmp/zomboid-panel.port

EXPOSE 3001 16261-16270/udp

# Hits the unauthenticated /api/health on the port the panel really listens
# on: it records that port in PANEL_PORT_FILE (PORT, the port saved in
# Settings, 3001, or a free one it picked), and the check falls back to
# PORT, then 3001, until it has.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD ["node", "/usr/local/lib/zomboid-panel/healthcheck.cjs"]

ENTRYPOINT ["/entrypoint.sh"]
