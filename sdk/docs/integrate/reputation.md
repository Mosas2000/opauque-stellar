# Integrate: ZK Reputation

End-to-end on-chain zero-knowledge reputation: an authority registers a schema, an
issuer attests to a stealth identity, and a holder proves they possess the
attestation — verified **inside a Soroban contract** — without revealing which
identity holds it. See [ZK Reputation](/concepts/zk-reputation) for the model.

## Prerequisites

```sh
npm install @opaquecash/stellar "@stellar/stellar-sdk" "@noble/curves@^1" "@noble/hashes@^1" circomlibjs snarkjs
```

- `circomlibjs` + `snarkjs` — witness + Groth16 proof generation.
- **Circuit artifacts** — v2 `stealth_reputation.wasm` + `.zkey` via an
  `ArtifactResolver` (required for `prove` / `proveAndVerify`).

```ts
import { OpaqueClient, keypairSigner, urlArtifactResolver } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.STELLAR_SECRET!),
  artifacts: urlArtifactResolver({ baseUrl: "https://your-cdn.example" }), // serves circuits/v2/*
});
```

## Roles

- **Authority** — registers the schema (the trait's shape). `signer` = authority.
- **Issuer** — attests that a stealth identity has the trait. `signer` = issuer.
- **Holder** — proves possession and verifies on-chain. `signer` = anyone (the
  proof is what's checked, not the caller).

## Step 1 — Authority registers a schema

A schema defines the trait's fields. The id is derived deterministically from the
authority + name + fields.

```ts
const { schemaId, txHash } = await opaque.schemas.register({
  name: "credit",
  fieldDefinitions: "u64 score, bool verified", // "type name" comma-separated
  revocable: true,
  schemaExpiryLedger: 6_000_000,
});
// schemaId — 32-byte id; share it with issuers
```

Supported field types: `bool`, `u8`, `u16`, `u32`, `u64`, `string`, `pubkey`.

## Step 2 — Issuer attests to a stealth identity

The issuer encodes the field values and attests them to a holder's stealth
address hash (a 32-byte identifier for the holder's stealth identity).

```ts
await opaque.reputation.attest({
  schemaId,
  stealthAddressHash,                 // 32-byte hash of the holder's stealth identity
  fieldValues: { score: "780", verified: "true" },
  fieldDefinitions: "u64 score, bool verified", // same shape as the schema
  expirationLedger: 6_000_000,
});
```

The attestation is recorded on-chain. Attestations form a Poseidon Merkle tree
whose root an indexer publishes on the reputation-verifier (Step 4 needs that).

## Step 3 — Holder generates a proof

The holder proves possession of the trait, scoped to an **external nullifier**
(your application context — prevents the same identity proving twice in that
context).

```ts
const proof = await opaque.reputation.prove({
  attestationId,                 // numeric trait/attestation id (must fit u64)
  stealthPrivKey,                // the holder's stealth private key (32 bytes)
  externalNullifier: 42n,        // your app context id (must fit u64)
});
// proof.proofA/B/C, merkleRoot, attestationId, nullifierHash, externalNullifier, publicSignals
```

## Step 4 — Verify on-chain

Submit the proof to the reputation-verifier contract, which enforces root
validity + nullifier-replay protection and runs the Groth16 check via the BN254
host functions.

```ts
// the published root must already cover this attestation:
const root = await opaque.reputation.getLatestRoot();
if (!root) {
  // indexer hasn't published a root including this attestation yet — wait.
}

const txHash = await opaque.reputation.verifyOnChain(proof);
// reverts (ContractError) on nullifier replay (#4) or expired/stale root (#2)
```

Or do both in one call:

```ts
const txHash = await opaque.reputation.proveAndVerify({
  attestationId,
  stealthPrivKey,
  externalNullifier: 42n,
});
```

::: tip Already have a proof?
`verifyOnChain` accepts any proof bundle of the right shape — you can generate it
elsewhere (even without the `artifacts` resolver) and just submit it here.
:::

## Full end-to-end script

```ts
import { OpaqueClient, keypairSigner, urlArtifactResolver } from "@opaquecash/stellar";

// authority registers the schema
const authority = new OpaqueClient({ network: "testnet", signer: keypairSigner(AUTHORITY_SECRET) });
const { schemaId } = await authority.schemas.register({
  name: "credit", fieldDefinitions: "u64 score, bool verified",
  revocable: true, schemaExpiryLedger: 6_000_000,
});

// issuer attests
const issuer = new OpaqueClient({ network: "testnet", signer: keypairSigner(ISSUER_SECRET) });
await issuer.reputation.attest({
  schemaId, stealthAddressHash, fieldValues: { score: "780", verified: "true" },
  fieldDefinitions: "u64 score, bool verified", expirationLedger: 6_000_000,
});

// holder proves + verifies on-chain
const holder = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(HOLDER_SECRET),
  artifacts: urlArtifactResolver({ baseUrl: ARTIFACT_BASE_URL }),
});
const txHash = await holder.reputation.proveAndVerify({
  attestationId, stealthPrivKey, externalNullifier: 42n,
});
```

## Notes & errors

- `NotWiredError` from `prove` → no `artifacts` resolver configured (you can still
  `verifyOnChain` a precomputed proof).
- `RootUnavailableError` / null root → the indexer hasn't published a root
  including the attestation yet; retry.
- `ContractError` `#4` → nullifier replay (already proven in this context); `#2` →
  expired/stale root.
- `attestationId` and `externalNullifier` must fit in `u64`.

If proof generation or on-chain verification fails and the above doesn't
cover it, see
[Troubleshooting Proof Generation Failures](https://github.com/collinsadi/opaque-stellar/blob/main/docs/TROUBLESHOOTING_PROOF_GENERATION.md)
for the full set of failure signatures (artifact fetch, memory, stale root,
input mismatch) mapped to causes and fixes, including the on-chain
`Groth16Verifier`/`ReputationVerifier` error code reference.
