# RFC 0002: Versioned Event Publishing and v1 → v2 Migration Plan

- **Issue:** #374
- **Status:** Accepted — implementation merged
- **Author:** Opaque core contributors
- **Created:** 2026-06-26
- **Sunset date for v1 events:** ledger 3 000 000 on testnet (~6 months); mainnet date TBD post-audit
- **Contracts affected:** `schema-registry`, `attestation-engine-v2`
- **Scanner affected:** WASM scanner (`scanner/src/lib.rs`)

---

## 1. Problem

Contract events carry an `EVENT_VERSION` topic field so scanners can detect
layout changes rather than silently misparsing new payloads. The contracts
shipped with `EVENT_VERSION = 1`. Extending the payload of existing event
types (e.g. adding `schema_expiry_ledger` to `SchemaRegistered`, or
`revocation_ledger` to `AttestationRevoked`) would silently break scanners
that assume the v1 layout if the version field is not incremented.

At the same time, flipping `EVENT_VERSION` from 1 to 2 without a transition
window would break any scanner that has already been deployed against v1 — it
would start skipping all events until redeployed with v2 support.

The solution is a **versioned dual-publish**: every mutating entry point emits
both a v1 event (identical payload to today, retained for backward compat)
**and** a v2 event (extended payload) during an agreed-upon deprecation window.
After the sunset ledger, a follow-up PR removes the v1 publish.

---

## 2. Event layout

### 2.1 `schema-registry`

#### `SchemaRegistered`

| Version | Topics | Data fields |
|---------|--------|-------------|
| v1 | `("SchemaRegistered", 1)` | `(schema_id, authority, name)` |
| v2 | `("SchemaRegistered", 2)` | `(schema_id, authority, name, version, schema_expiry_ledger)` |

New v2 fields:
- `version: u32` — the schema version number (used for schema ID derivation)
- `schema_expiry_ledger: u32` — expiry ledger (0 = never expires)

#### `DelegateAdded` / `DelegateRemoved`

No payload change; continue emitting at v1 only until a future RFC.

---

### 2.2 `attestation-engine-v2`

#### `AttestationCreated`

| Version | Topics | Data fields |
|---------|--------|-------------|
| v1 | `("AttestationCreated", 1)` | `(uid, schema_id, issuer, stealth_address_hash)` |
| v2 | `("AttestationCreated", 2)` | `(uid, schema_id, issuer, stealth_address_hash, created_at, expiration_ledger)` |

New v2 fields:
- `created_at: u32` — ledger sequence at issuance
- `expiration_ledger: u32` — expiry ledger (0 = never expires)

#### `AttestationRevoked`

| Version | Topics | Data fields |
|---------|--------|-------------|
| v1 | `("AttestationRevoked", 1)` | `(uid, revoker)` |
| v2 | `("AttestationRevoked", 2)` | `(uid, revoker, revocation_ledger, schema_id)` |

New v2 fields:
- `revocation_ledger: u32` — ledger at which revocation was recorded
- `schema_id: BytesN<32>` — schema the revoked attestation belonged to

---

## 3. Scanner transition

During the deprecation window the scanner MUST accept **both** v1 and v2
event versions. Rejecting unknown versions (the current behaviour) is correct
in steady state, but during the window v1 and v2 will coexist. The scanner's
`is_supported_event_version` helper is updated to return true for `1 | 2`.

Scanners that only support v1 and encounter a v2 duplicate of the same
logical event will process the v1 copy and skip the v2 one — semantics are
preserved since v1 is a strict subset of v2.

After the v1 sunset ledger:
1. Remove the v1 `env.events().publish` calls from both contracts.
2. Remove `1` from the accepted version set in the scanner.
3. Increment `SUPPORTED_EVENT_VERSION` to `2`.

---

## 4. Sunset timeline

| Milestone | Target |
|-----------|--------|
| v2 dual-publish ships | This RFC (merged) |
| Testnet v1 sunset | Ledger 3 000 000 (~6 months at 5 s/ledger) |
| Mainnet v1 sunset | To be determined post-mainnet-audit signoff |

The sunset ledger will be announced in a follow-up PR that removes v1
publish calls and updates the scanner's accepted version set.

---

## 5. Acceptance criteria

- [x] Migration RFC checked into `docs/rfcs/`.
- [x] `schema-registry` and `attestation-engine-v2` emit both v1 and v2 events on every state change.
- [x] Scanner accepts `eventVersion` 1 and 2 during the deprecation window.
- [x] Sunset date for v1 events is documented above.
