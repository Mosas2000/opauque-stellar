# Registry Admin: Multisig Migration

Registry admin functions (`attestation-engine-v2`'s pause/schema-rewiring,
`privacy-pool`'s root publishing, `reputation-verifier`'s Merkle root
publishing, `relayer-registry`'s economic parameters) were each controlled by
a single Stellar keypair. One compromised key was sufficient to poison
protocol state for that contract. `contracts/multisig-admin` (Issue #589)
replaces that with an on-chain N-of-M threshold scheme: registries point
their `admin` (and, for `attestation-engine-v2`, `governance`) field at a
deployed `multisig-admin` contract's address instead of a single account.

## Why a contract, not a native Stellar multisig account

Stellar accounts already support N-of-M signing natively (`SetOptions`), and
pointing a registry's `admin` at such an account works with zero contract
changes. But the threshold in that model lives entirely off-chain, in the
account's signer configuration — nothing on-chain can verify or document it.
`multisig-admin` makes the signer set and threshold first-class, queryable
contract state (`get_config`/`get_signers`/`get_threshold`), so "admin
operations require the documented signature threshold" is something anyone
can check on-chain, not an operational claim they have to trust.

## How it works

1. **Propose.** A signer calls `propose_call(proposer, target, fn_name, args)`
   to propose invoking some function on some registry (e.g. `privacy-pool`'s
   `update_state_root`), or `propose_rotation(proposer, new_signers,
   new_threshold)` to propose changing the signer set itself. The proposer's
   own approval is recorded immediately.
2. **Approve.** Other signers call `approve(signer, proposal_id)`. Once
   distinct approvals reach the configured threshold, the action executes
   automatically in that same call — `multisig-admin` invokes the target
   registry's function directly (`Call`) or updates its own signer-set config
   directly (`RotateSigners`).

No code in the registries changes to support this: Soroban's authorization
model already treats a contract address as a valid `Address`, and a
contract's own direct calls always satisfy `require_auth()` for its own
address without a separate signature. This is verified directly (not just
assumed) by
`contracts/privacy-pool/src/test.rs`'s
`state_root_publishable_through_a_real_multisig_after_admin_migration` and
`contracts/multisig-admin/src/test.rs`'s
`multisig_direct_call_needs_no_separate_signature_beyond_signer_approvals`,
which use targeted `mock_auths` (not the blanket `mock_all_auths`) so the
test cannot pass by test-harness leniency.

Signer rotation goes through the exact same propose/approve/threshold path as
any other action — it is just another proposal kind — so **key rotation
within the set requires no redeployment of `multisig-admin` or of the
registries it administers.**

`initialize` rejects a signer set smaller than 2 or a threshold below 2: a
1-of-1 "multisig" is a single-key admin path wearing a costume, and would
satisfy none of this issue's acceptance criteria.

## Migrating an existing registry

Each registry gained a `transfer_admin` function (and, for
`attestation-engine-v2`, `transfer_governance`), auth-gated exactly like its
existing admin operations. Once called, **the previous single key
immediately and permanently loses admin access** — every admin-gated check
compares against `config.admin` read fresh from storage, so the old key's
`require_auth()` stops matching from that point on. This is the on-chain
mechanism by which "single-key admin paths are removed" for an
already-deployed contract.

```text
1. Deploy multisig-admin (or reuse one already deployed for another registry).
2. multisig.initialize(signers, threshold)
3. registry.transfer_admin(current_admin, multisig_contract_address)
   # attestation-engine-v2 only, if governance should also move:
   registry.transfer_governance(current_admin_or_governance, multisig_contract_address)
4. Record the deployed multisig's address, signer set, and threshold in the
   relevant deployments/v1/<network>.json manifest (or a comparable
   operator-facing runbook) — this is the "documented" half of "admin
   operations require the documented signature threshold": get_config() is
   how a caller verifies it on-chain, but operators still need a
   human-readable record of who the signers are and why the threshold was
   chosen.
```

Steps 1–3 are exercised end-to-end (against the real contracts, not mocks)
by `state_root_publishable_through_a_real_multisig_after_admin_migration` in
`contracts/privacy-pool/src/test.rs`.

**This PR ships the mechanism, not a completed migration.** The four
registries' testnet deployments still have their original single-key admins
until an operator actually performs steps 1–3 above against them (which needs
the real deployer keys and is out of scope for a code change — see
`deployments/v1/testnet.json`). Track that migration as a follow-up
deployment task per registry; do not consider any of the four "migrated"
until its manifest entry records a `multisig-admin` address in the `admin`
slot.

`scripts/migrate-to-multisig-admin.ts` (#771) automates steps 1–3 above —
deploy, `initialize`, then `transfer_admin`/`transfer_governance` across all
four registries in one run — for an operator who supplies the real deployer
key and signer set. See
[`MULTISIG_MIGRATION_RUNBOOK.md`](MULTISIG_MIGRATION_RUNBOOK.md) for the full
checklist (signer selection, dry-run, verification, partial-failure
recovery) that script is one step of.

## Publishing a registry admin call

A signer proposing a call needs the target function's arguments pre-encoded
as `Vec<Val>`, exactly like any other cross-contract invocation in this
codebase (e.g. `attestation-engine-v2`'s calls into `schema-registry`) —
typically via a tuple's `.into_val(&env)`:

```rust
let args: Vec<Val> = (multisig_addr.clone(), root.clone(), dataset_hash.clone())
    .into_val(&env);
let proposal_id = multisig_client.propose_call(
    &signer,
    &privacy_pool_addr,
    &Symbol::new(&env, "update_state_root"),
    &args,
);
```

The first argument matches whatever the target function's own `admin`/`caller`
parameter position expects — it must be the multisig contract's own address,
since that is what the target's `require_auth()` check will be satisfied
against.

## Scripted approval via the SDK

Once a multisig is deployed (`config.contracts.multisigAdmin` set — not yet
the case on any network, see `deployments/v1/*.json`), operators can script
the propose/approve flow through `@opaquecash/stellar`'s `MultisigAdmin`
binding instead of `soroban contract invoke`:

```ts
import { OpaqueClient, keypairSigner, bytesToScVal } from "@opaquecash/stellar";

const opaque = new OpaqueClient({ network: "testnet", signer: keypairSigner(process.env.SECRET!) });
const multisig = opaque.contracts.multisigAdmin!;

// One signer proposes publishing a new state root on privacy-pool.
// `proposeCall` submits the tx and returns its hash, not the decoded
// proposal id — read the id off the contract's "Proposed" event (or
// `opaque.soroban.getTransaction(txHash)`'s return value) before approving.
const proposeTxHash = await multisig.proposeCall({
  target: PRIVACY_POOL_CONTRACT_ID,
  fnName: "update_state_root",
  args: [bytesToScVal(newRoot), bytesToScVal(datasetHash)],
  signer: keypairSigner(process.env.SIGNER_1_SECRET!),
});
const proposalId = await proposalIdFromProposedEvent(proposeTxHash);

// Each remaining signer approves; execution happens automatically once
// approvals reach the configured threshold.
for (const secret of [process.env.SIGNER_2_SECRET!, process.env.SIGNER_3_SECRET!]) {
  await multisig.approve({ proposalId, signer: keypairSigner(secret) });
}

const proposal = await multisig.getProposal(await opaque.signer!.publicKey(), proposalId);
console.log(proposal.executed ? "Executed" : `${proposal.approvals.length} approvals so far`);
```

## Scope

Covers the four registries with a genuine single-key protocol admin:
`attestation-engine-v2`, `privacy-pool`, `reputation-verifier`,
`relayer-registry`. `schema-registry` has no single protocol-wide admin to
migrate (each schema has its own issuer-controlled `authority`), and
`stealth-registry`/`stealth-announcer` are fully permissionless — neither
needed changes for this issue.
