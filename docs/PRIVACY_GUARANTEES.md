# Formal Privacy Guarantees

Issue: #647 — *Add formal privacy guarantees document*

> **Status:** Experimental, unaudited software. This document states what
> the protocol is *designed* to guarantee and its precise boundaries — it is
> not an audit result and carries the same caveats as
> [`DISCLAIMER.md`](../DISCLAIMER.md).

Each property below states what a defined adversary **can** and **cannot**
learn, any known weakening of that guarantee, and the component that
enforces it. This supersedes informal privacy statements elsewhere in the
repo (README § Privacy, `frontend/src/lib/privacyThreatModel.ts`) as the
precise reference — those remain useful as UI-facing summaries of the same
facts.

## Adversary models

| Adversary | Capability |
|---|---|
| **Chain observer** | Reads all public Soroban ledger state: contract events, transaction envelopes, amounts, timestamps, source/fee-payer accounts. Cannot see anything not committed on-chain. |
| **RPC / Horizon operator** | Everything a chain observer sees, plus the query patterns of clients connecting through it: which contract/method/args a specific IP address requests, and when. |
| **Wallet software (Freighter)** | Sees every signing request it's asked to approve, tied to the connected G-address. Trusted not to exfiltrate, but is a single point of observation for all of a user's Opaque actions. |
| **Client-side compromise (XSS / malicious extension)** | Can read runtime memory, the DOM, and `localStorage` of an open Opaque tab while the user is active. |
| **Proof verifier / relying party** | Sees exactly the public signals of a submitted Groth16 proof — nothing about the private witness beyond what those signals encode. |

## Properties

### P1 — Receive address unlinkability

**Statement:** Each incoming payment is sent to a fresh, one-time Stellar
account derived via DKSAP (Dual-Key Stealth Address Protocol) from the
recipient's public meta-address and a random ephemeral key.

- **Cannot learn:** A chain observer cannot derive the recipient's
  persistent meta-address, or link two separate stealth receives to the
  same recipient, from the announcement/address data alone.
- **Can learn:** That a payment occurred, its amount, its timing, and the
  sender's account (see P2/P3 below — this property covers *address*
  linkability only).
- **Known weakening:** Distinctive timing or amount patterns across
  multiple receives can still allow statistical correlation by a
  sophisticated observer; the protocol does not add cryptographic timing
  or amount obfuscation in v1.
- **Enforced by:** `frontend/src/lib/stealth.ts` (DKSAP derivation),
  `contracts/stealth-registry` (meta-address registration),
  `contracts/stealth-announcer` (per-payment announcement).

### P2 — Sender / fee-payer visibility (explicit non-guarantee)

**Statement:** The account that pays for and signs a stealth payment
(`createAccount`/payment + `announce()`) is a normal, public Stellar source
account.

- **Cannot learn:** Nothing is hidden here — this is not a guarantee, it is
  a stated boundary.
- **Can learn:** Any chain observer sees exactly who sent a given stealth
  payment, when, and for how much. Opaque never obscures the sender.
- **Known weakening:** N/A — always true, by design; see
  [Custodial Platforms](https://github.com/collinsadi/opaque-stellar/blob/main/sdk/docs/integrate/custodial-platforms.md)
  § Association set and policy implications for what this means for
  platform integrators specifically.
- **Enforced by:** The Stellar ledger itself (outside protocol control);
  documented in `DISCLAIMER.md` § Metadata leakage and
  `privacyThreatModel.ts`'s `PRIVACY_NOT_HIDDEN`.

### P3 — Amount and timing exposure (explicit non-guarantee)

**Statement:** On-chain payment amounts and ledger close times are public
to any chain observer, unconditionally.

- **Cannot learn:** Nothing is hidden here either — stated as a boundary,
  not a guarantee.
- **Can learn:** Exact amount and timestamp of every stealth payment.
- **Known weakening:** N/A — always true. `privacyThreatModel.ts` lists this
  as mitigation `M14`, whose actual mitigation is "user education", i.e.
  there is no cryptographic shielding of amount or timing in v1.
- **Enforced by:** N/A (inherent to a public ledger); see `DISCLAIMER.md` §
  Metadata leakage.

### P4 — Scan privacy via view tags (partial guarantee)

**Statement:** Announcements carry a 1-byte view tag that lets a recipient's
scanner cheaply rule out ~255/256 of irrelevant announcements before running
full DKSAP derivation.

- **Cannot learn:** From the view tag alone, an observer cannot determine
  which specific announcements belong to a given recipient — it is a
  256-way-ambiguous filter, not an identifier.
- **Can learn:** An RPC/Horizon operator still sees *that* a specific client
  IP is polling announcement events, and roughly how often — this is
  metadata about scan activity, not about which payments are the client's.
- **Known weakening:** Self-hosting your own RPC endpoint (`M15` in
  `privacyThreatModel.ts`) removes this leak; it is not the default
  configuration.
- **Enforced by:** `scanner/src/lib.rs` (view-tag prefilter, `M2`/`M3`),
  `contracts/stealth-announcer` (`metadata[0]` view tag field).

### P5 — Reputation proof selective disclosure

**Statement:** A submitted Groth16 reputation proof reveals only its
circuit-defined public signals. The live `verify_reputation` entrypoint
uses the 4-signal V2 layout (`merkle_root, attestation_id,
external_nullifier, nullifier_hash`, checked via `Groth16Verifier
.verify_proof_v2`) — see
[ZK Reputation](https://github.com/collinsadi/opaque-stellar/blob/main/sdk/docs/integrate/reputation.md).
`Groth16Verifier` also exposes a generic 5-signal `verify_proof` and a
6-signal `verify_proof_v3` (used by the privacy pool's withdraw circuit,
not the reputation flow); neither changes what this property covers.

- **Cannot learn:** The verifier learns nothing about the underlying
  attested private trait data, the prover's stealth or spend keys, or which
  specific leaf of the reputation Merkle tree the prover holds, beyond what
  the public signals encode.
- **Can learn:** Whichever fields the circuit designates public — notably
  `attestation_id` (which schema this proof pertains to) is always
  disclosed. See P7 for why this matters for anonymity-set size.
- **Known weakening:** Circuit correctness itself (that the circuit
  actually enforces "prover holds a valid, unrevoked, unexpired attestation
  under this root" and nothing weaker) is **out of scope** for on-chain
  verification. The on-chain verifier only checks the proof is
  valid for the *stated* public signals; it trusts the circuit to have
  encoded the right statement.
- **Enforced by:** `contracts/groth16-verifier` (`verify_proof_v2`, invoked
  from `contracts/reputation-verifier`'s `verify_reputation`), `circuits/`
  (circuit definitions).

### P6 — Nullifier unlinkability across contexts, linkability within one

**Statement:** `nullifier_hash` is scoped by both a per-identity nullifier
secret and the `external_nullifier` (context) value.

- **Cannot learn:** Whether the same underlying identity produced proofs in
  two *different* contexts (different `external_nullifier` values) — those
  nullifier hashes are computationally unrelated to an observer.
- **Can learn:** Whether the *same* nullifier was used twice within one
  context — this is intentional: it's how replay is detected and rejected
  (`NullifierUsed`).
- **Known weakening:** None beyond the above — this is working as designed,
  not a compromise.
- **Enforced by:** `contracts/reputation-verifier` (per-nullifier storage
  check and `NullifierUsed` rejection inside `verify_reputation`), circuit
  nullifier derivation in `circuits/`.

### P7 — Anonymity-set size is structural, not protocol-guaranteed

**Statement:** The strength of P5's "cannot learn which leaf" guarantee is
bounded by how many leaves exist under the proven root that share the
disclosed `attestation_id`/schema — not by anything the ZK circuit itself
adds.

- **Cannot learn:** Precisely which leaf/holder produced a given proof.
- **Can learn (structural weakening):** The disclosed `attestation_id`
  narrows the possible set to holders of *that specific* attestation
  schema. If an issuer has only issued a handful of attestations under that
  schema, the effective anonymity set is that small — trivially so if it's
  1–2 holders. The circuit and verifier make no attempt to enforce a
  minimum set size.
- **Responsible for this boundary:** Issuers and platforms choosing schema
  granularity, not the ZK circuit. See
  `contracts/schema-registry` (schema definitions) and
  `contracts/attestation-engine-v2` (issuance volume per schema) — this is
  the parameter that actually controls real-world privacy strength for a
  given proof. Platform integrators: see
  [Custodial Platforms](https://github.com/collinsadi/opaque-stellar/blob/main/sdk/docs/integrate/custodial-platforms.md)
  § Association set and policy implications before making privacy claims
  about proofs tied to low-volume schemas.

### P8 — Local key custody boundary

**Statement:** Master viewing/spending keys are derived on-device from a
wallet signature and held in memory only; ghost (ephemeral) private keys are
encrypted at rest.

- **Cannot learn (network/server adversary):** A remote adversary with no
  device access can never observe a user's master keys — the protocol has
  no server-side custody of any kind (`frontend/src/context/KeysContext.tsx`
  keeps master keys in memory only, never persisted).
- **Can learn (local/device adversary):** An XSS or malicious extension
  active in the tab can read master keys from memory while the session is
  active, and can read ghost key material if it also captures the user's
  backup password at entry (the AES-256-GCM + PBKDF2 encryption in
  `frontend/src/lib/ghostCrypto.ts` protects passive `localStorage`
  exfiltration; it does not protect against an active compromise that
  captures the password itself, or runtime memory inspection).
- **Known weakening:** Stated directly in `ghostCrypto.ts`'s own threat-model
  comment — this is a documented, intentional scope limit, not an
  oversight.
- **Enforced by:** `frontend/src/context/KeysContext.tsx`,
  `frontend/src/lib/ghostCrypto.ts`.

### P9 — Reputation root authenticity is an admin trust boundary

**Statement:** Proof verification correctness is only as good as the
Merkle root the `reputation-verifier` admin published — the protocol does
not cryptographically prove the off-chain dataset behind a root was built
fairly or completely.

- **Cannot learn (any party, without independent audit):** Whether a given
  root's underlying dataset fairly includes/excludes accounts, from on-chain
  data alone.
- **Can learn:** Every historical root and its `dataset_hash` is public via
  `get_root_history` (permanent, paginated, on-chain), which enables ex-post
  independent audit of what was published and when — it just doesn't
  prevent a dishonest root from being published in the first place.
- **Known weakening:** The admin can publish an arbitrary root at any time —
  `update_merkle_root` only checks that the caller matches the configured
  admin address, not that the underlying dataset is fair or complete. This
  is a named trust assumption, not a bug. (An admin-triggered freeze of
  verification is a UI-level concept today —
  [`frontend/src/lib/freezePolicy.ts`](https://github.com/collinsadi/opaque-stellar/blob/main/frontend/src/lib/freezePolicy.ts) —
  not yet an enforced on-chain contract state.)
- **Enforced by:** `contracts/reputation-verifier` (`update_merkle_root`,
  admin-gated; `get_root_history`, public read).

## Known weakenings (summary)

- **Timing linkage** — not hidden; see P1, P3.
- **Amount linkage** — not hidden; see P3.
- **Deposit / sender linkage** — the paying account is always public; see
  P2. This is the property platform integrators most need to understand —
  see the custodial platform quickstart linked above.
- **Anonymity-set size** — bounded by schema issuance volume, not the
  circuit; see P7.
- **Local compromise** — master/ghost keys are only as safe as the device
  they're used on; see P8.
- **Root/admin trust** — proof correctness inherits trust in whoever
  published the Merkle root; see P9.

None of these are hidden defects — each is stated here precisely so
reviewers and integrators don't have to infer it from README fragments or
source comments.
