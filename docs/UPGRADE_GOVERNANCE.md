# Upgrade Governance

This document describes the immutability guarantees of the deployed Soroban contracts and what alternatives exist for responding to bugs or evolving requirements.

## Overview

The Opaque Stellar contracts are **immutable**. None of the contracts expose an `upgrade()` entrypoint or any other mechanism to replace the on-chain WASM binary after deployment. Once deployed, the contract code at a given address is fixed for the lifetime of that address.

This is a deliberate design choice: immutability gives users a strong guarantee that the contract they interacted with at deployment will continue to behave identically — no silent code changes, no upgrade-based rug pulls, no trust assumptions around upgrade authority.

## Implications

| Property | Immutability Guarantee |
| --- | --- |
| Contract code | Cannot change after deployment |
| Storage layout | Fixed at deployment; no lazy migrations needed |
| Trust model | Users verify the WASM hash once and are done |
| Bug response | Deploy a new contract with a new address |

## Contract Inventory

| Contract | Deployment Model |
| --- | --- |
| `groth16-verifier` | Immutable; verification keys are compile-time constants |
| `privacy-pool` | Immutable |
| `reputation-verifier` | Immutable |
| `attestation-engine-v2` | Immutable; governance config (admin, governance) is mutable on-chain |
| `schema-registry` | Immutable |
| `relayer-registry` | Immutable; config (admin, min stake) is mutable on-chain |
| `stealth-announcer` | Immutable |
| `stealth-registry` | Immutable |

### Mutable Configuration

Although the contract code is immutable, several contracts expose governance functions that mutate on-chain configuration:

- **`attestation-engine-v2`**: Separate `admin` and `governance` roles can pause/unpause features, update the schema registry address, and transfer authority. The `upgrade_info` field stores deployment metadata for off-chain tooling but does not affect on-chain behavior.
- **`relayer-registry`**: The `admin` role can update minimum stake, unstake cooldown, and max deadline via `set_config`. Admin authority can be transferred to a multisig contract via `transfer_admin`.

## Storage Persistence

Persistent storage entries include TTL extension calls to prevent archival (Issue #734). At 5 s/ledger, the default TTL of ~120 days (2,073,600 ledgers) ensures long-lived entries remain accessible without active rent payments.

Contracts that write to persistent storage extend the TTL of each key after every write, keeping the entry alive for another full period. Read-only access to an entry also extends its TTL.

## Emergency Response

Without upgrade capability, the primary emergency response mechanisms are:

1. **Pause functions** (attestation-engine-v2): Individual features can be paused without affecting the rest of the system. This allows halting specific operations while leaving reads and other functions operational.

2. **Slashing** (relayer-registry): Malicious relayer behavior (double-signing, invalid signatures) can be punished by slashing their bonded stake, verified via on-chain cryptographic evidence.

3. **Redeployment**: For bugs that cannot be addressed via pause or governance config changes, deploy a new contract at a new address and coordinate migration with users and indexers. Frontend validation (`EXPECTED_MAJOR_VERSION`) prevents interaction with contracts whose version does not match expectations.

## Upgrade Path (for Address Evolution)

If a breaking change is needed, the recommended path is:

1. **Deploy** the new contract at a fresh address.
2. **Announce** the migration via the governance channel.
3. **Coordinate** frontend and indexer updates to the new address.
4. **Deprecate** the old contract — it remains on-chain and functional but is no longer the active target.

Existing on-chain state (nullifiers, commitments, attestations, schemas) is **not** portable to a new contract address without an explicit data migration plan.

## Client Inspection

Clients can verify contract identity by checking the WASM hash at deployment time. The deployment manifest (`deployments/v1/<network>.json`) records the expected WASM hash and version for each network. Frontend validation (`EXPECTED_MAJOR_VERSION` in `frontend/src/lib/contractVersion.ts`) prevents interaction with contracts whose major version does not match.

## Immutable Components

The following are fixed at compile time and cannot change under any circumstances:

- **Circuit verification keys** (`VK_ALPHA`, `VK_BETA`, etc.) in the `groth16-verifier` contract.
- **Circuit constraints** in `circuits/` — changing the proof system requires a new circuit, new verification keys, and a new verifier contract.
- **Event schema versions** (`EVENT_VERSION`) — changing the event ABI is a breaking change requiring scanner/indexer coordination.

## User-Visible Guarantees

- **Code integrity**: Contract code cannot change after deployment.
- **Storage persistence**: All on-chain state is preserved for the lifetime of the contract (no lazy migrations needed, no upgrade surprises).
- **Address stability**: Contract addresses never change — the code at a given address is guaranteed.
- **Authorization preservation**: Admin and governance roles set at initialization are preserved unless explicitly changed by a governance action.

## Security Considerations

- **Upgrade authority is not a trust assumption** — because there is no upgrade authority. This eliminates the risk of malicious upgrades entirely.
- **Pause mechanisms** are a controlled alternative to upgrades for responding to emergencies.
- **Bug fixes** require deploying new contracts, which gives users full transparency about what code they are interacting with.

## References

- [Soroban Documentation: Contract Upgrades](https://soroban.stellar.org/docs/learn/soroban-and-smart-contracts/upgrading-contracts) — for reference; these contracts do not use this mechanism
- [ADR-0005: Soroban Privacy Pool](adr/0005_soroban_privacy_pool.md) — documents upgrade coordination as a negative consequence
- [ADR-0001: Off-Chain Published Roots](adr/0001_off_chain_published_roots.md) — policy changes can deploy without contract upgrade
- [frontend/src/lib/contractVersion.ts](../frontend/src/lib/contractVersion.ts) — `EXPECTED_MAJOR_VERSION` constant
