# RFC 0001: Optional XLM/SAC Token Fees for Attestation & Verification

- **Issue:** #382
- **Status:** Draft — pending product signoff
- **Author:** Opaque core contributors
- **Created:** 2026-06-25
- **Contracts affected:** `attestation-engine-v2`, `reputation-verifier`

## 1. Summary

Opaque v1 ships with zero-fee `attest` and `verify_reputation` paths. This RFC
proposes an **optional** fee layer that lets a deployment charge a fee in
native XLM or a Stellar Asset Contract (SAC) token for these two operations,
with escrow and refund semantics for failure cases. The fee layer is
opt-in per deployment and introduces no change to the existing zero-fee
behavior when left disabled.

## 2. Motivation

Future deployments (e.g. issuer-run schemas with paid attestation slots, or
verifier networks that need to cover Groth16 verification compute costs) may
need to monetize attestation issuance or reputation verification. v1's
contracts have no fee primitives — adding them later as a breaking change
would force a migration across `attestation-engine-v2` and
`reputation-verifier`. This RFC defines the fee model now, before integrators
build against the fee-less ABI, while keeping fees fully optional.

## 3. Goals

- Allow a deployment to configure a fee (in XLM or a SAC token) on `attest`
  and/or `verify_reputation`.
- Support escrow: the fee is held by the contract until the underlying
  operation succeeds.
- Support refund: if the underlying operation fails after the fee transfer
  is authorized, the payer is refunded in the same invocation (atomic — no
  separate claim step).
- Leave the zero-fee path (fee config absent or set to 0) byte-for-byte
  unchanged from v1 behavior.

## 4. Non-goals

- Dynamic/market-based fee pricing (oracle-driven fees). Out of scope —
  fees are a fixed amount set by the admin.
- Fee distribution/splitting among multiple recipients. v1 of this RFC
  supports a single configured recipient per contract.
- Cross-chain fee payment. Only XLM and Soroban SAC tokens on the same
  network as the contract are supported.

## 5. Design

### 5.1 Fee configuration

Each contract (`attestation-engine-v2`, `reputation-verifier`) gains an
optional `FeeConfig`:

```rust
#[contracttype]
#[derive(Clone)]
pub struct FeeConfig {
    /// SAC contract address for the fee token, or the native XLM SAC
    /// address (`Asset::native().contract_id(&env)`) for XLM fees.
    pub token: Address,
    /// Fee amount in the token's smallest unit (stroops for XLM).
    pub amount: i128,
    /// Address that receives the fee once the underlying op succeeds.
    pub recipient: Address,
}
```

Stored under a new instance storage key (`"fee_config"`), separate from the
existing `config`/`VerifierConfig` keys, as `Option<FeeConfig>`. Default is
`None` — i.e. **no fee, no behavior change**, matching today's deployments.

Only the contract admin may set or clear the fee config:

```rust
pub fn set_fee_config(env: Env, admin: Address, fee: Option<FeeConfig>)
    -> Result<(), Error>;
```

### 5.2 Fee payer

The fee payer is the same `Address` that already calls and authorizes the
underlying operation (`issuer` for `attest`, `user` for `verify_reputation`).
No new caller-supplied address is introduced — this avoids a new
"pay on behalf of" authorization surface and keeps `require_auth()` checks
unchanged in shape (same address, now also authorizing a token transfer via
the SAC `transfer` invocation's own `require_auth`).

### 5.3 Escrow and execution order

When `fee_config` is `Some`, the contract performs, inside the **same**
`attest` / `verify_reputation` invocation:

1. Run all existing validation that does not have side effects (schema
   checks, signal/proof structural checks, expiry checks, frozen checks).
2. **Escrow step:** invoke the fee token's `transfer` from `payer` to the
   contract's own address for `amount`. This requires `payer.require_auth()`,
   which the caller already supplies for the underlying op.
3. Run the operation's remaining effectful logic (proof verification,
   nullifier consumption, attestation write).
4. **On success:** invoke `transfer` from the contract's address to
   `recipient` for `amount` (release escrow to recipient).
5. **On failure (any error after step 2):** invoke `transfer` from the
   contract's address back to `payer` for `amount` (refund), then return the
   original error to the caller.

Because Soroban contract invocations are atomic, steps 2–5 either fully
commit (success path: payer debited, recipient credited) or fully roll back
(failure path: the entire transaction reverts, including the escrow
transfer in step 2 — so no explicit refund call is even required in
practice; it is documented here as a defense-in-depth fallback for any
future async/cross-contract failure mode where step 2 and the effectful
logic are not part of the same atomic unit, e.g. if escrow is moved to a
separate scheduled action under RFC review).

### 5.4 Failure modes

| Failure | Behavior |
|---|---|
| Payer has insufficient token balance | SAC `transfer` panics/fails before any state is written → entire invocation reverts, fee config unaffected, payer charged nothing. |
| Payer does not authorize the transfer | `require_auth` fails → invocation reverts, same as above. |
| Underlying operation fails after escrow (e.g. invalid proof, expired root, duplicate nullifier) | Escrowed amount is refunded to payer within the same atomic invocation; original `Error` is still returned to the caller so existing error-handling integrations keep working. |
| Recipient address is invalid/frozen for the token | `set_fee_config` should validate the recipient can receive the token at config time; if a transfer to recipient still fails at release time, the whole invocation reverts (payer is not charged, since the revert undoes the escrow transfer too). |
| Admin clears fee config mid-flight | Each invocation reads `fee_config` once at the start; no partial-fee states are possible since reads happen within a single atomic call. |

### 5.5 No breaking change to zero-fee paths

- `fee_config` defaults to `None`. All existing test fixtures, integration
  tests, and the current deployment manifests (which deploy with no fee
  config) observe **identical** behavior to v1: no token transfer calls,
  no new `require_auth` calls, no new storage reads on the hot path beyond
  one cheap `Option` check.
- `attest` and `verify_reputation` keep their existing signatures. No new
  required parameters are added — fee collection is fully derived from
  on-chain config, not caller-supplied arguments.
- Existing error enums (`AttestationError`, `ReputationError`) gain new
  variants (e.g. `FeeTransferFailed`) but no existing variant numbering
  changes.

## 6. Recipient & payer summary

- **Payer:** the existing `issuer` (attest) or `user` (verify_reputation)
  address, already required to authorize the call.
- **Recipient:** a single admin-configured `Address` per contract, set via
  `set_fee_config`. Typically the schema authority or a protocol treasury.
- **Escrow holder:** the contract itself, for the duration of one
  invocation only — funds never rest in contract storage between calls.

## 7. Alternatives considered

- **Charge fees via a separate `pay_fee` call before `attest`:** rejected —
  this allows a payer to pay and never call `attest`, or call `attest`
  without paying, requiring a separate reconciliation/refund mechanism and
  breaking the atomicity guarantees described in §5.3.
- **Let the caller specify an arbitrary fee token at call time:** rejected —
  admin-configured fee token avoids a new attack surface where a caller
  could pass a malicious token contract masquerading as a transfer.

## 8. Acceptance criteria mapping

- **RFC covers fee payer, recipient, and failure modes:** §5.2, §5.5, §6, §5.4.
- **No breaking change to current zero-fee paths:** §5.5.
- **Product signoff recorded in issue or RFC:** see §9 below — signoff is
  tracked in issue #382 and mirrored here once granted.

## 9. Product signoff

> **Status: pending.** This RFC is submitted for review alongside the
> implementation-planning PR that closes #382. No code in this PR changes
> `attest` or `verify_reputation` behavior — this document only proposes
> the design. Product/security signoff should be recorded as a comment on
> issue #382 and then linked here (commit hash + comment URL) before any
> follow-up PR implements §5.
