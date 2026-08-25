# Architecture and Protocol Flows

This document describes the on-chain and off-chain components of Opaque, their trust boundaries, and the end-to-end flows for private payments, pool deposits/withdrawals, and reputation proofs.

## Component overview

```mermaid
graph TB
    subgraph "Off-chain (user device)"
        Wallet["Frontend wallet"]
        Scanner["DKSAP scanner (WASM)"]
        Prover["Groth16 prover (circom/snarkjs)"]
    end

    subgraph "Off-chain (operator)"
        ASP["Association Set Provider"]
        Publisher["Reputation publisher"]
        Relayer["Relayer hub + node"]
    end

    subgraph "On-chain (Stellar Soroban)"
        StealthReg["Stealth registry"]
        StealthAnn["Stealth announcer"]
        Pool["Privacy pool"]
        PoolVerifier["Pool Groth16 verifier"]
        RepVerifier["Reputation verifier"]
        RepVerifierGW["Reputation Groth16 verifier"]
        SchemaReg["Schema registry"]
        AttestEngine["Attestation engine"]
        RelayerReg["Relayer registry"]
    end

    Wallet --> Scanner
    Wallet --> Prover
    Wallet --> StealthReg
    Wallet --> StealthAnn
    Wallet --> Pool
    Wallet --> RepVerifier
    Wallet --> Relayer

    Scanner --> StealthAnn
    Prover --> PoolVerifier
    Prover --> RepVerifierGW

    ASP --> Pool
    Publisher --> RepVerifier

    Relayer --> Pool
    Relayer --> RelayerReg

    PoolVerifier --> Pool
    RepVerifierGW --> RepVerifier
```

## Trust boundaries

The diagram below highlights which components are trusted, which are untrusted, and where ZK enforcement replaces trust.

```mermaid
graph LR
    subgraph "Trusted (operator-run)"
        ASP2["ASP root publisher"]
        Relayer2["Relayer node"]
        Publisher2["Reputation publisher"]
    end

    subgraph "Untrusted (user device)"
        Wallet2["Frontend wallet"]
        Prover2["Groth16 prover"]
    end

    subgraph "On-chain (Soroban verified)"
        Pool2["Privacy pool contract"]
        Verifier2["Groth16 verifier contracts"]
        Registries2["Registry contracts"]
    end

    Wallet2 -- "deposit event" --> Pool2
    Wallet2 -- "proof" --> Verifier2
    ASP2 -- "state + asp root" --> Pool2
    Relayer2 -- "submit tx" --> Pool2
    Publisher2 -- "reputation root" --> Registries2

    style ASP2 fill:#fff3cd
    style Relayer2 fill:#fff3cd
    style Publisher2 fill:#fff3cd
    style Pool2 fill:#d4edda
    style Verifier2 fill:#d4edda
    style Registries2 fill:#d4edda
```

**Yellow** = operator-run, trusted for liveness but not for funds. **Green** = on-chain, enforced by Soroban contracts and ZK proofs.

Key trust boundaries:
- **User → On-chain:** The user's wallet generates proofs locally; the on-chain verifier enforces correctness. No operator is in the proof path.
- **ASP → Pool:** The ASP publishes roots but cannot mint funds. A bad root is detected by clients rebuilding from chain history.
- **Relayer → Pool:** The relayer submits transactions but cannot change the recipient, amount, or fee — these are bound in the ZK proof's public context.

## Flow: Stealth payment (send / receive / scan)

```mermaid
sequenceDiagram
    participant Sender
    participant Announcer as Stealth Announcer
    participant Scanner as DKSAP Scanner
    participant Recipient

    Sender->>Sender: Derive ephemeral shared secret from recipient's meta-address
    Sender->>Sender: Create one-time Stellar account
    Sender->>Announcer: Announce payment (view tag, encrypted payload)
    Sender->>Announcer: Send XLM to one-time account
    Note over Scanner: Local browser scan — no hosted service
    Scanner->>Announcer: Read announcements
    Scanner->>Scanner: Filter by view tag, reconstruct one-time key
    Scanner->>Recipient: Sweep one-time account to pool or wallet
```

## Flow: Privacy pool deposit

```mermaid
sequenceDiagram
    participant User
    participant Pool as Privacy Pool Contract
    participant ASP as ASP Indexer

    User->>User: Generate private note (commitment)
    User->>Pool: deposit(value, commitment, expected_index)
    Pool->>Pool: Verify index matches dep_count
    Pool->>Pool: Check tree capacity
    Pool->>Pool: Transfer XLM via SAC
    Pool->>Pool: Record commitment, bump counters
    Pool-->>ASP: Deposit event emitted
    ASP->>ASP: Rebuild state tree, publish state root
    ASP->>ASP: Rebuild association set, publish ASP root
```

## Flow: Privacy pool withdrawal

```mermaid
sequenceDiagram
    participant User
    participant Prover as Groth16 Prover
    participant Relayer
    participant Pool as Privacy Pool Contract
    participant Verifier as Groth16 Verifier

    User->>User: Rebuild Merkle paths from published roots
    User->>Prover: Generate withdrawal proof (private inputs: note, path)
    Prover-->>User: Proof (A, B, C) + public inputs
    User->>Relayer: Submit proof, recipient, fee
    Relayer->>Pool: withdraw(proof, public_inputs, recipient, fee)
    Pool->>Verifier: verify_proof_v3(proof, public_inputs)
    Verifier-->>Pool: true / false
    Pool->>Pool: Check nullifier not spent
    Pool->>Pool: Enforce custody invariant (tot_wd + amount <= tot_dep)
    Pool->>Pool: Record nullifier, insert new commitment
    Pool->>Pool: Transfer XLM to recipient, fee to relayer
```

## Flow: Reputation proof

```mermaid
sequenceDiagram
    participant User
    participant Prover as Groth16 Prover
    participant Verifier as Reputation Verifier
    participant App

    User->>User: Hold attestation in stealth identity
    User->>Prover: Generate reputation proof (private: stealth key, attestation path)
    Prover-->>User: Proof (A, B, C) + nullifier
    User->>App: Submit proof for credential check
    App->>Verifier: verify(proof, nullifier, attestation_id)
    Verifier-->>App: true / false (no identity revealed)
```

## On-chain contract map

| Contract | Storage type | Purpose |
| --- | --- | --- |
| `privacy-pool` | instance + persistent | Holds deposits, verifies withdrawal proofs, enforces custody and nullifier replay protection |
| `groth16-verifier` (pool) | — | Verifies the v3 withdrawal Groth16 proof (BN254) |
| `reputation-verifier` | instance + persistent | Verifies reputation roots, nullifiers, and attestation proofs |
| `groth16-verifier` (rep) | — | Verifies the reputation Groth16 proof |
| `stealth-registry` | persistent | Stores recipient meta-addresses |
| `stealth-announcer` | persistent | Records payment announcements and view tags |
| `schema-registry` | persistent | Stores attestation schemas |
| `attestation-engine` | persistent | Issues and verifies attestations |
| `relayer-registry` | persistent | Tracks relayer operators, stake, jobs, and settlement |

## Off-chain services

| Service | Path | Purpose |
| --- | --- | --- |
| ASP indexer | `asp/` | Rebuilds state and association-set trees from chain events, publishes roots |
| Reputation publisher | `publisher/` | Collects attestation leaves, builds and publishes Merkle roots |
| Relayer hub + node | `relayer/` | HTTP gateway, encrypted payload handling, blind withdrawal submission |
| DKSAP scanner | `scanner/` | Rust WASM module for browser-side stealth payment detection |
| Frontend wallet | `frontend/` | React wallet with Freighter integration, proof generation, pool operations |
