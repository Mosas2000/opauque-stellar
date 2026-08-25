# Troubleshooting Proof Generation Failures

Issue: #649 — *Add troubleshooting guide for proof generation failures*

Reputation proofs are generated entirely in-browser (`snarkjs`, driven from
[`ProofGeneratorModal`](https://github.com/collinsadi/opaque-stellar/blob/main/frontend/src/components/ProofGeneratorModal.tsx)
/ [`ProveTraitModal`](https://github.com/collinsadi/opaque-stellar/blob/main/frontend/src/components/ProveTraitModal.tsx),
both built on
[`reputationProver.ts`](https://github.com/collinsadi/opaque-stellar/blob/main/frontend/src/lib/reputationProver.ts))
and then verified on-chain by `ReputationVerifier.verify_reputation`, which
itself calls into `Groth16Verifier`. Failures can originate at any of those
layers, and the raw errors they throw (WASM traps, fetch errors, contract
error codes) rarely say what actually went wrong. This guide maps the
failure signatures you'll actually see to their cause and fix.

This covers the reference wallet's own proof-generation flow
(`frontend/`). If you're integrating the published SDK
(`@opaquecash/stellar`) instead, its `reputation.prove` /
`verifyOnChain` wrap the same on-chain contracts behind a different error
surface (`NotWiredError`, `RootUnavailableError`, `ContractError`) — see
[ZK Reputation](https://github.com/collinsadi/opaque-stellar/blob/main/sdk/docs/integrate/reputation.md#notes--errors).
The [contract error code reference](#contract-error-code-reference) below
applies to both.

## How to use this guide

Find the exact error text (or closest match) you saw, in one of the four
sections below, then apply the fix. If you're calling contracts directly
(not through the reference wallet UI), jump to the
[contract error code reference](#contract-error-code-reference) instead.

## 1. Artifact fetch failures

**Symptom:** `"V2 circuit files were not found at <wasm path> and <zkey
path>. Redeploy with the frontend circuit artifacts present and
hash-verified."`, or `"The deployed app is serving HTML instead of the V2
witness WASM at <path>. Redeploy with the frontend circuit artifacts present
and hash-verified."`

**Cause:** The prover fetches fixed paths —
`frontend/public/circuits/v2/stealth_reputation.wasm` and
`frontend/public/circuits/v2/stealth_reputation_final.zkey` — and any
network-level failure (missing file, 404, `NetworkError`, "Failed to load")
is rewritten to the first message above. The second (HTML-fallback) message
fires specifically when a static host serves its SPA fallback `index.html`
in place of the WASM binary — a classic symptom of a missing rewrite-rule
exception for `/circuits/**` on the hosting provider. Common root causes:

- `npm run fetch:circuits` was never run, or ran before the release assets
  existed, so `frontend/public/circuits/` is empty or partial.
- The host's SPA catch-all route is serving `index.html` for
  `/circuits/v2/*.wasm` / `.zkey` requests instead of the actual binary
  (`isWasmHtmlFallbackError` in
  [`publicAssets.ts`](https://github.com/collinsadi/opaque-stellar/blob/main/frontend/src/lib/publicAssets.ts)
  detects this by sniffing the response for an HTML content type).
- A CDN/browser cache is serving a stale 404 for a path that now exists —
  hard-refresh or bypass cache.

**Fix:**

```bash
npm run fetch:circuits
npx tsx scripts/verify-artifact-manifest.ts --scanner --circuits --strict
```

The `--strict` verification fails loudly (not silently skip) on any unset
hash, missing file, or hash mismatch against `artifacts/manifest.json` — run
it before assuming the artifacts are actually in place. If your host serves
HTML for the circuit paths, add an explicit static-file/rewrite exception
for `/circuits/**` rather than falling through to the SPA route.

## 2. Memory / out-of-memory failures

**Symptom:** the raw browser/WASM error text, uncaught and shown verbatim —
there is currently no dedicated OOM handling in the proof-generation error
path. Look for `WebAssembly.RuntimeError: memory access out of bounds`,
`RangeError: Array buffer allocation failed`, `"reached wasm memory
limit"`, or the tab/worker simply dying with no further detail.

**Cause:** `snarkjs` witness generation for the V2 circuit
(`stealth_reputation.wasm`) runs in the browser's WebAssembly memory, which
has a hard ceiling set by the browser. All of the errors above mean the
same thing: the circuit's witness computation exceeded available WASM
memory. This is far more common on:

- Mobile browsers (notably mobile Safari, which has a materially lower WASM
  memory ceiling than desktop).
- Machines with many other tabs/extensions already consuming memory.
- Low-RAM devices in general.

**Fix:**

- Close other tabs and retry on the same device.
- Retry on a desktop browser with more available RAM if you're on mobile.
- If you're an **integrator generating many proofs programmatically** (not
  a single end user in a browser tab), don't rely on ad hoc browser tabs at
  all — run proof generation in a controlled headless environment (e.g. a
  server-side Node/WASM runtime with a fixed, sufficient memory limit) so
  failures are deterministic and retriable instead of device-dependent.
- If nothing reaches the UI at all (the worker/tab dies silently), treat it
  as an OOM by default — it's the most common cause of a silent proof-
  generation death.

## 3. Stale / mismatched Merkle root failures

**Symptom:** any of:

- `"No current reputation Merkle root is published for this verifier. The
  root publisher/indexer must publish a root that includes this attestation
  before on-chain verification can run."`
- `"Latest Merkle root is invalid (all zeros)."`
- `"Merkle root mismatch: this proof was generated against a local or stale
  root. Regenerate after the root publisher/indexer has published a root
  that includes this attestation."` (shown to the user prefixed with
  `"Soroban proof verification failed: "`).
- On-chain: `ReputationError::RootExpired` (code 2) from `get_latest_root`
  or `verify_reputation`.
- UI banners: **"Root Frozen: Proof Generation Blocked"** or **"Root
  Stale"** (from
  [`freezePolicy.ts`](https://github.com/collinsadi/opaque-stellar/blob/main/frontend/src/lib/freezePolicy.ts)).
  These are frontend-computed advisories, not an on-chain gate today — the
  contract has no `is_frozen()` entrypoint or freeze-related error variant
  yet; "frozen" is surfaced only if the UI is passed an out-of-band signal
  that governance has frozen updates.

**Cause:** Your proof was built against a Merkle root that no longer
matches what the contract considers current, or no root has been published
at all:

- **No root published / expired root:** `get_latest_root` returns
  `RootExpired` (code 2) once `current_ledger - root_entry.ledger >
  root_expiry_ledgers` (`DEFAULT_ROOT_EXPIRY_LEDGERS = 17_280`, roughly 1
  day at 5s/ledger), or if root history is empty. If you fetched the root
  at the start of a long session and generated the proof later, it may have
  expired by submission time.
- **Superseded root:** the admin published a *newer* root
  (`update_merkle_root`) after you fetched the one you proved against, but
  before you submitted. `submitProofOnChain` re-fetches the latest root and
  fails this check locally before ever submitting on-chain.
- **All-zero root:** the contract has no root published yet (never
  initialized, or `update_merkle_root` hasn't run).

**Fix:**

- Fetch the latest root **immediately before** generating the proof, not at
  session start — treat the root as short-lived, not cached state.
- Re-check the latest root right before submission too (not just before
  generation), and regenerate if it changed in between.
- If you see a "Root Frozen" banner, there is no client-side fix — this
  reflects an out-of-band operational signal, not something a retry solves.

## 4. Input / public-signal mismatch failures

**Symptom:** any of:

- On-chain `InvalidPublicSignal` (code 1) from `Groth16Verifier`, or
  `InvalidProof` (code 3) from `ReputationVerifier`'s pairing check.
- `"Invalid ephemeral public key length: expected 33 bytes, got N"`
- `"Announcement not found for this trait (txHash: …). Try rescanning."`
- The trait card shows: *"Proof generation needs a V2 announcement
  (metadata marker 0xB2) that carries the leaf nonce. This attestation was
  found on-chain for a stealth address you own."* and hides the "Generate
  ZK Proof" button entirely.
- On-chain `NullifierUsed` (code 4) — surfaces as a raw contract error
  inside `"Soroban proof verification failed: …"`; there is no separate
  friendly client-side message for this today.

**Cause — almost always one of:**

- **Attestation discovered without a V2 announcement.** If a trait shows
  the "needs a V2 announcement" notice, the circuit needs the leaf nonce
  that only a V2 announcement's `0xB2` metadata marker carries. Ask the
  issuer to re-announce the attestation with the V2 metadata format, then
  rescan — there is no way to generate this proof from an announcement that
  lacks the marker.
- **Malformed ephemeral public key.** The stealth scheme in use determines
  the expected length (33 bytes compressed for the secp256k1 scheme, 32 for
  the Stellar-native Ed25519 scheme) — the "Invalid ephemeral public key
  length" error names the length you actually passed; recheck the encoding
  step that produced it.
- **`expiration_ledger` argument mismatch.** `verify_reputation` takes a
  trailing `expiration_ledger: u32` argument in addition to the
  prover/proof/root/attestation arguments — if you're submitting proofs
  with your own code (not `submitProofOnChain` as-is), omitting or
  miscomputing it will fail against the current contract ABI, not just at
  runtime.
- **Scalar field overflow.** `is_valid_scalar()` (in
  `contracts/groth16-verifier/src/lib.rs`) rejects any 32-byte public
  signal `>= r` (the BN254 scalar field order). A legitimate Poseidon hash
  output is always `< r`; hitting this from custom tooling usually means a
  field-arithmetic bug upstream of the circuit (e.g. not reducing mod `r`
  before packing a signal).
- **Reused nullifier.** Each verification consumes its nullifier
  permanently. Attempting to resubmit the same proof, or regenerate a proof
  with the same external-nullifier context for an already-verified claim,
  fails by design (`NullifierUsed`) — generate a fresh proof (fresh
  nullifier) per verification.

**Fix:** match the argument list exactly to what `verify_reputation`
currently expects (see `contracts/reputation-verifier/src/lib.rs`), validate
key lengths before generation, and never reuse a nullifier across
submissions.

## Contract error code reference

**`Groth16Verifier` (`VerifierError`)**

| Code | Variant | Meaning |
|---|---|---|
| 1 | `InvalidPublicSignal` | Wrong signal count for the entrypoint, or a signal `>= r` |
| 2 | `Bn128AdditionFailed` | BN254 curve addition failed during pairing check |
| 3 | `Bn128MultiplicationFailed` | BN254 scalar multiplication failed during pairing check |
| 4 | `Bn128PairingFailed` | Pairing check itself failed (invalid proof) |

**`ReputationVerifier` (`ReputationError`)**

| Code | Variant | Meaning |
|---|---|---|
| 1 | `Unauthorized` | Caller is not authorized for an admin-only call (e.g. `update_merkle_root`, `set_root_expiry`) |
| 2 | `RootExpired` | Root older than `root_expiry_ledgers`, or root history/lookup empty |
| 3 | `InvalidProof` | Groth16 pairing check failed |
| 4 | `NullifierUsed` | This nullifier has already been spent |
| 5 | `AlreadyInitialized` | `initialize` called on an already-initialized contract |
| 6 | `AttestationExpired` | `expiration_ledger` for the underlying attestation has passed |
| 7 | `InvalidDatasetHash` | Dataset/root hash failed validation |

See `contracts/reputation-verifier/src/lib.rs` and
`contracts/groth16-verifier/src/lib.rs` for the full enums.

## Still stuck?

If none of the above matches, check
[SECURITY.md](https://github.com/collinsadi/opaque-stellar/blob/main/SECURITY.md)
and open a GitHub issue with the raw error text, and whether the failure is
client-side (browser console) or an on-chain rejection (transaction result
codes).
