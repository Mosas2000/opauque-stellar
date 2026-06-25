# Examples

## Simulate Attestation

`simulate-attest.ts` builds an `attestation-engine-v2.attest(...)` Soroban call and either prints the call plan offline or submits it to Stellar RPC simulation.

Dry-run smoke test:

```bash
npx tsx examples/simulate-attest.ts --dry-run
```

Live testnet simulation:

```bash
npx tsx examples/simulate-attest.ts \
  --network testnet \
  --source G... \
  --schema-id 0x... \
  --stealth-hash 0x... \
  --data 0x... \
  --ref-uid 0x...
```

By default the script loads `deployments/v1/testnet.json` and uses its `attestationEngineV2` contract ID and RPC URL. If the manifest still contains template IDs, pass `--contract-id C...`.

The output includes the method name, encoded argument values, and expected footprint categories. In live mode it also prints the simulation return value, resource fee, and transaction data footprint XDR when the RPC response includes them.
