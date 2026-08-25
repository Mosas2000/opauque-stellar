# Security Policy

## Reporting a vulnerability

**Please do not** open public GitHub issues for security vulnerabilities.

Report them through a **[private GitHub security advisory](https://github.com/collinsadi/opaque-stellar/security/advisories/new)** on this repository.

A useful report includes:

- The affected component and commit or deployment (contract address, frontend build, or scanner version).
- Steps to reproduce, a proof of concept, or the specific code path involved.
- Your assessment of impact (loss of funds, privacy de-anonymization, denial of service, etc.).

We aim to acknowledge security reports within **5 business days** and will keep you updated as we investigate. Please give us a reasonable window to ship a fix before any public disclosure; we are happy to coordinate timing and credit you in the advisory.

We will not pursue legal action against good-faith research that respects user privacy, avoids data destruction, and stays within testnet or your own accounts.

## Reporting abuse or sanctions concerns

Open a **[GitHub issue](https://github.com/collinsadi/opaque-stellar/issues)** with a clear title (for example, `Abuse report:` or `Sanctions concern:`) and enough detail for us to investigate. Do not include sensitive personal data in public issues when a private advisory is more appropriate.

The reference wallet also surfaces an in-app summary at `/abuse-policy` (see `frontend/src/components/AbusePolicyPage.tsx`).

## Supported versions

Security fixes are applied to the latest code on the `main` branch. When we tag a release, notes appear on the [GitHub Releases](https://github.com/collinsadi/opaque-stellar/releases) page.

## Dependency security

Advisory response windows and the routine update-batching schedule are
defined in [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md#12-dependency-update-policy).
The full supply-chain policy — hash-pinning, reproducible builds, and the
separate PR-blocking monitoring of the Rust WASM build chain (`scanner/` /
wasm-bindgen) — is in [docs/supply-chain-policy.md](docs/supply-chain-policy.md).

### Critical dependencies

The following packages handle cryptographic operations or proof generation and
receive extra review on every version bump. They are pinned to exact versions
in `frontend/package.json` — dependabot opens individual PRs for each.

| Package | Purpose | Review cadence |
|---------|---------|----------------|
| `@stellar/stellar-sdk` | Stellar RPC + transaction building | Every bump reviewed before merge |
| `@noble/curves` | Elliptic curve crypto (secp256k1, ed25519) | Every bump reviewed before merge |
| `@noble/hashes` | Cryptographic hashing (SHA-256, keccak) | Every bump reviewed before merge |
| `snarkjs` | ZK-SNARK proof generation/verification | Every bump reviewed before merge |
| `circomlibjs` | Circom circuit crypto primitives | Every bump reviewed before merge |
| `tweetnacl` | NaCl box/sign (ed25519) | Every bump reviewed before merge |
| `idb` | IndexedDB wrapper (stores encrypted keys) | Every bump reviewed before merge |

### npm provenance

When publishing `@opaquecash/stellar` to npm, builds use `--provenance` to
attach a signed build attestation. This ties the published package to the
specific CI run and commit that produced it, preventing supply-chain attacks
via compromised build environments.

CI runs `npm audit` on every PR against both the root and `frontend/` workspaces
(`ci.yml`, supply-chain job) to catch known vulnerabilities in production
dependencies.

## Upgrade governance

Contract upgrade authority, process, and user-visible guarantees are documented in [docs/UPGRADE_GOVERNANCE.md](docs/UPGRADE_GOVERNANCE.md).

## Admin key compromise response

If an admin, governance, multisig signer, or deployer key is suspected or
confirmed compromised, follow the per-contract-role playbooks (pause / freeze,
admin transfer, contract upgrade) and the quarterly drill checklist in
[docs/ADMIN_KEY_COMPROMISE_PLAYBOOKS.md](docs/ADMIN_KEY_COMPROMISE_PLAYBOOKS.md).
Those playbooks assume the admin-authority model documented in
[docs/MULTISIG_ADMIN.md](docs/MULTISIG_ADMIN.md).

## Scope

- Soroban contracts in `contracts/`
- Reference frontend in `frontend/`
- Scanner WASM in `scanner/`
- Deployment manifests and CI verification scripts

Out of scope: third-party wallets, Stellar network consensus, and self-hosted forks unless they use official deployment credentials we operate.
