# Testnet Reset Recovery Runbook

Stellar testnet is periodically reset, wiping all deployed contract state. This runbook
documents the full sequence to restore all Opaque protocol services after a reset.

**Estimated time (dry run recorded):** ~35–45 minutes end to end, assuming funded
accounts and a working build environment.

> [!NOTE]
> This runbook is for Stellar testnet only. Mainnet deployments require the security
> audit signoff gate (`npm run verify:security-audit`) and are not covered here.

## Prerequisites

Before starting, confirm:

- [ ] Stellar CLI installed (`stellar --version`)
- [ ] Node.js 20+ installed (`node --version`)
- [ ] Rust + `wasm-pack` installed (or run `bash scripts/install-wasm-pack.sh`)
- [ ] Repository is up to date (`git pull`)
- [ ] Deployer account re-funded on the new testnet (`stellar keys fund <identity> --network testnet`)
- [ ] ASP, publisher, and relayer environment files are accessible

## Step 1 — Confirm the reset

```bash
# Check that the testnet has been reset by querying the latest ledger
curl -s https://soroban-testnet.stellar.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
  | jq .result.sequence
```

A sequence number near 1 (or significantly lower than before) confirms a reset. If the
sequence is still high, the testnet has not been reset — stop here.

## Step 2 — Re-fund the deployer account

```bash
stellar keys fund <your-identity> --network testnet
stellar keys address <your-identity>   # confirm the G-address
```

If you use a raw secret instead of a named identity, fund the account via Friendbot:

```bash
curl "https://friendbot.stellar.org?addr=<G-address>"
```

## Step 3 — Build contracts

```bash
cd /path/to/opaque-stellar
stellar contract build
```

Expected output: all `.wasm` files written to `target/wasm32v1-none/release/`.

## Step 4 — Deploy core contracts

```bash
npm run deploy:testnet
```

This deploys all six core contracts (stealth registry, stealth announcer, groth16
verifier, reputation verifier, schema registry, attestation engine v2), initializes
them, verifies wiring read-back, and writes the new contract IDs and WASM hashes to
`deployments/v1/testnet.json`.

Expected output ends with:

```text
✓ Updated deployments/v1/testnet.json
```

**Timing:** ~8–12 minutes (build + 6 deploys + 2 initialize calls).

## Step 5 — Deploy privacy pool

```bash
npm run deploy:testnet -- --pool --skip-build
```

Deploys a fresh `poolVerifier` (groth16-verifier instance) and `privacyPool`, initializes
the pool, and updates the manifest.

**Timing:** ~3–5 minutes.

## Step 6 — Deploy relayer registry

```bash
npm run deploy:testnet -- --relayer --skip-build
```

Deploys the `relayerRegistry` against the new pool and native SAC, initializes it, and
updates the manifest.

**Timing:** ~2–3 minutes.

## Step 7 — Verify the manifest

```bash
npm run verify:deployment:strict -- --network testnet --check-wasm
```

Expected output:

```text
OK: verified testnet manifest(s) (strict)
```

If this fails, check the error output and re-run the affected deploy step.

## Step 8 — Run drift check

```bash
npm run drift:check -- --network testnet
```

Expected output:

```text
All contracts match the manifest.
```

## Step 9 — Update artifact manifest

```bash
npm run update:artifacts
```

This syncs the artifact manifest with the new deployment and embedded VK hashes.

## Step 10 — Commit the updated manifest

```bash
git add deployments/v1/testnet.json artifacts/manifest.json
git commit -m "chore: update testnet manifest after reset"
git push
```

## Step 11 — Restart the ASP indexer

The ASP's local state (`asp/data/`) references old contract IDs and event cursors that
are no longer valid after a reset. Clear it before restarting:

```bash
sudo systemctl stop opaque-asp
rm -rf /path/to/opaque-stellar/asp/data/
sudo systemctl start opaque-asp
sudo journalctl -u opaque-asp -f
```

Wait for a tick that prints `ASP_PUBLISHED STATE_PUBLISHED` before proceeding.

**Timing:** ~1–2 minutes.

## Step 12 — Restart the reputation publisher

Clear the publisher's stale state and restart:

```bash
sudo systemctl stop opaque-publisher
rm -rf /path/to/opaque-stellar/publisher/data/state/
rm -rf /path/to/opaque-stellar/publisher/data/roots/
# Keep publisher/data/inbox/ if you want to re-publish existing leaves
sudo systemctl start opaque-publisher
sudo journalctl -u opaque-publisher -f
```

Wait for `in-sync` or `PUBLISHED <txHash>` in the logs.

**Timing:** ~1 minute.

## Step 13 — Re-register and restart the relayer

The relayer registry was redeployed in step 6, so the operator must re-register:

```bash
sudo systemctl stop opaque-relayer
cd /path/to/opaque-stellar/relayer
set -a && source /path/to/.env && set +a
npm run register
sudo systemctl start opaque-relayer
sudo journalctl -u opaque-relayer -f
```

Confirm healthy startup output:

```text
Opaque relayer gateway listening on https://relayer.example.com
operator=G...
x25519=0x...
registry=C...
```

**Timing:** ~2 minutes.

## Step 14 — Propagate new contract IDs to the frontend

The frontend reads contract IDs from `deployments/v1/testnet.json` at build time. If
the frontend is deployed separately (e.g. Vercel), trigger a redeploy after pushing the
updated manifest in step 10.

For local development, the frontend picks up the new manifest automatically on the next
`npm run dev` start.

If the frontend uses `VITE_TESTNET_*_CONTRACT` environment variable overrides, update
them to match the new IDs from the manifest.

## Step 15 — Propagate new contract IDs to the SDK

If you are running the SDK against testnet with hardcoded contract IDs, update
`sdk/src/config/` or the relevant config file to point to the new IDs. The SDK reads
from the deployment manifest by default when no override is provided.

## Step 16 — Verify end-to-end

Run the SLO report to confirm all three services are healthy:

```bash
npm run slo:report
```

Optionally run the smoke tests:

```bash
cd frontend
npm run smoke:pool
npm run smoke:private-payment
```

## Timing summary (dry run)

| Step | Action | Time |
|:--|:--|:--|
| 1–2 | Confirm reset, re-fund | 2 min |
| 3 | Build contracts | 5 min |
| 4 | Deploy core contracts | 10 min |
| 5 | Deploy privacy pool | 4 min |
| 6 | Deploy relayer registry | 3 min |
| 7–9 | Verify + update artifacts | 2 min |
| 10 | Commit and push | 1 min |
| 11–13 | Restart services | 5 min |
| 14–15 | Propagate IDs | 3 min |
| 16 | Verify end-to-end | 5 min |
| **Total** | | **~40 min** |

## Troubleshooting

| Symptom | Likely cause | Fix |
|:--|:--|:--|
| `stellar contract build` fails | Rust toolchain or wasm target missing | Run `bash scripts/install-wasm-pack.sh` and retry |
| Deploy step fails with `fee too low` | Testnet congestion or account underfunded | Re-fund the deployer and retry the deploy step |
| `verify:deployment:strict` fails with wiring mismatch | A deploy step was skipped or failed silently | Re-run the failing deploy step (`--pool` or `--relayer`) |
| ASP logs show `update_asp_root not confirmed` | New contract ID not picked up | Confirm `deployments/v1/testnet.json` has the new pool ID and restart the ASP |
| Publisher logs show `Unauthorized` | Publisher secret is not the new verifier admin | Re-deploy with the same deployer key or update `PUBLISHER_SECRET` |
| Relayer logs show `registry not found` | Relayer registry ID changed | Confirm the manifest has the new registry ID and re-register |
| Frontend shows wrong contract IDs | Stale build or env overrides | Trigger a redeploy or clear `VITE_TESTNET_*_CONTRACT` overrides |
