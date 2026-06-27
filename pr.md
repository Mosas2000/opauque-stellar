# Fix attestation errors, event v2 migration, root history, and pause controls

Closes #372 · Closes #373 · Closes #374 · Closes #371

---

## #372 — Align attestation error codes for deprecated/expired schemas

**Root cause:** `attest()` called `can_issue` (which returns `false` for
deprecated/expired schemas) before `validate_attestation_against_schema`
(which returns the specific `SchemaDeprecated`/`SchemaExpired` error). The
generic `UnauthorizedIssuer` masked the real failure.

**Fix:** Reorder the two calls — `validate_attestation_against_schema` runs
first, so deprecated and expired schemas surface their own error codes before
the authorization check runs.

**Tests un-ignored:**
- `test_attest_rejects_deprecated_schema` — now expects and receives `SchemaDeprecated`
- `test_attest_rejects_expired_schema` — now expects and receives `SchemaExpired`
- `property_schema_expiry_prevents_new_attestations` — same fix

**Frontend:** adds `mapAttestationIssuanceError` in `programs.ts` mapping
`SchemaDeprecated` (#13), `SchemaExpired` (#14), `Paused` (#11), and other
attestation error codes to actionable user messages.

---

## #374 — Versioned event publishing v1 → v2 migration

**RFC:** `docs/rfcs/0002-event-schema-v2-migration.md` documents the event
layout for v1 and v2, the dual-publish deprecation window, and the testnet
sunset ledger (3 000 000, ~6 months).

**Contracts (dual-publish during deprecation window):**
- `schema-registry`: `SchemaRegistered` v2 adds `version` + `schema_expiry_ledger`
- `attestation-engine-v2`: `AttestationCreated` v2 adds `created_at` +
  `expiration_ledger`; `AttestationRevoked` v2 adds `revocation_ledger` +
  `schema_id`

**Scanner:** adds `SUPPORTED_EVENT_VERSION_V2 = 2` and `is_supported_event_version()`
helper; both announcement scan paths now accept `eventVersion` 1 or 2 instead
of hard-rejecting anything other than 1.

---

## #373 — Reputation root history read helper and audit view

**Contract:** adds two new public methods to `reputation-verifier`:
- `get_root_entry(root) -> Option<MerkleRootEntry>` — single-root lookup
- `get_root_entries(offset, limit) -> Vec<MerkleRootEntry>` — bulk paginated
  fetch combining the root history index with per-entry persistent reads

**Frontend:** adds `fetchRootHistory(publicKey, contractId, offset, limit)`
in `programs.ts` that simulates `get_root_entries` and returns
`RootHistoryEntry[]` (`root`, `ledger`, `datasetHash`). Returns `[]`
gracefully when no roots exist.

**AdminPanel:** new `RootHistoryAudit` component shows a paginated table of
root hash, ledger (timestamp), and dataset hash with Prev/Next controls and
an empty-state message when no roots have been committed.

---

## #371 — Admin pause controls UI

**AdminPanel:** new `PauseControls` component reads `get_config` on
Attestation Engine V2 and shows the current pause state for all three flags:
- Attestation Issuance (`paused_attestation`)
- Merkle Root Updates (`paused_merkle_updates`)
- Proof Verification (`paused_proof_verification`)

Each flag has a colour-coded toggle button (amber = pause, green = unpause)
that opens a confirmation modal describing the effect before dispatching
`pause_*/unpause_*` via the connected wallet. Requires admin or governance
wallet to succeed. The `mapAttestationIssuanceError` added for #372 maps
error code 11 (`Paused`) to a readable message in all wallet flows.

---

## Test plan

- [ ] `cargo test -p attestation-engine-v2` — all tests pass including the
  newly un-ignored `test_attest_rejects_deprecated_schema`,
  `test_attest_rejects_expired_schema`, and
  `property_schema_expiry_prevents_new_attestations`
- [ ] `cargo test -p schema-registry` — existing tests still pass; v2 event
  publish is additive
- [ ] `cargo test -p reputation-verifier` — new `get_root_entries` method
  works; existing tests unaffected
- [ ] Scanner unit tests pass with `SUPPORTED_EVENT_VERSION_V2` accepting v2
- [ ] AdminPanel renders PauseControls and RootHistoryAudit in testnet when
  connected wallet is admin
- [ ] Deprecating a schema and attempting to attest shows "This schema has
  been deprecated" in the wallet flow (via `mapAttestationIssuanceError`)
- [ ] Pausing attestation and attempting to attest shows "Attestation issuance
  is currently paused" in the wallet flow
