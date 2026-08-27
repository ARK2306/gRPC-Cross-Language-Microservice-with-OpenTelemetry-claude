# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Node.js REST gateway. Final image is < 300 MB.
#
#   protoc  -> regenerates shared/node from /proto
#   build   -> installs all deps, compiles TypeScript, prunes to a
#              self-contained production tree via `pnpm deploy`
#   runtime -> Alpine + that tree + dist output; no pnpm, no npm, no sources
#
# Build context is the REPOSITORY ROOT, not api/, because the build needs
# /proto, /scripts and the workspace manifests. See docker-compose.yml.

ARG NODE_VERSION=22.12.0
ARG PNPM_VERSION=9.15.4

# --------------------------------------------------------------------------
# Stage 1: compile the protobuf stubs.
# Separate from the build stage so editing the .proto does not invalidate the
# (much more expensive) dependency-install layer.
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS protoc

ARG PNPM_VERSION
# Installed from npm rather than via corepack: the corepack bundled with
# node:22.12 fails pnpm's signature check ("Cannot find matching keyid").
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"

WORKDIR /repo

# Manifests first, so the install layer caches independently of source changes.
# Every workspace manifest is required for --frozen-lockfile to validate.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/package.json
COPY tests/package.json ./tests/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "." --prod=false

COPY proto ./proto
COPY scripts ./scripts
RUN node scripts/gen-node.mjs

# --------------------------------------------------------------------------
# Stage 2: install, typecheck+compile, then prune.
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build

ARG PNPM_VERSION
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/package.json
COPY tests/package.json ./tests/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@grpc-prediction/api..." --filter "."

COPY --from=protoc /repo/shared/node ./shared/node
COPY api/tsconfig.json api/otel-hook.mjs ./api/
COPY api/src ./api/src

# Compiles against the generated stubs, so a proto/gateway mismatch fails here.
RUN pnpm --filter @grpc-prediction/api run build

# `pnpm deploy` resolves the workspace package's production dependency graph
# into a standalone directory with a real (non-symlinked) node_modules. This is
# what keeps the runtime image small: copying /repo/node_modules instead would
# drag in the whole dev dependency tree (~110 MB) via the .pnpm store.
RUN pnpm --filter @grpc-prediction/api deploy --prod /out \
 && rm -rf /out/src /out/tsconfig.json

# Strip everything Node never loads at runtime: TypeScript declarations, source
# maps, docs and package test suites. Worth ~25 MB across the OpenTelemetry
# tree. LICENSE files are deliberately kept.
RUN find /out/node_modules \
      \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.js.map' \
         -o -name '*.md' -o -name '*.markdown' -o -name '.npmignore' \) \
      -type f -delete \
 && find /out/node_modules \
      \( -name test -o -name tests -o -name __tests__ -o -name docs \
         -o -name example -o -name examples \) \
      -type d -prune -exec rm -rf {} + \
 && du -sh /out/node_modules

# --------------------------------------------------------------------------
# Stage 3: runtime.
# Alpine over Debian slim purely for size: every dependency here (fastify,
# grpc-js, the OpenTelemetry SDK) is pure JavaScript, so there is no native
# module that would need glibc.
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    HOST=0.0.0.0 \
    PORT=3000

# tini reaps zombies and forwards SIGTERM, so the graceful-shutdown path in
# server.ts actually runs. npm is removed: nothing installs at runtime.
RUN apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

WORKDIR /app

# node:*-alpine ships a non-root `node` user (uid 1000); use it rather than
# inventing another one.
COPY --from=build --chown=node:node /out ./api
# config.ts resolves the descriptor at ../../shared/node/prediction.proto
# relative to api/dist/, so this layout must mirror the repository's.
COPY --from=protoc --chown=node:node /repo/shared/node/prediction.proto ./shared/node/prediction.proto

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# --import ./otel-hook.mjs installs OpenTelemetry's ESM module hook. Without
# it, gRPC client calls made from this (ESM) codebase are never instrumented
# and no traceparent reaches the sidecar. See api/otel-hook.mjs.
CMD ["node", "--import", "./api/otel-hook.mjs", "api/dist/server.js"]
