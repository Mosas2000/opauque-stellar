# Container image for the reputation publisher service (#770).
#
# Two entrypoints share this image: the HTTP API (scripts/server.ts, default)
# and the polling-loop CLI (scripts/publisher.ts, override the command). Both
# hold PUBLISHER_SECRET, currently the verifier admin key on testnet — see
# docs/secrets-management.md and publisher/README.md "Production Shape" for
# why that is testnet-only.
#
# BUILD CONTEXT: the repo root, for the same reason as asp/Dockerfile — this
# service resolves ../deployments/v1/testnet.json relative to itself.
#   docker build -f publisher/Dockerfile -t opaque-publisher .
#
# Base image pinned by digest, same node:20-slim build used across all three
# service images (Node 20.20.2, Debian bookworm, as of 2026-08-25).
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build

WORKDIR /app
COPY publisher/package.json publisher/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY publisher/tsconfig.json ./
COPY publisher/src ./src
COPY publisher/scripts ./scripts
RUN npx tsc --noEmit

FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 opaque \
    && useradd --system --uid 10001 --gid opaque --home-dir /app --shell /usr/sbin/nologin opaque

WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm install --no-save --no-audit --no-fund tsx@^4.19.4 \
    && npm cache clean --force
COPY publisher/src ./src
COPY publisher/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY deployments ./deployments

RUN mkdir -p /app/data && chown -R opaque:opaque /app
USER opaque

EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PUBLISHER_HTTP_PORT:-8790}/health" || exit 1

# Default to the HTTP API. Override the command (e.g. `["npx", "tsx",
# "scripts/publisher.ts"]`) to run the polling-loop worker instead — see
# docker-compose.yml for how both roles are wired.
ENTRYPOINT ["npx", "tsx"]
CMD ["scripts/server.ts"]
