# syntax=docker/dockerfile:1
#
# CommitteeFlow — single runtime image (spec §29).
#
#   Stage 1  deps     install workspace dependencies from the lockfile
#   Stage 2  build    compile the React SPA and the TypeScript server
#   Stage 3  runtime  Node serving  ./client/dist  and  /api/*
#
# The React app deliberately has no runtime container of its own.

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

# `npm ci` guarantees the lockfile is honoured exactly.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 2 — build
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

# npm workspaces hoist to the root `node_modules`, and only nest a package when
# a version conflict forces it — so the whole installed tree is copied rather
# than assuming a directory exists per workspace. `.dockerignore` keeps the
# source copy below from clobbering it.
COPY --from=deps /app ./
COPY . .

RUN npm run build --workspace client \
 && npm run build --workspace server

# Drop dev dependencies so only runtime packages are carried forward.
RUN --mount=type=cache,target=/root/.npm \
    npm prune --omit=dev --no-audit --no-fund

# Assemble exactly what the runtime needs. Application source never ships —
# `server/assets` does, because the PDF export reads its fonts from disk at run
# time and has to render identically here and on a developer's machine.
RUN set -eux; \
    mkdir -p /out/server /out/client; \
    cp package.json /out/package.json; \
    cp -R node_modules /out/node_modules; \
    cp -R server/dist /out/server/dist; \
    cp -R server/migrations /out/server/migrations; \
    cp -R server/scripts /out/server/scripts; \
    cp -R server/assets /out/server/assets; \
    cp server/package.json /out/server/package.json; \
    cp -R client/dist /out/client/dist; \
    if [ -d server/node_modules ]; then cp -R server/node_modules /out/server/node_modules; fi; \
    if [ -d client/node_modules ]; then cp -R client/node_modules /out/client/node_modules; fi

# The base image carries no Arabic font, and the export no longer draws with the
# standard PDF ones — so a missing asset would not fail the build, it would ship
# a silently broken export (BUG-014). Fail here instead, where it is cheap.
RUN test -f /out/server/assets/fonts/Cairo-Regular.ttf \
 && test -f /out/server/assets/fonts/Cairo-Bold.ttf \
 && test -f /out/server/assets/fonts/OFL.txt

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    CLIENT_DIST_PATH=/app/client/dist

WORKDIR /app

# tini reaps zombies and forwards SIGTERM, so shutdown is clean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

# `node` (uid 1000) ships with the base image — never run the app as root.
COPY --from=build --chown=node:node /out /app

USER node
EXPOSE 4000

# No secrets are baked into the image (spec §63, §66) — everything arrives via
# the runtime environment.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/server.js"]
