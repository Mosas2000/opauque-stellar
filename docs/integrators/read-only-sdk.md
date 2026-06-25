# Integrating with `@opaque-stellar/sdk-readonly`

Issue: #381 — *Add contract read-only SDK package for integrators*

Previously, reading Opaque contract state required copying the ScVal
encoding helpers out of `frontend/src/lib/scvalEncoding.ts` and the manual
simulate/decode pattern from `frontend/src/lib/registry.ts`. The
[`packages/sdk-readonly`](../../packages/sdk-readonly) package now publishes
that pattern as a standalone, typed client so integrators don't need to
touch XDR at all.

## 1. Install

```bash
npm install @opaque-stellar/sdk-readonly @stellar/stellar-sdk
```

## 2. Get contract ids

Contract ids live in [`deployments/v1/<network>.json`](../../deployments/v1).
Either copy the relevant `id` field directly, or fetch the manifest and use
`contractIdFromManifest`:

```ts
import { contractIdFromManifest } from "@opaque-stellar/sdk-readonly";

const manifest = await fetch(
  "https://raw.githubusercontent.com/collinsadi/opauque-stellar/main/deployments/v1/testnet.json",
).then((r) => r.json());

const reputationVerifierId = contractIdFromManifest(manifest, "reputationVerifier");
```

## 3. Read contract state

```ts
import {
  ReadOnlyContractClient,
  ReputationVerifierReadClient,
} from "@opaque-stellar/sdk-readonly";

const client = new ReadOnlyContractClient({
  contractId: reputationVerifierId,
  rpcUrl: manifest.rpcUrl ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: manifest.networkPassphrase,
  // Any funded account works — reads are simulated, never signed or submitted.
  simulationAccount: "G...",
});

const reputationVerifier = new ReputationVerifierReadClient(client);
const latestRoot = await reputationVerifier.getLatestRoot();
```

Repeat with `SchemaRegistryReadClient`, `StealthRegistryReadClient`, or
`AttestationEngineReadClient` for the other contracts — each wraps a
`ReadOnlyContractClient` pointed at that contract's id.

## 4. Versioning

`@opaque-stellar/sdk-readonly`'s package version tracks the deployment
manifest's `schemaVersion` field (currently `1.0.0`). Run
`npm run verify:sdk-readonly-version` from the repo root to confirm the SDK
package version still matches the manifest before publishing a new release.

## Full read-method reference

See [`packages/sdk-readonly/README.md`](../../packages/sdk-readonly/README.md#available-clients)
for the complete list of typed methods per contract.
