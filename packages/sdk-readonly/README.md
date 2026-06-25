# @opaque-stellar/sdk-readonly

Typed, read-only TypeScript client for the Opaque Stellar/Soroban contracts
(`reputation-verifier`, `schema-registry`, `stealth-registry`,
`attestation-engine-v2`). Exposes every public getter with no manual XDR
encoding required — integrators no longer need to copy the encoding logic
out of the frontend.

This package only performs simulated, read-only contract calls. It never
signs or submits a transaction, so it never needs a secret key.

## Install

```bash
npm install @opaque-stellar/sdk-readonly @stellar/stellar-sdk
```

`@stellar/stellar-sdk` is a peer dependency — install the version your app
already uses (this package targets `^13.1.0`).

## Versioning

This package's version tracks the `schemaVersion` field in
[`deployments/v1/<network>.json`](../../deployments/v1/testnet.json) in the
main repo. If you depend on a specific contract deployment, pin the SDK
version that matches that manifest's `schemaVersion`.

## Quick start

```ts
import {
  ReadOnlyContractClient,
  ReputationVerifierReadClient,
} from "@opaque-stellar/sdk-readonly";

const client = new ReadOnlyContractClient({
  contractId: "C...", // reputationVerifier.id from deployments/v1/testnet.json
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  // Any funded testnet account — reads never sign, so no secret key is needed.
  simulationAccount: "G...",
});

const reputationVerifier = new ReputationVerifierReadClient(client);

const latestRoot = await reputationVerifier.getLatestRoot();
const isFrozen = await reputationVerifier.isFrozen();
const timelockDelay = await reputationVerifier.getTimelockDelay();

console.log({ latestRoot, isFrozen, timelockDelay });
```

## Resolving contract ids from a deployment manifest

```ts
import { contractIdFromManifest } from "@opaque-stellar/sdk-readonly";
import manifest from "./testnet.json"; // copy of deployments/v1/testnet.json

const contractId = contractIdFromManifest(manifest, "reputationVerifier");
```

## Available clients

| Client | Contract | Methods |
|---|---|---|
| `ReputationVerifierReadClient` | `reputation-verifier` | `getRootHistory`, `isFrozen`, `lastRootUpdate`, `getLatestRoot`, `getTimelockDelay`, `getPendingAction` |
| `SchemaRegistryReadClient` | `schema-registry` | `isAuthorizedIssuer`, `canIssue`, `isRevocable`, `getSchema`, `getDelegates`, `listSchemasByAuthority` |
| `StealthRegistryReadClient` | `stealth-registry` | `resolve`, `resolveHistorical` |
| `AttestationEngineReadClient` | `attestation-engine-v2` | `getAttestation`, `getConfig`, `checkMerkleUpdatesActive`, `checkProofVerificationActive` |

Each client wraps the shared `ReadOnlyContractClient`, so you only build one
RPC connection per contract id:

```ts
import {
  ReadOnlyContractClient,
  SchemaRegistryReadClient,
} from "@opaque-stellar/sdk-readonly";

const client = new ReadOnlyContractClient({
  contractId: "C...", // schemaRegistry.id
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  simulationAccount: "G...",
});

const schemaRegistry = new SchemaRegistryReadClient(client);
// schemaId is a 32-byte hex string (64 hex chars, optional 0x prefix)
const schemaId = "0x" + "11".repeat(32);
const schema = await schemaRegistry.getSchema(schemaId);
```

See [`docs/integrators/read-only-sdk.md`](../../docs/integrators/read-only-sdk.md)
in the main repo for a longer integration walkthrough.

## Build

```bash
npm install
npm run build
```
