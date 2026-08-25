<div align="center">

# Opaque

### Private money and verifiable trust on Stellar, enforced by zero-knowledge proofs, not by promises.

[![npm](https://img.shields.io/npm/v/@opaquecash/stellar?color=14b8a6&labelColor=0b1020&label=%40opaquecash%2Fstellar)](https://www.npmjs.com/package/@opaquecash/stellar)
[![License: MIT](https://img.shields.io/badge/license-MIT-111827?labelColor=0b1020)](LICENSE)
[![Stellar Soroban](https://img.shields.io/badge/Stellar-Soroban-14b8a6?labelColor=0b1020)](https://developers.stellar.org/docs/build/smart-contracts)
[![Live on testnet](https://img.shields.io/badge/Stellar%20testnet-live-22c55e?labelColor=0b1020)](https://stellar.opaque.cash)

[Live app](https://stellar.opaque.cash) · [Demo video](https://youtu.be/-465hu6sjO4) · [Docs](https://soroban.opaque.cash) · [SDK on npm](https://www.npmjs.com/package/@opaquecash/stellar) · [Contracts on-chain](#on-chain-contracts-stellar-testnet)

</div>

Every payment on a public ledger is also a permanent, searchable record of who paid whom: payroll, donations, suppliers, savings, memberships. Opaque adds a privacy layer to Stellar where the right to transact privately is enforced by **zero-knowledge proofs verified inside Soroban contracts**, not by a trusted operator you have to believe.

Receive without exposing your wallet. Pool and withdraw unlinkably. Prove a credential without revealing your identity. It is live on Stellar testnet today, and it ships as both a working wallet and an installable developer SDK.

> [!TIP]
> The fastest way to understand Opaque is to watch the [3-minute demo](https://youtu.be/-465hu6sjO4) or open the [live app](https://stellar.opaque.cash) with Freighter on Stellar testnet.

## The three things that matter

1. **It works.** Real Soroban contracts on Stellar testnet, a real browser wallet, real Groth16 proofs. Verify any flow on [stellar.expert](#on-chain-contracts-stellar-testnet).
2. **The ZK is load-bearing.** A zero-knowledge proof is the gate that releases funds and answers credential checks. Remove the proof and the action does not happen, because the contract reverts.
3. **It is honest.** Every trust assumption is written down in plain language below, not hidden.

## Where the zero knowledge does the work

This is the heart of the project. Two independent Groth16 circuits (BN254 / alt_bn128) are proven in the browser and **verified inside Soroban contracts on Stellar testnet**, using the Protocol 25/26 BN254 host functions that make on-chain proof verification practical. Without a valid proof, a user cannot withdraw privately or prove a trait. The proof itself is the access control.

**1. Private withdrawals (privacy pool).** The browser proves _"I own one unspent deposit inside the approved set, and this exact withdrawal is valid"_ without revealing which deposit. The pool contract verifies the proof on-chain, rejects reused nullifiers, and enforces a custody invariant so a published root can never release unbacked funds. The proof binds recipient, amount, fee, and relayer, so no one in the path can redirect the money.

**2. Private reputation.** A depth-20 Merkle circuit (Poseidon) proves _"I control a stealth identity that holds attestation X"_ and emits an action-scoped nullifier, without revealing the identity or linking it to the wallet that holds funds. The reputation verifier contract checks the proof on-chain and returns a yes or no.

| What is proven             | On-chain verifier (Stellar testnet)                                                                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unlinkable pool withdrawal | [Groth16 verifier `CBWH…IDFC`](https://stellar.expert/explorer/testnet/contract/CBWHOATL5TQLQNIOJ3EADOQ55SH7C3A5OO5BJNJZICBMXXH5NMMDIDFC), gated by the [privacy pool](https://stellar.expert/explorer/testnet/contract/CCXNSBVFTVCVUGBZG2RRT2OVVY5ERXGTNYE5DCALAEAROD2IEGJZ7J3J)        |
| Private credential / trait | [Groth16 verifier `CAWX…BS2T`](https://stellar.expert/explorer/testnet/contract/CAWXRGFZITZ7TJIZNDLOPJNVEMPAZDWFI22XI76FC67YF2MDRUXLBS2T), gated by the [reputation verifier](https://stellar.expert/explorer/testnet/contract/CAFVXL6A5N4FVQZ733GLUX27ETPLLINLE75ZABNLFYEKPIYZORFCBSVR) |

The proof being verified on-chain is the whole thesis: privacy enforced by math, checked by Stellar.

## Verify it on-chain

Every step below is a real transaction on the deployed [privacy pool `CCXN…7J3J`](https://stellar.expert/explorer/testnet/contract/CCXNSBVFTVCVUGBZG2RRT2OVVY5ERXGTNYE5DCALAEAROD2IEGJZ7J3J). Open any hash on stellar.expert, this is the whole rail, end to end, on Stellar testnet.

| #   | What happened                                                                                                                                            | Transaction                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | A sender announces a one-time **stealth address** (DKSAP, scheme 1) — the recipient's main wallet is never named                                         | [`6718…a6ed`](https://stellar.expert/explorer/testnet/tx/6718b44b50be25d6e9ca5445b6a668f6e40bcf01f16144818010f5ebecfda6ed) |
| 2   | XLM **deposited** into the privacy pool's commitment set                                                                                                 | [`569c…f902`](https://stellar.expert/explorer/testnet/tx/569c01962a7e4cc97748bd8810abc5a362c37e954f17d1322d64d8b1b708f902) |
| 3   | The **ASP publishes** the approved-set root that withdrawal proofs are checked against                                                                   | [`4104…80fd`](https://stellar.expert/explorer/testnet/tx/410424931b836802052d1e7a020668f5369906ba21f616f17117e3eac87880fd) |
| 4   | The pool **state-tree root** is published for proof verification                                                                                         | [`10af…55e9`](https://stellar.expert/explorer/testnet/tx/10af4d60e9608844e760e398bd44ae2931261137e9499629fdf23f76228455e9) |
| 5   | **Unlinkable withdrawal**: a Groth16 proof is verified on-chain and paid out, **signed by the staked relayer (`GC3A…P3OH`), not the recipient's wallet** | [`6cbf…9421`](https://stellar.expert/explorer/testnet/tx/6cbf55053d77f0d689568c890b5ca3f0512bc4dd57b777e45a293f9368c59421) |

Step 5 is the unlinkability claim made concrete: the withdrawal transaction is signed and fee-paid by the relayer's account, so the recipient never appears in the path. You can reproduce the same flow yourself in the [live app](https://stellar.opaque.cash).

## What Opaque does

Five protocol pieces compose into one private rail.

| Piece                | What it gives the user                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stealth payments** | A sender pays a fresh one-time Stellar account derived from the recipient's published meta-address. The recipient's main wallet is never named on-chain. |
| **Privacy pool**     | Deposit XLM into a commitment set, then withdraw later with a Groth16 proof that hides which deposit funded the withdrawal.                              |
| **Association set**  | An Association Set Provider publishes the approved set root used by withdrawal proofs, so operators can define which deposits are eligible.              |
| **Relayer market**   | A staked relayer submits the withdrawal for the user, so the final transaction is not sent from the user's wallet.                                       |
| **ZK reputation**    | Prove a credential or trait on Soroban without linking it to the wallet that received or holds funds.                                                    |

### The one flow that ties it together

A recipient discovers a stealth payment, sends it **straight into the privacy pool from the stealth account itself** (the connected wallet never signs and is never linked), then withdraws it unlinkably through a relayer with an on-chain-verified proof. Two privacy primitives become one continuous private payment rail, with zero knowledge as the gate at the end.

## Build on it: the SDK

Opaque is not only an app. The entire protocol is published as a typed, framework-free TypeScript package, so any Stellar developer can add private payments and on-chain ZK reputation in a few lines.

```sh
npm install @opaquecash/stellar
```

```ts
import { OpaqueClient, keypairSigner } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(secret),
});

// stealth payment
await opaque.payments.send({ to: recipientMetaAddress, amountXlm: "10" });

// privacy pool: deposit, prove, withdraw unlinkably
const { note } = await opaque.pool.deposit({ amountXlm: "5" });
const proof = await opaque.pool.proveWithdraw({ note, recipient });
await opaque.pool.withdraw({
  proof,
  recipient,
  noteCommitment: note.commitment,
});

// on-chain ZK reputation
await opaque.reputation.proveAndVerify({
  attestationId,
  stealthPrivKey,
  externalNullifier: 42n,
});
```

ESM and CommonJS, full type declarations, and tree-shakeable subpaths. Full guides and a generated API reference for every method live at **[soroban.opaque.cash](https://soroban.opaque.cash)**.

## What works today

Opaque is live on Stellar testnet for the MVP path.

| Surface          | Status                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Private payments | Register, send, scan, and sweep are wired across testnet contracts and the browser wallet.                          |
| Privacy pool     | Deposit, root publication, in-browser proof generation, withdrawal, and nullifier-replay rejection are implemented. |
| Relayer market   | A staked relayer registry plus a live gateway submit blind withdrawals on the user's behalf.                        |
| ZK reputation    | Groth16 reputation proofs verify through Soroban contracts.                                                         |
| Developer SDK    | Published to npm with docs and examples.                                                                            |

> [!WARNING]
> This is experimental software on Stellar testnet. Do not use real funds. Mainnet is blocked until the security register is signed off. Read [DISCLAIMER.md](DISCLAIMER.md) first.

## Honest trade-offs

Privacy systems live or die by their assumptions, so here are Opaque's, stated plainly.

> [!NOTE]
>
> - **The demo Association Set Provider approves all deposits.** It provides liveness and root publication for the MVP, not selective screening.
> - **Privacy-pool Merkle roots are published off-chain** by a trusted publisher, because on-chain Poseidon over a depth-20 tree exceeds Soroban's per-transaction CPU budget. An on-chain custody invariant prevents a bad root from releasing unbacked funds.
> - **The deposit is linked on-chain to the inbound stealth payment.** Unlinkability comes from the withdrawal, not the deposit, and its strength is bounded by the pool's anonymity set. Equal-size, chunked deposits widen that set.
> - **The relayer's job-funding transaction is public** and signed by the connected wallet, but the relayer cannot change the recipient, amount, or proof.

What is **always enforced on-chain**: proof verification, nullifier-replay protection, and the custody invariant.

See [`docs/PRIVACY_GUARANTEES.md`](docs/PRIVACY_GUARANTEES.md) for the precise,
per-property adversary model behind these trade-offs and their known weakenings.

## Use cases

| Use case                         | Why Opaque helps                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| Private creator and fan payments | Fans pay without linking the recipient's main wallet across every payment.                        |
| Payroll and contractor payouts   | Workers receive XLM without making their salary history trivial to inspect.                       |
| DAO contributor rewards          | Members prove eligibility while separating payouts from public identity.                          |
| Consumer wallet privacy          | Wallets offer one-time receive accounts and pool withdrawals with no custodial infrastructure.    |
| Credential-gated access          | Apps verify reputation or attestations without learning the user's wallet graph.                  |
| Compliance-aware privacy         | Association sets let operators define allowed deposits while preserving withdrawal unlinkability. |

## Try it

> [!TIP]
> No build required: open [stellar.opaque.cash](https://stellar.opaque.cash), connect Freighter on Stellar testnet, and initialize your Opaque keys.

To run the wallet locally:

```bash
git clone https://github.com/collinsadi/opaque-stellar.git
cd opaque-stellar
npm ci
npm run build:scanner
npm run fetch:circuits

cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`, connect Freighter on Stellar testnet, and initialize your keys. The frontend reads contract IDs from [deployments/v1/testnet.json](deployments/v1/testnet.json), so you do not need to redeploy anything.

### Protocol services

The pool and reputation verifiers need published roots, and relayed withdrawals need a gateway. A testnet ASP (approve-all) and a relayer are already running for the demo; operators should run their own before relying on the system outside demo use.

| Service              | Command                                         | Guide                            |
| -------------------- | ----------------------------------------------- | -------------------------------- |
| ASP indexer          | `cd asp && npm run indexer`                     | [Guide](docs/running-asp.md)     |
| Reputation publisher | `cd publisher && npm run serve`                 | [Readme](publisher/)             |
| Relayer hub + node   | `cd relayer && npm run hub` / `npm run relayer` | [Guide](docs/running-relayer.md) |

Service level objectives for these three (latency, availability, and how they're
measured) are defined in [docs/testnet-slos.md](docs/testnet-slos.md); `npm run
slo:report` compares current operations against them.

## Architecture

| Path                                               | Purpose                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [frontend/](frontend/)                             | React wallet: private receive, scan, sweep, pool deposit/withdraw, and reputation proofs.                  |
| [sdk/](sdk/)                                       | `@opaquecash/stellar`, the typed protocol SDK published to npm, with docs and examples.                    |
| [contracts/](contracts/)                           | Soroban contracts: registries, announcer, attestations, Groth16 verifiers, privacy pool, relayer registry. |
| [scanner/](scanner/)                               | Rust DKSAP scanner compiled to WASM for browser-side receive detection.                                    |
| [circuits/](circuits/)                             | Circom Groth16 circuits, fixtures, and regression tests.                                                   |
| [asp/](asp/)                                       | Association Set Provider and pool state-root publisher.                                                    |
| [publisher/](publisher/)                           | Reputation leaf collector and Merkle-root publisher.                                                       |
| [relayer/](relayer/)                               | Relayer gateway, hub, node engine, and market tests.                                                       |
| [deployments/](deployments/)                       | Versioned on-chain address book and manifests.                                                             |
| [docs/](docs/)                                     | Operator guides, protocol internals, and security notes.                                                   |
| [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) | Contributor guide: required checks, dependency policy, and PR workflow.                                    |
| [docs/MULTISIG_ADMIN.md](docs/MULTISIG_ADMIN.md)   | On-chain N-of-M threshold admin contract and the registry migration path off single-key admins.            |

## On-chain contracts (Stellar testnet)

The canonical address book is [deployments/v1/testnet.json](deployments/v1/testnet.json). Key contracts, linked for inspection on stellar.expert:

| Contract                    | Explorer                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Privacy pool                | [`CCXN…7J3J`](https://stellar.expert/explorer/testnet/contract/CCXNSBVFTVCVUGBZG2RRT2OVVY5ERXGTNYE5DCALAEAROD2IEGJZ7J3J) |
| Pool Groth16 verifier       | [`CBWH…IDFC`](https://stellar.expert/explorer/testnet/contract/CBWHOATL5TQLQNIOJ3EADOQ55SH7C3A5OO5BJNJZICBMXXH5NMMDIDFC) |
| Reputation verifier         | [`CAFV…BSVR`](https://stellar.expert/explorer/testnet/contract/CAFVXL6A5N4FVQZ733GLUX27ETPLLINLE75ZABNLFYEKPIYZORFCBSVR) |
| Reputation Groth16 verifier | [`CAWX…BS2T`](https://stellar.expert/explorer/testnet/contract/CAWXRGFZITZ7TJIZNDLOPJNVEMPAZDWFI22XI76FC67YF2MDRUXLBS2T) |
| Attestation engine (V2)     | [`CB6K…SDPX`](https://stellar.expert/explorer/testnet/contract/CB6KOWOQBFQDX5NNGUJGECHXUF3LHUE77FYD2C6JSWMHYWGCJOUTSDPX) |
| Schema registry             | [`CA5X…7QCP`](https://stellar.expert/explorer/testnet/contract/CA5XA2T2DAOZH7QG5RG2372KGDHMCEVQJMBGT7AJMNHRI6C4ZIM37QCP) |
| Stealth registry            | [`CAIX…5VXW`](https://stellar.expert/explorer/testnet/contract/CAIXWMGYZR3YAQ3CPCXOU42WG62E3ARUSG4GDHHDMNRXUD44YSGE5VXW) |
| Stealth announcer           | [`CB2Y…QGCS`](https://stellar.expert/explorer/testnet/contract/CB2Y3GJMPY5BUSZLXG3DSIMERCNCTUM63IIEQ2GUNYEJ3DBKPFIZQGCS) |
| Relayer registry            | [`CBTH…Q3ND`](https://stellar.expert/explorer/testnet/contract/CBTHQFGGDJMEML267U5EGQPYFLARO6TO4QYSK6CVKXWY2TR4DJ7GQ3ND) |

## Security

> [!CAUTION]
> Report vulnerabilities through [SECURITY.md](SECURITY.md), not public issues. The browser key-storage threat model is in [docs/GHOST_THREAT_MODEL.md](docs/GHOST_THREAT_MODEL.md). Mainnet use is blocked until the security register is signed off.

## License

Opaque is licensed under the [MIT License](LICENSE). It bundles some
GPL-3.0-licensed circuit tooling (circom/snarkjs/circomlib) — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for what's bundled and why.

<div align="center">

Every transaction deserves the right to be private.

</div>
