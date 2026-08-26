# Local Development Guide

Step-by-step instructions for getting the full Opaque stack running from a fresh
clone on macOS or Linux.

> **Windows:** Use WSL2 (Ubuntu 22.04+). The commands below are written for
> macOS/Linux shells; most work identically inside WSL2.

---

## 1. Prerequisites

Install these tools before cloning. The versions below match the CI matrix in
`.github/workflows/ci.yml`.

### Rust (stable)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# WASM compilation targets required by contracts and scanner
rustup target add wasm32-unknown-unknown wasm32v1-none
rustup component add rustfmt clippy
```

### Stellar CLI

Use the pinned installer so your local version matches the one CI uses:

```bash
bash scripts/install-stellar-cli.sh
```

Or install manually from
[developers.stellar.org](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup).

### wasm-pack (scanner)

```bash
bash scripts/install-wasm-pack.sh
# or:
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
```

### Node.js 20 or 22 (LTS)

Install via [nvm](https://github.com/nvm-sh/nvm) or your OS package manager:

```bash
nvm install 20
nvm use 20
```

Only Node 20 and 22 are tested in CI; other major versions may fail.

### Supply-chain tools (Rust)

```bash
cargo install cargo-audit cargo-deny --locked
```

### Circom and snarkjs (circuit work only)

Most contributors do not need these. Install only if you are modifying `.circom`
files:

```bash
npm install -g snarkjs
# circom: see https://docs.circom.io/getting-started/installation/
```

The pinned versions are recorded in `circuits/TOOLCHAIN.json`. Confirm your local
versions match before building circuits:

```bash
( cd circuits && npm run check:toolchain )
```

---

## 2. Clone and first-time setup

```bash
git clone https://github.com/collinsadi/opauque-stellar.git
cd opauque-stellar

# Install root tooling (tsx, typescript)
npm ci

# Install per-workspace Node dependencies
( cd frontend  && npm ci )
( cd sdk       && npm ci )
( cd relayer   && npm ci )
( cd asp       && npm ci )
# circuit work only:
( cd circuits  && npm ci )

# Copy the environment template and fill in your values (see section 3)
cp .env.example .env
```

Or use the Makefile shortcut:

```bash
make install
```

---

## 3. Environment variables

Copy `.env.example` to `.env`. The file is commented; the two variables you must
set for any local deploy or service run are:

| Variable | What it is | Example |
|---|---|---|
| `STELLAR_NETWORK` | Target network | `testnet` |
| `STELLAR_DEPLOYER` | Stellar CLI identity name for deploys | `opaque-deployer` |

Create a funded testnet identity once:

```bash
stellar keys generate opaque-deployer --network testnet --fund
```

The remaining variables (`RELAYER_OPERATOR_SECRET`, `PUBLISHER_SECRET`, etc.) are
only needed when running the corresponding service. See the inline comments in
`.env.example` for each one.

The frontend has its **own** env file; copy it separately:

```bash
cp frontend/.env.example frontend/.env
```

---

## 4. Build the scanner WASM

The scanner is the Rust DKSAP engine compiled to WASM. The frontend and SDK both
depend on it.

```bash
npm run build:scanner
# or: make build-scanner
```

This runs `wasm-pack build` on `scanner/` and writes output to
`frontend/public/pkg/`. It also verifies the hash in `artifacts/manifest.json`
(see section 6).

---

## 5. Fetch circuit artifacts

Circuit proving keys (`.zkey` files) are large and not committed to the repo.
They are downloaded from a pinned GitHub release and verified against
`artifacts/manifest.json`:

```bash
npm run fetch:circuits
# or: make fetch-circuits
```

If the release is not yet published, the frontend build will fail because the
proving-key files are missing. Ask a maintainer for the artifact URL or build the
circuits locally (section 7.3).

---

## 6. Generated artifacts explained

`artifacts/manifest.json` is the source of truth for all pinned binary hashes.

| Artifact | Built from | Where it ends up | How it is verified |
|---|---|---|---|
| `opauque_scanner_bg.wasm` | `scanner/` via `wasm-pack` | `frontend/public/pkg/` | SHA-256 in `manifest.json` |
| `stealth_attestation.wasm` + `sa_final.zkey` | `circuits/stealth_attestation.circom` | `frontend/public/circuits/` | SHA-256 in `manifest.json` |
| `stealth_reputation.wasm` + `stealth_reputation_final.zkey` | `circuits/v2/stealth_reputation.circom` | `frontend/public/circuits/v2/` | SHA-256 in `manifest.json` |
| `privacy_pool_withdraw.wasm` + zkey | `circuits/v3/privacy_pool_withdraw.circom` | `frontend/public/circuits/v3/` | SHA-256 in `manifest.json` |
| Contract VK bytes | zkey → `encode_vk.mjs` | `contracts/groth16-verifier/src/lib.rs` | `contractVk.zkeyHash` in `manifest.json` |

Verify all pinned hashes at any time:

```bash
npm run verify:artifacts
# or: make verify-artifacts
```

The frontend `prebuild` step runs this automatically, so a hash mismatch fails the
build before Vite ever starts. The scanner and circuit keys are **never**
regenerated automatically — they must be updated deliberately with
`npm run update:artifacts` (see `artifacts/README.md`).

---

## 7. Running things locally

### 7.1 Frontend wallet

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173`, connect Freighter on Stellar testnet, and initialise
your keys. The frontend reads contract IDs from
`deployments/v1/testnet.json` — no redeploy needed for testnet work.

Or from the root: `make dev-frontend`

### 7.2 Protocol services

The pool and reputation verifiers need published roots; relayed withdrawals need a
gateway. A public testnet ASP and relayer are already running for the demo. To run
your own:

| Service | Command | Guide |
|---|---|---|
| ASP indexer | `cd asp && npm run indexer` | [docs/running-asp.md](running-asp.md) |
| Reputation publisher | `cd publisher && npm run serve` | [publisher/](../publisher/) |
| Relayer hub | `cd relayer && npm run hub` | [docs/running-relayer.md](running-relayer.md) |
| Relayer node | `cd relayer && npm run relayer` | [docs/running-relayer.md](running-relayer.md) |

### 7.3 Contracts (local Soroban network)

For full contract-level testing without touching testnet, start a local Soroban
sandbox:

```bash
# Install Docker if not already present, then:
stellar network start local

# In another terminal — deploy all contracts to the local network:
STELLAR_NETWORK=local npm run deploy
```

### 7.4 Smoke tests against testnet

```bash
make smoke-testnet
# runs: verify:deployment + verify:artifacts
```

---

## 8. Running the checks locally

Run exactly what CI runs before pushing. Makefile shortcuts are in parentheses.

```bash
# Contracts
cargo fmt --all -- --check                             # make fmt
cargo clippy --workspace --all-targets -- -D warnings  # make lint-contracts
cargo test --workspace --locked                        # make test-contracts
stellar contract build                                 # make build-contracts

# Frontend
( cd frontend && npm run lint )                        # make lint-frontend
( cd frontend && npx tsc -b --noEmit )
( cd frontend && npm test )
( cd frontend && npm run build )

# SDK
( cd sdk && npm run lint && npm run typecheck && npm run build && npm test )

# Services
( cd relayer && npm run typecheck && npm test )
( cd asp     && npm run typecheck && npm test )

# Supply chain
npm run verify:deployment
cargo audit
cargo deny check
npm run notices:verify

# Run everything in one shot:
make ci
```

---

## 9. Troubleshooting

### `wasm-pack` not found after install

```bash
source "$HOME/.cargo/env"
# or add ~/.cargo/bin to your PATH permanently
```

### `stellar` command not found

```bash
# Re-run the installer and follow the PATH instruction it prints:
bash scripts/install-stellar-cli.sh
```

### Scanner build fails: `error[E0463]: can't find crate for std`

The WASM target is missing:

```bash
rustup target add wasm32-unknown-unknown
```

### `npm run fetch:circuits` fails with 404

The circuit release artifact has not been published yet or the tag is wrong.
Check `artifacts/manifest.json` for the expected release tag and ask a maintainer
to publish it, or build the circuits locally:

```bash
( cd circuits && npm run fixtures:generate )
npm run update:artifacts
```

### Frontend build fails: `artifact hash mismatch`

Your local artifact does not match `artifacts/manifest.json`. Rebuild from source:

```bash
npm run build:scanner
npm run fetch:circuits
npm run verify:artifacts
```

If you intentionally changed scanner or circuit source, update the manifest:

```bash
npm run update:artifacts
```

### `cargo test` fails with lock file out of date

```bash
cargo update   # regenerates Cargo.lock; commit the result
```

### `npm ci` fails: `missing peer dependency`

Some workspaces declare peer deps (SDK, ASP). Install with:

```bash
npm ci --legacy-peer-deps
```

### Circom version mismatch

```bash
( cd circuits && npm run check:toolchain )
# Follow the install pointer it prints
```

### Port 5173 already in use

```bash
cd frontend && npm run dev -- --port 5174
```

---

## 10. Quick reference

| Task | Command | Makefile |
|---|---|---|
| Install all deps | `npm ci && (cd frontend && npm ci) && ...` | `make install` |
| Build scanner WASM | `npm run build:scanner` | `make build-scanner` |
| Fetch circuit artifacts | `npm run fetch:circuits` | `make fetch-circuits` |
| Build contracts | `stellar contract build` | `make build-contracts` |
| Test contracts | `cargo test --workspace --locked` | `make test-contracts` |
| Lint contracts | `cargo clippy ... -D warnings` | `make lint-contracts` |
| Test frontend | `cd frontend && npm test` | `make test-frontend` |
| Test SDK | `cd sdk && npm test` | `make test-sdk` |
| Verify deployment manifest | `npm run verify:deployment` | `make verify-deployment` |
| Verify artifact hashes | `npm run verify:artifacts` | `make verify-artifacts` |
| Regenerate third-party notices | `npm run notices:generate` | `make notices-generate` |
| Run all CI checks locally | _(see section 8)_ | `make ci` |
