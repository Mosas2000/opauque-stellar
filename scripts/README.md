# Repository Maintenance Scripts

TypeScript and shell scripts for building, verifying, deploying, and monitoring the Opaque Stellar protocol. Run via `npx tsx scripts/<name>.ts` or `./scripts/<name>.sh`.

Every script has a one-line purpose and usage entry below. Release- and deploy-critical scripts are flagged.

## Build and artifact management

| Script | Purpose | Usage | Critical |
|--------|---------|-------|----------|
| [build-scanner-wasm.ts](build-scanner-wasm.ts) | Build scanner Rust → WASM via wasm-pack | `npm run build:scanner` | Release |
| [check-scanner-byte-stability.ts](check-scanner-byte-stability.ts) | Rebuild scanner and verify byte-identical output against pinned hash | `npx tsx scripts/check-scanner-byte-stability.ts` | Release |
| [prepare-frontend-artifacts.ts](prepare-frontend-artifacts.ts) | Orchestrate scanner build + circuit fetch + hash verify before Vite build | `npx tsx scripts/prepare-frontend-artifacts.ts` | Release |
| [fetch-circuit-artifacts.ts](fetch-circuit-artifacts.ts) | Download pinned circuit zkeys/WASM from GitHub releases | `npm run fetch:circuits` | Release |
| [update-artifact-manifest.ts](update-artifact-manifest.ts) | Recompute SHA-256 hashes and write `artifacts/manifest.json` | `npm run update:artifacts` | Release |
| [update-manifest-wasm-hashes.ts](update-manifest-wasm-hashes.ts) | Write WASM hashes into deployment manifests | `npm run update:manifest-wasm` | Release |
| [verify-artifact-manifest.ts](verify-artifact-manifest.ts) | Verify local artifacts match pinned manifest hashes | `npm run verify:artifacts` | Release |
| [embed-circuit-vk.ts](embed-circuit-vk.ts) | Generate groth16-verifier VK Rust constants from verification_key.json | `npx tsx scripts/embed-circuit-vk.ts <vk.json> [--write]` | Release |
| [gen-poseidon-constants.ts](gen-poseidon-constants.ts) | Generate Poseidon BN254 constants for the on-chain contract | `npx tsx scripts/gen-poseidon-constants.ts` | Release |

## Deployment and migration

| Script | Purpose | Usage | Critical |
|--------|---------|-------|----------|
| [deploy-contracts.ts](deploy-contracts.ts) | Build, deploy, and wire all Soroban contracts | `npm run deploy:testnet` | **Deploy** |
| [verify-deployment-manifest.ts](verify-deployment-manifest.ts) | Validate deployment manifest schema, IDs, and wiring | `npm run verify:deployment` | **Deploy** |
| [migrate-to-multisig-admin.ts](migrate-to-multisig-admin.ts) | Transfer admin to multisig governance (irreversible) | `npx tsx scripts/migrate-to-multisig-admin.ts --network testnet --signers G... --threshold 2` | **Deploy** |
| [verify-security-audit.ts](verify-security-audit.ts) | Block mainnet deploy if blocking audit findings remain open | `npm run verify:security-audit` | **Deploy** |
| [drift-check.ts](drift-check.ts) | Detect on-chain WASM hash drift vs deployment manifest | `npx tsx scripts/drift-check.ts --network testnet` | Release |
| [export-manifest-env.ts](export-manifest-env.ts) | Print `export` statements for frontend env vars from a deployment manifest | `eval "$(npx tsx scripts/export-manifest-env.ts testnet)"` | — |

## Code generation

| Script | Purpose | Usage | Critical |
|--------|---------|-------|----------|
| [generate-error-mapping.ts](generate-error-mapping.ts) | Generate TypeScript error-code mapping from Rust `#[contracterror]` enums | `npx tsx scripts/generate-error-mapping.ts` | — |
| [generate-sdk-addresses.ts](generate-sdk-addresses.ts) | Regenerate SDK address constants from deployment manifests | `npm run generate:addresses` | — |
| [generate-third-party-notices.ts](generate-third-party-notices.ts) | Regenerate `THIRD_PARTY_NOTICES.md` from dependency trees | `npm run notices:generate` | — |

## Verification and CI gates

| Script | Purpose | Usage | Critical |
|--------|---------|-------|----------|
| [check-repo-links.ts](check-repo-links.ts) | Catch misspelled repo URLs and wrong schema domains | `npm run check:links` | — |
| [check-env-example.ts](check-env-example.ts) | Cross-check `process.env` usage against `.env.example` | `npm run check:env` | — |
| [check-ttl-expiry.ts](check-ttl-expiry.ts) | Report Soroban storage entries approaching TTL expiry | `npx tsx scripts/check-ttl-expiry.ts --network testnet` | — |
| [verify-deployment-manifest.ts](verify-deployment-manifest.ts) | Validate deployment manifest against JSON schema | `npm run verify:deployment` | **Deploy** |
| [verify-merkle-root.ts](verify-merkle-root.ts) | Recompute and verify Merkle roots from on-chain data | `npx tsx scripts/verify-merkle-root.ts --network testnet --root 0x...` | — |
| [verify-third-party-notices.ts](verify-third-party-notices.ts) | Verify `THIRD_PARTY_NOTICES.md` is current and copyleft deps are reviewed | `npm run notices:verify` | — |

## Operational tooling

| Script | Purpose | Usage | Critical |
|--------|---------|-------|----------|
| [slo-report.ts](slo-report.ts) | Measure and report SLO health for ASP, publisher, relayer | `npx tsx scripts/slo-report.ts --network testnet --window 24h` | — |
| [snapshot-indexer-state.ts](snapshot-indexer-state.ts) | Create/restore/list ASP indexer state snapshots | `npx tsx scripts/snapshot-indexer-state.ts create` | — |
| [soak-test.ts](soak-test.ts) | Long-running soak test with resource tracking and auto-restart | `npm run soak` | — |
| [csp-report-server.ts](csp-report-server.ts) | Local CSP violation report collector | `npm run csp:report` | — |

## Tool installation

| Script | Purpose | Usage | Critical |
|--------|---------|-------|----------|
| [install-stellar-cli.sh](install-stellar-cli.sh) | Install pinned Stellar CLI binary | `./scripts/install-stellar-cli.sh` | Release |
| [install-wasm-pack.sh](install-wasm-pack.sh) | Install pinned wasm-pack binary (0.14.0) | `./scripts/install-wasm-pack.sh` | Release |

## Validation shell scripts

| Script | Purpose | Usage | Critical |
|--------|---------|-------|----------|
| [cross-browser-test.sh](cross-browser-test.sh) | Run vitest + Playwright across Chromium, Firefox, WebKit | `./scripts/cross-browser-test.sh` | — |
| [mutation-test.sh](mutation-test.sh) | Run cargo-mutants mutation testing on contract crates | `./scripts/mutation-test.sh` | — |
| [validate-workflow-scripts.sh](validate-workflow-scripts.sh) | Verify `npm run` refs in GitHub Actions workflows exist in package.json | `./scripts/validate-workflow-scripts.sh` | — |

## Shared libraries (not run directly)

| File | Purpose |
|------|---------|
| [artifact-manifest-lib.ts](artifact-manifest-lib.ts) | Shared helpers for manifest load/update/verify operations |
| [third-party-notices-lib.ts](third-party-notices-lib.ts) | Shared logic for generating and verifying `THIRD_PARTY_NOTICES.md` |

## Adding a new script

When adding a maintenance script:

1. Add a one-line entry to the appropriate table above.
2. Include usage, required env vars, and whether it is release/deploy-critical.
3. If the script reads `process.env` variables, add them to `.env.example` and update the cross-check via `npm run check:env`.
4. If the script should run in CI, wire it into `.github/workflows/ci.yml` and update [`scripts/validate-workflow-scripts.sh`](validate-workflow-scripts.sh).
