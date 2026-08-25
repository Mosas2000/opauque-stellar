# Container image for the ASP (Association Set Provider) indexer service (#770).
#
# This service holds ASP_SECRET, a hot key authorized to publish state/asp
# roots on the deployed privacy pool — see docs/secrets-management.md. The
# image itself is not a secret boundary (the secret is injected at runtime via
# environment or a mounted file), but it is built to minimize the attack
# surface a compromised container would expose: minimal base, no build
# toolchain in the final layer, and a non-root runtime user.
#
# BUILD CONTEXT: the repo root (not asp/), because the service reads
# ../deployments/v1/testnet.json relative to its own directory at runtime
# (see scripts/indexer.ts REPO_ROOT resolution). Build with:
#   docker build -f asp/Dockerfile -t opaque-asp .
# (docker-compose.yml sets this up automatically.)
#
# Base image pinned by digest — see docker/reproducible-build.Dockerfile for
# why: a tag can be silently retagged, a digest cannot. Pinned to
# node:20-slim (Node 20.20.2, Debian bookworm) as of 2026-08-25; re-verify
# via `docker buildx imagetools inspect node:20-slim` when bumping.
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build

WORKDIR /app
COPY asp/package.json asp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY asp/tsconfig.json ./
COPY asp/src ./src
COPY asp/scripts ./scripts
RUN npx tsc --noEmit

FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

# Healthcheck relies only on the Node runtime already present in the base
# image — no extra packages installed in the runtime layer.
RUN groupadd --system --gid 10001 opaque \
    && useradd --system --uid 10001 --gid opaque --home-dir /app --shell /usr/sbin/nologin opaque

WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm install --no-save --no-audit --no-fund tsx@^4.19.4 \
    && npm cache clean --force
COPY asp/src ./src
COPY asp/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY deployments ./deployments

RUN mkdir -p /app/data && chown -R opaque:opaque /app
USER opaque

# The indexer has no HTTP surface of its own; healthcheck instead confirms
# the process's data directory and deployment manifest are reachable, which
# fails fast if the container's config mount is broken.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "process.exit(require('fs').existsSync('/app/data') && require('fs').existsSync('/app/deployments/v1/testnet.json') ? 0 : 1)"

ENTRYPOINT ["npx", "tsx", "scripts/indexer.ts"]
