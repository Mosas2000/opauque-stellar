# Running the Services with Docker (#770)

The ASP indexer, reputation publisher, and relayer each ship a pinned,
non-root container image (`asp/Dockerfile`, `publisher/Dockerfile`,
`relayer/Dockerfile`) and a `docker-compose.yml` at the repo root that brings
up all three against **testnet** configuration. This is the fastest way to
get the full off-chain service stack running without hand-assembling Node
environments — see `docs/running-asp.md`, `docs/running-publisher.md`, and
`docs/running-relayer.md` for the bare-metal/systemd path and for what each
secret authorizes.

## Quick Start

```bash
cp .env.example .env
# Fill in ASP_SECRET, PUBLISHER_SECRET, RELAYER_OPERATOR_SECRET,
# RELAYER_X25519_SECRET — see docs/secrets-management.md for what each one
# can do and how to generate/rotate it.

docker compose up --build
```

This builds and starts:

| Service     | Container    | Exposed port | Purpose                                              |
| ----------- | ------------ | ------------- | ----------------------------------------------------- |
| `asp`       | opaque-asp   | none (no HTTP)| Publishes state/asp roots on the privacy pool          |
| `publisher` | opaque-publisher | `8790`    | Reputation publisher HTTP API                          |
| `relayer`   | opaque-relayer   | `8787`    | Relayer operator (self-hosts a gossip hub)              |

Each service persists its working state in a named Docker volume
(`asp-data`, `publisher-data`, `relayer-data`) so restarts don't lose
progress. To reset a service's state, remove its volume:
`docker compose down -v` (removes all three) or
`docker volume rm opaque-stellar_asp-data` (one service).

## Running Just One Service

```bash
docker compose up --build asp
docker compose up --build publisher
docker compose up --build relayer
```

## Build Context

All three Dockerfiles build from the **repo root**, not their own service
directory — each service resolves `deployments/v1/testnet.json` relative to
itself at runtime (see each script's `REPO_ROOT` resolution), so the build
needs that file in context:

```bash
docker build -f asp/Dockerfile -t opaque-asp .
docker build -f publisher/Dockerfile -t opaque-publisher .
docker build -f relayer/Dockerfile -t opaque-relayer .
```

`docker compose build` / `docker compose up --build` does this automatically
via each service's `build.context: .` in `docker-compose.yml`.

## Alternate Entrypoints

- **Publisher**: defaults to the HTTP API (`scripts/server.ts`). To run the
  standalone polling-loop CLI instead:
  ```bash
  docker compose run --rm publisher npx tsx scripts/publisher.ts
  ```
- **Relayer**: defaults to the relayer operator, which self-hosts a gossip
  hub when `RELAYER_HUB_URL` is unset (single-operator topology — see
  `docs/running-relayer.md`). To run a standalone gossip hub instead (for a
  multi-operator topology):
  ```bash
  docker compose run --rm --service-ports relayer npx tsx scripts/hub.ts
  ```

## Health Checks

Each image declares a `HEALTHCHECK`:

- **asp**: no HTTP surface, so the check confirms the data directory and
  the mounted deployment manifest are present.
- **publisher** / **relayer**: `curl`s the service's own `/health` endpoint.

`docker compose ps` shows the current health status of each container.

## Non-Root Runtime

Every image runs as a dedicated, non-root user (`opaque`, uid/gid `10001`)
in the final layer — the build stage (which runs `npm ci` and `tsc
--noEmit`) is discarded, so no build toolchain or root-owned build artifacts
ship in the runtime image.

## CI

`.github/workflows/ci.yml`'s `service-images` job builds all three images on
every PR (matrix over `asp`/`publisher`/`relayer`) and asserts the non-root
user and a declared `HEALTHCHECK` on each — a Dockerfile change that
accidentally drops either fails CI.

## Production Notes

This compose file targets **testnet** and is meant for local development,
staging, and demos — the same MVP secret model documented in
`publisher/README.md`'s "Production Shape" section (a shared admin/deployer
key rather than a dedicated per-service role) applies here too. Treat every
`*_SECRET` env var exactly as described in `docs/secrets-management.md`:
never bake one into an image layer, never commit `.env`, and prefer a
secrets manager (Vault, cloud KMS) over plain environment variables for any
long-lived deployment.
