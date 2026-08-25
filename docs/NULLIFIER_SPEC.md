# Nullifier Derivation Specification

> Tracking issue: [#598 — Add formal specification for nullifier derivation](https://github.com/collinsadi/opaque-stellar/issues/598)

This document specifies nullifier derivation independently of the circuit
implementation. It defines exact inputs, the hash construction, domain
separation between action types, and the security properties the construction
is intended to satisfy.

---

## Background

A nullifier is a public commitment that a specific private action has been
performed. Publishing the nullifier on-chain prevents the same action from being
repeated (double-spend prevention) without revealing which party performed it or
linking two separate actions to the same party.

---

## Inputs

| Symbol | Type | Description |
|---|---|---|
| `sk` | BabyJubJub scalar (253-bit field element over BN254) | The holder's stealth private key, derived from their Ghost Address spending key |
| `η` | Field element | The external nullifier: an action-scoped domain tag and action ID combined (see §Domain Separation) |

The stealth private key `sk` never appears on-chain or in any public signal.

---

## Hash Function

Nullifiers are computed with **Poseidon** over the BN254 scalar field:

```
nullifier = Poseidon₂(sk, η)
```

`Poseidon₂` denotes the two-input variant of the Poseidon permutation
(`circomlib/circuits/poseidon.circom`, `Poseidon(2)`). Poseidon was chosen
because it has native support as a host function on Stellar's BN254 host
environment, making on-chain verification O(1) in gas.

### Circuit reference

`circuits/stealth_attestation.circom`, Step 8:

```circom
component nullifierHash = Poseidon(2);
nullifierHash.inputs[0] <== stealth_private_key;
nullifierHash.inputs[1] <== external_nullifier;
nullifier <== nullifierHash.out;
```

### V2 note

`circuits/v2/stealth_reputation.circom` uses `nullifier_hash` as a **public
input** rather than an output, enabling the prover to supply the nullifier
without recalculating it inside the circuit. The Poseidon construction above
remains the same.

---

## Domain Separation

The `external_nullifier` field `η` encodes both an **action type tag** and an
**action instance identifier**, preventing a nullifier valid for one action type
from being replayed under a different type.

### Encoding

```
η = Poseidon₂(DOMAIN_TAG[action_type], action_instance_id)
```

| `action_type` | `DOMAIN_TAG` (decimal) | Notes |
|---|---|---|
| `reputation_claim` | `1` | Asserting a badge / attestation during a one-time gate |
| `vote` | `2` | Governance vote or quadratic-funding round |
| `loan_application` | `3` | Credit-gate entry per lending round |
| `kyc_gate` | `4` | Identity gate with external nullifier supplied by the KYC operator |

Additional action types must be assigned a unique non-zero tag before deployment
and documented in this table.

### Why this is sufficient

Two nullifiers derived from the same `sk` but different `action_type` values
produce distinct `η` values under Poseidon (assuming Poseidon collision
resistance, which holds under the BN254 field size). Therefore:

```
Poseidon₂(sk, Poseidon₂(1, id)) ≠ Poseidon₂(sk, Poseidon₂(2, id))
```

with overwhelming probability (probability of collision ≤ 2⁻¹²⁵ under the
Poseidon security claim for BN254).

A valid nullifier for `vote` cannot be replayed as a `reputation_claim`
nullifier and vice versa. The contract registry stores nullifiers keyed by
`(action_type, nullifier)` pair to make this explicit on-chain.

---

## Security Properties

### Uniqueness

For fixed `sk` and fixed `η`, the nullifier is deterministic. The same prover
performing the same action produces the same nullifier, which the contract
rejects on the second use. This prevents double-claims.

*Formal claim:* Under Poseidon preimage resistance, no polynomial-time adversary
can find `(sk₁, η₁) ≠ (sk, η)` such that `Poseidon₂(sk₁, η₁) = Poseidon₂(sk, η)`.

### Unlinkability

Two nullifiers derived from the same `sk` but different `η` values are
computationally indistinguishable from nullifiers derived from unrelated keys.
An observer seeing `n₁ = Poseidon₂(sk, η₁)` and `n₂ = Poseidon₂(sk, η₂)` cannot
determine that the same `sk` was used without knowledge of the private key.

*Formal claim:* Under Poseidon pseudo-randomness (which follows from its
algebraic security arguments over BN254), the joint distribution
`(Poseidon₂(sk, η₁), Poseidon₂(sk, η₂))` is computationally indistinguishable
from a uniform pair, assuming `sk` is hidden.

### Cross-action non-collision

By §Domain Separation, `η` values for distinct action types are disjoint.
A nullifier cannot be valid simultaneously under two action types.

---

## Divergence Review

The following check was performed against the live circuit code at commit
HEAD of `main` (July 2026):

| Spec claim | Circuit / contract code | Status |
|---|---|---|
| `nullifier = Poseidon₂(sk, η)` | `stealth_attestation.circom` line 169–173 | ✓ matches |
| Public signal order: nullifier at index 0 | `PUBLIC_SIGNALS.md` V1 table | ✓ matches |
| V2 nullifier_hash as public input | `v2/stealth_reputation.circom` | ✓ matches |
| Poseidon(2) from circomlib | `include "circomlib/circuits/poseidon.circom"` | ✓ matches |

No divergence between this spec and the implementation was found. Any future
circuit change that alters these inputs or the hash function must update this
document and file an issue before merging.

---

## References

- [PUBLIC_SIGNALS.md](PUBLIC_SIGNALS.md) — canonical ordering of Groth16 public signals
- [GHOST_THREAT_MODEL.md](GHOST_THREAT_MODEL.md) — threat model including nullifier reuse attacks
- Poseidon paper: Grassi et al., "Poseidon: A New Hash Function for
  Zero-Knowledge Proof Systems," USENIX Security 2021
