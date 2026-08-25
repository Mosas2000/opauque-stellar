# Admin Key Compromise Playbooks

> Tracking issues: [#485 — Add admin key compromise playbooks](https://github.com/collinsadi/opaque-stellar/issues/485)
>
> Companion to [MULTISIG_ADMIN.md](MULTISIG_ADMIN.md) (how admin authority is
> structured) and [UPGRADE_GOVERNANCE.md](UPGRADE_GOVERNANCE.md) (how upgrades
> and rollbacks work). **Linked from [SECURITY.md](../SECURITY.md).**

Opaque Stellar is a multi-contract deployment: a single compromised admin key
can affect one contract without affecting the others, but the blast radius
still spans any protocol state that contract governs (state roots, attestations,
deposits/withdrawals, relayer economics). This document gives the on-call
operator a per-contract-role runbook for the four actions needed under a
suspected or confirmed compromise:

1. **Pause / Freeze** — stop the bleeding.
2. **Admin transfer** — evict the compromised key.
3. **Contract upgrade** — patch a vulnerable binary if needed.
4. **Verification & comms** — confirm the action landed and tell users.

Every action below is gated by the role documented in `MULTISIG_ADMIN.md`:
single-key admin functions require the single admin account; registries that
have migrated to `multisig-admin` require the documented N-of-M signature
threshold (verify on-chain with `get_config()` / `get_signers()` /
`get_threshold()`). The playbook assumes you already know **which** key was
exposed — if you do not, start with the diagnosis step in the drill checklist.

---

## 0. First 30 minutes (all roles)

Regardless of which contract is affected:

- [ ] **Confirm the compromise.** Do not act on a hunch. Gather: the exposed
      key, the transaction(s) it signed (or could sign), and the time window.
- [ ] **Open a private security advisory** (see SECURITY.md) and tag the
      on-call operator + at least one multisig signer.
- [ ] **Identify the affected contract role(s)** using the table in §1 below.
- [ ] **Do not** rotate the deployer key alone and assume you are safe — for
      upgrade authority the deployer account may differ from the contract
      `admin`/`governance` field. Check both.
- [ ] **Start a timeline** in the advisory: every action, who signed, tx hash,
      and timestamp. This becomes the post-mortem.

---

## 1. Contract role map

| Contract | Admin role(s) | Pause / freeze surface | Admin-transfer fn | Upgrade authority |
| --- | --- | --- | --- | --- |
| `attestation-engine-v2` | `admin`, `governance` | `pause_attestation`, `pause_merkle_updates`, `pause_proof_verification` (and `unpause_*`) | `transfer_admin`, `transfer_governance` | Deployer / delegated multisig |
| `privacy-pool` | `admin` | `pause_deposits`, `request_pause_withdrawals` (and `unpause_*`, `is_deposits_paused`, `is_withdrawals_paused`) | `transfer_admin` | Deployer / delegated multisig |
| `reputation-verifier` | `admin` | `set_root_expiry` / freeze root publishing | `transfer_admin` | Deployer / delegated multisig |
| `relayer-registry` | `admin` | `set_config` (disable economic actions) | `transfer_admin` | Deployer / delegated multisig |
| `multisig-admin` | signer set | N/A (it *is* the control plane) | `propose_rotation` → `approve` (threshold) | Deployer / delegated multisig |
| `groth16-verifier` | Deployer / multisig | N/A (immutable VKs) | — | Deployer / delegated multisig |
| `schema-registry` | per-schema `authority` | per-schema only | per-schema issuer | Deployer / delegated multisig |
| `stealth-registry`, `stealth-announcer` | permissionless | N/A | N/A | Deployer / delegated multisig |

`schema-registry` and the stealth contracts have **no protocol-wide admin**; a
compromised *issuer* key only affects that issuer's own schema/attestations and
is handled by revoking that issuer (`attestation-engine-v2::revoke_attestation`)
and re-issuing from a fresh key — out of scope for the protocol-admin
playbooks below.

---

## 2. Per-role playbooks

### 2.1 `attestation-engine-v2` (admin / governance compromise)

`attestation-engine-v2` has the richest pause surface: attestation issuance,
Merkle updates, and proof verification can each be halted independently, so you
can surgically stop the abused function without freezing the whole contract.

**Step A — Pause / Freeze (stop the bleeding)**
Invoke the relevant pause function with the compromised role's authority. Which
one depends on the abuse vector:

- Attestations being forged / revoked maliciously → `pause_attestation(caller)`.
- State roots being published with bad data → `pause_merkle_updates(caller)`.
- Fake proofs being accepted → `pause_proof_verification(caller)`.

For an unknown or full compromise, pause all three. Verify each with
`check_merkle_updates_active()` / `check_proof_verification_active()` /
`is_authorized_issuer()` returning the expected (inactive) state.

**Step B — Admin transfer (evict the compromised key)**
If the compromised key holds `admin`:

```text
attestation_engine.transfer_admin(current_admin, new_safe_address)
```

If it also holds `governance` (the two-key governance model), transfer that
separately:

```text
attestation_engine.transfer_governance(current_governance, new_safe_address)
```

After `transfer_admin`/`transfer_governance`, the old key's `require_auth()`
**stops matching immediately** — every admin-gated check reads `config.admin`
fresh from storage. This is irreversible for the old key without a new transfer.

**Step C — Contract upgrade (if the binary itself is suspect)**
If the compromise involved a malicious or buggy WASM (not just a leaked key),
redeploy a known-good hash:

```text
# deployer / delegated multisig signs upgrade()
contract.upgrade(new_wasm_hash)
```

Confirm with `version()`. The `upgrade_info` field can record *why* this
upgrade happened for off-chain tooling. Storage is preserved; see
UPGRADE_GOVERNANCE.md rollback if the new binary misbehaves.

**Step D — Verify & communicate**
- [ ] `get_config()` shows the new `admin`/`governance`.
- [ ] Paused functions report inactive.
- [ ] Post in the advisory: which functions paused, new admin address, tx hash.
- [ ] Once safe, `unpause_*` the functions you paused, only after confirming the
      new key is controlled.

---

### 2.2 `privacy-pool` (admin compromise)

**Step A — Pause / Freeze**
- Stop new funds entering a poisoned pool → `pause_deposits(admin)`.
- Stop withdrawals (e.g. if a root attack could drain) →
  `request_pause_withdrawals(admin)` then confirm with `is_withdrawals_paused()`.
  (`request_pause_withdrawals` is a two-step request by design; follow it with
  the approval step your deployment configured.)
- Verify with `is_deposits_paused()` / `is_withdrawals_paused()`.

**Step B — Admin transfer (evict the compromised key)**

```text
privacy_pool.transfer_admin(admin, new_admin)
```

The previous single admin key **immediately and permanently loses admin access**
once this executes.

**Step C — Contract upgrade (if binary suspect)**
```text
privacy_pool.upgrade(new_wasm_hash)   # deployer / delegated multisig
```
Confirm with `version()`. Note `update_state_root` and `set_root_expiry` are
admin-gated and will now require the new admin.

**Step D — Verify & communicate**
- [ ] `get_config()` reflects the new admin.
- [ ] Deposits/withdrawals paused or resumed per decision.
- [ ] Advisory updated with tx hash + new admin address.

---

### 2.3 `reputation-verifier` (admin compromise)

**Step A — Pause / Freeze**
There is no `pause_*` here; the freeze surface is root publishing. Stop fresh
roots from being accepted by tightening `set_root_expiry(admin, 0)` so stale
roots are rejected, and halt new `update_merkle_root` acceptance until safe.

**Step B — Admin transfer (evict the compromised key)**

```text
reputation_verifier.transfer_admin(admin, new_admin)
```

**Step C — Contract upgrade (if binary suspect)**
```text
reputation_verifier.upgrade(new_wasm_hash)   # deployer / delegated multisig
```

**Step D — Verify & communicate**
- [ ] `get_config()` shows the new admin.
- [ ] `get_latest_root()` / `get_root_history()` reviewed for tampering.
- [ ] Advisory updated.

---

### 2.4 `relayer-registry` (admin compromise)

**Step A — Pause / Freeze**
Freeze economic parameters with `set_config(admin, ...)` to disable new job
creation / stake changes, and consider `slash_job` on any in-flight malicious
job. Review `get_config()` after.

**Step B — Admin transfer (evict the compromised key)**

```text
relayer_registry.transfer_admin(admin, new_admin)
```

**Step C — Contract upgrade (if binary suspect)**
```text
relayer_registry.upgrade(new_wasm_hash)   # deployer / delegated multisig
```

**Step D — Verify & communicate**
- [ ] `get_config()` shows the new admin.
- [ ] No active malicious jobs (`get_job` / `get_relayer`).
- [ ] Advisory updated.

---

### 2.5 `multisig-admin` signer compromise (control-plane compromise)

If a **signer** of a `multisig-admin` that governs the above contracts is
compromised, you do **not** redeploy — you rotate the signer set through the
multisig's own propose/approve path:

```text
multisig.propose_rotation(proposer, new_signers, new_threshold)
# each remaining honest signer:
multisig.approve(signer, proposal_id)   # executes at threshold
```

Verify with `get_signers()` / `get_threshold()`. Because rotation is just
another proposal kind, **no redeployment of `multisig-admin` or the registries
it administers is required**. If the *deployer* of `multisig-admin` is
compromised, treat it like any upgrade-authority compromise (§2.6) and redeploy
a fresh `multisig-admin`, then re-point each registry's `admin` at the new
address via the now-safe `transfer_admin`.

---

### 2.6 Upgrade-authority (deployer) compromise

If the **deployer account** (or its delegated multisig) is compromised, the
blast radius is every contract it can `upgrade()`:

1. **Pause** the affected contracts' sensitive functions (§2.1–§2.4) using
   whatever remaining admin authority is still safe.
2. **Rotate the deployer key** at the Stellar account level (Stellar
   `SetOptions` / account threshold) so the old key can no longer sign
   `upgrade()`.
3. **Re-deploy a fresh `multisig-admin`** and re-point each registry's `admin`
   at it via `transfer_admin` from the (now-safe) prior admin.
4. **Verify** `version()` on each contract and `get_config()` on each registry.
5. Record all new addresses in `deployments/v1/<network>.json`.

---

## 3. Cross-contract "big red button" sequence

When you cannot yet tell which contract is affected but suspect broad
compromise, apply defensive pauses in order of fund-risk, then investigate:

1. `privacy-pool`: `pause_deposits` + `request_pause_withdrawals` (funds first).
2. `attestation-engine-v2`: `pause_attestation`, `pause_merkle_updates`,
   `pause_proof_verification`.
3. `reputation-verifier`: `set_root_expiry(0)`.
4. `relayer-registry`: `set_config` to freeze jobs.
5. Then run §2.5 / §2.6 to evict the compromised key(s) before re-enabling.

Each pause is reversible (`unpause_*`) once the key is rotated, so defensive
pausing errs on the side of safety.

---

## 4. Drill checklist (run quarterly)

The playbooks above are only useful if the on-call operator can execute them on
a testnet under time pressure. Run this drill every quarter and record results
in the security advisory tracker.

**Pre-drill**
- [ ] A testnet deployment exists with `multisig-admin` wired to at least one
      registry (see MULTISIG_ADMIN.md migration steps).
- [ ] At least 2 operators have the testnet admin/multisig signer keys in a
      test-only wallet.
- [ ] `deployments/v1/testnet.json` is the source of truth for addresses.

**Drill execution (simulate a leaked `admin` key on `privacy-pool`)**
- [ ] Operator identifies the affected role from §1 in < 5 min.
- [ ] `pause_deposits` executed and confirmed via `is_deposits_paused()`.
- [ ] `transfer_admin` to a fresh key executed; old key confirmed unable to
      call admin fns (negative test: old key's call reverts).
- [ ] `unpause_deposits` after rotation; `get_config()` shows new admin.
- [ ] Total time from "start" to "contained" recorded.

**Drill execution (simulate a leaked `multisig-admin` signer)**
- [ ] `propose_rotation` + enough `approve`s to reach threshold.
- [ ] `get_signers()` shows the compromised signer removed.
- [ ] Negative test: the removed signer can no longer `approve`.

**Drill execution (simulate a leaked deployer key)**
- [ ] Deployer account key rotated at account level.
- [ ] Fresh `multisig-admin` deployed; `transfer_admin` re-points the registry.
- [ ] `version()` + `get_config()` verified on the registry.

**Post-drill**
- [ ] Timeline written up; gaps (missing keys, unclear thresholds, missing
      runbook steps) filed as follow-ups.
- [ ] `deployments/v1/testnet.json` updated if any address changed.
- [ ] Next drill date scheduled (quarterly).

---

## 5. References

- [MULTISIG_ADMIN.md](MULTISIG_ADMIN.md) — admin authority structure & migration
- [UPGRADE_GOVERNANCE.md](UPGRADE_GOVERNANCE.md) — upgrade/rollback procedure
- [KEY_MANAGEMENT_GUIDE.md](KEY_MANAGEMENT_GUIDE.md) — storing & rotating keys
- [SECURITY.md](../SECURITY.md) — how to report a compromise
