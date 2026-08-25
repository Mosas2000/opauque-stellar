# Public Signals Specification

This document defines the ordering, encoding, and valid range for every public signal in the privacy pool withdrawal and reputation circuits. Public signals are the on-chain-visible values that the Groth16 verifier checks against; incorrect ordering or range violations cause real bugs.

## Why This Matters

Issue 13 traced a proof verification failure to a public signal ordering mismatch between the circuit and the verifier contract. This spec is the normative reference for all three circuit versions to prevent similar bugs.

## Circuit Versions

| Circuit                    | File                                     | Verifying Key                     | Deployed Contract             |
| -------------------------- | ---------------------------------------- | --------------------------------- | ----------------------------- |
| v1 (pool withdrawal)       | circuits/stealth_attestation.circom      | artifacts/manifest.json vkey hash | Privacy pool Groth16 verifier |
| v2 (reputation)            | circuits/v2/stealth_reputation.circom    | artifacts/manifest.json vkey hash | Reputation Groth16 verifier   |
| v3 (privacy pool enhanced) | circuits/v3/privacy_pool_withdraw.circom | artifacts/manifest.json vkey hash | Privacy pool v3 verifier      |

## V1 Circuit Public Signals

File: circuits/stealth_attestation.circom

Order: 0-indexed array position in the public signals vector passed to the verifier.

| Index | Signal Name   | Type  | Encoding                  | Valid Range  | Purpose                            |
| ----- | ------------- | ----- | ------------------------- | ------------ | ---------------------------------- |
| 0     | root          | Field | Poseidon hash output      | [0, p-1]     | Merkle root of the commitment tree |
| 1     | nullifierHash | Field | Poseidon(nullifier)       | [0, p-1]     | Prevents double-spending           |
| 2     | recipient     | Field | Stellar address as scalar | [0, 2^256-1] | Withdrawal destination             |
| 3     | relayer       | Field | Stellar address as scalar | [0, 2^256-1] | Relayer submitting the proof       |
| 4     | fee           | Field | Amount in stroops         | [0, 2^64-1]  | Fee paid to relayer                |
| 5     | amount        | Field | Amount in stroops         | [0, 2^64-1]  | Net withdrawal amount              |

Field arithmetic: BN254 scalar field, p = 21888242871839275222246405745257275088548364400416034343698204186575808495617

Address encoding: Stellar G addresses are converted to raw 32-byte ed25519 public keys, then interpreted as a field element in little-endian.

Amount constraints: The circuit enforces fee + amount does not overflow and matches the committed deposit value. Range checks ensure both are within uint64 bounds.

## V2 Circuit Public Signals

File: circuits/v2/stealth_reputation.circom

| Index | Signal Name       | Type  | Encoding                                    | Valid Range  | Purpose                           |
| ----- | ----------------- | ----- | ------------------------------------------- | ------------ | --------------------------------- |
| 0     | reputationRoot    | Field | Poseidon hash output                        | [0, p-1]     | Merkle root of reputation tree    |
| 1     | actionNullifier   | Field | Poseidon(stealthPrivKey, externalNullifier) | [0, p-1]     | Scoped nullifier for the action   |
| 2     | externalNullifier | Field | Application-defined                         | [0, 2^248-1] | Action or context identifier      |
| 3     | attestationId     | Field | Hash of attestation                         | [0, p-1]     | Which attestation is being proven |

Action nullifier binding: The circuit computes actionNullifier = Poseidon(stealthPrivKey, externalNullifier). This prevents the same stealth identity from proving the same action twice without revealing the identity itself.

External nullifier range: Constrained to 248 bits to ensure it fits comfortably within the field and leaves headroom for safe hashing.

## V3 Circuit Public Signals

File: circuits/v3/privacy_pool_withdraw.circom

V3 extends v1 with association set membership proof.

| Index | Signal Name   | Type  | Encoding                  | Valid Range  | Purpose                       |
| ----- | ------------- | ----- | ------------------------- | ------------ | ----------------------------- |
| 0     | stateRoot     | Field | Poseidon hash output      | [0, p-1]     | Current pool state tree root  |
| 1     | aspRoot       | Field | Poseidon hash output      | [0, p-1]     | Association set provider root |
| 2     | nullifierHash | Field | Poseidon(nullifier)       | [0, p-1]     | Prevents double-spending      |
| 3     | recipient     | Field | Stellar address as scalar | [0, 2^256-1] | Withdrawal destination        |
| 4     | relayer       | Field | Stellar address as scalar | [0, 2^256-1] | Relayer submitting the proof  |
| 5     | fee           | Field | Amount in stroops         | [0, 2^64-1]  | Fee paid to relayer           |
| 6     | amount        | Field | Amount in stroops         | [0, 2^64-1]  | Net withdrawal amount         |

The v3 circuit proves membership in both the state tree (stateRoot) and the approved association set (aspRoot). The ASP root is checked on-chain to ensure only approved deposits can withdraw.

## Verifier Contract Integration

The verifying key embedded in each contract must match the circuit version. Mismatch symptoms include valid proofs rejected or invalid proofs accepted.

Verification procedure:

1. Extract public signals from the proof submission
2. Order them exactly as specified in this document
3. Pass the ordered array to the Groth16 verifier contract
4. Contract checks the proof against the embedded verifying key

Updating process when public signals change:

1. Update the circuit source
2. Regenerate the verifying key
3. Update this specification document
4. Update the verifier contract with the new key
5. Update the artifact manifest with new hashes
6. Bump the circuit version number

## Range Check Enforcement

All signals with specified valid ranges are enforced in-circuit via range check gadgets. The circuit compilation must include explicit bit decomposition and comparison constraints for:

- fee and amount: uint64 range checks
- externalNullifier (v2): 248-bit range check
- Stellar addresses: validated during input preparation, not constrained in-circuit

Missing range checks are a soundness bug. See docs/CIRCUIT_RANGE_CHECK_AUDIT.md for the audit checklist.

## Testing Against This Spec

The regression test suite in circuits/test/regression.ts validates:

- Public signal ordering matches the index table above
- Range violations are rejected by the circuit
- Valid inputs within range produce verifiable proofs
- Known-good witness hashes remain stable

When changing public signals:

1. Update this specification first
2. Regenerate circuit fixtures
3. Verify all tests pass
4. Update verifier constants

## References

- Issue 13: Original public signal ordering bug
- circuits/fixtures/v1/expected-public.json: Golden reference for v1
- circuits/fixtures/v2/expected-public.json: Golden reference for v2
- circuits/fixtures/v3/expected-public.json: Golden reference for v3
- docs/CIRCUIT_SOUNDNESS_CHECKLIST.md: Pre-merge soundness review
- docs/NULLIFIER_SPEC.md: Nullifier construction details
- docs/PROVING_BENCHMARKS.md: Performance characteristics per circuit version
