#![no_std]
// Retain the classic events().publish API so the off-chain ASP/state-root indexers
// and the frontend keep a stable on-chain event ABI.
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

//! # privacy-pool
//!
//! An association-set privacy pool for native XLM (Opaque Cash, Phase 5). Mirrors the
//! `opaquecash/spec` privacy-pool: commitment-based deposits, zero-knowledge partial
//! withdrawals proven against the pool **state tree** and an **ASP association tree**.
//!
//! ## Why the state tree is maintained off-chain
//!
//! The spec's preferred design inserts each commitment into an on-chain Poseidon Merkle
//! tree. We measured that (see `contracts/opaque-poseidon` + `contracts/poseidon-bench`):
//! a single Poseidon hash costs ~40M CPU instructions, so even one insertion blows
//! Stellar's 100M-per-tx budget. On-chain insertion is therefore infeasible at any depth.
//!
//! This contract implements the plan's documented fallback: the **state root is published
//! off-chain** (by an indexer reading `Deposit` events), exactly like the ASP root, and an
//! on-chain **custody invariant** caps aggregate withdrawals at aggregate deposits so a bad
//! root can never mint unbacked funds. The trusted-publisher trade-off is documented; the
//! SAC balance is the physical backstop. The `context` binding uses the cheap host
//! keccak256, not Poseidon — so this contract does no Poseidon at all.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Bytes, BytesN, Env,
    IntoVal, Symbol, Vec, U256,
};

mod capacity;
mod withdrawal;

/// Default root validity window (~1 day at 5 s/ledger). Overridable via set_root_expiry.
const DEFAULT_ROOT_EXPIRY_LEDGERS: u32 = 17_280;
const MAX_ROOT_HISTORY: u32 = 100;
const EVENT_VERSION: u32 = 1;

/// Public delay (~1 day at 5 s/ledger) between an admin *requesting* a
/// withdrawal pause and it actually taking effect (#576). Deposits pause
/// immediately on admin action — there's no fund-safety reason to delay
/// stopping new deposits — but an instant withdrawal pause would itself be a
/// rug vector (a compromised or malicious admin could freeze user funds with
/// no warning). The timelock gives depositors a public window to withdraw
/// before the pause activates.
const WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS: u32 = 17_280;

/// Sentinel meaning "no withdrawal pause request pending" (ledger 0 never
/// occurs in practice — Soroban ledger sequence numbers start well above it).
const NO_PAUSE_REQUEST: u32 = 0;

/// TTL management for persistent storage entries.
///
/// Persistent entries default to Soroban's maximum TTL (~120 days / 2,073,600 ledgers).
/// To prevent archival expiry from stranding user funds or breaking root lookups, every
/// write to persistent storage also extends the entry's TTL to this value.
///
/// Ownership: the contract bumps its own persistent entries on every mutating call.
/// An external cron script (`scripts/check-ttl-expiry.ts`) monitors approaching-expiry
/// entries and alerts operators.
const PERSISTENT_TTL_LEDGERS: u32 = 2_073_600;

/// BN254 scalar field order r, big-endian — `context` is reduced modulo this so it is a
/// valid circuit public input.
const SCALAR_FIELD: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[contract]
pub struct PrivacyPool;

#[contracttype]
#[derive(Clone)]
pub struct PoolConfig {
    pub admin: Address,
    pub groth16_verifier: Address,
    pub native_sac: Address,
    pub scope: u64,
    pub root_expiry_ledgers: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct RootEntry {
    pub ledger: u32,
    pub dataset_hash: BytesN<32>,
}

/// Mirror of groth16-verifier's `VerifyPublicInputsV3`. Field names/types/order must match
/// exactly so the cross-contract call serializes to the expected ScMap, and the order must
/// match circuits/v3/privacy_pool_withdraw.circom's public-signal vector.
#[contracttype]
#[derive(Clone)]
pub struct VerifyPublicInputsV3 {
    pub withdrawn_value: BytesN<32>,
    pub state_root: BytesN<32>,
    pub asp_root: BytesN<32>,
    pub nullifier_hash: BytesN<32>,
    pub new_commitment: BytesN<32>,
    pub context: BytesN<32>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PoolError {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    InvalidProof = 3,
    NullifierUsed = 4,
    UnknownStateRoot = 5,
    UnknownAspRoot = 6,
    RootExpired = 7,
    BadAmount = 8,
    IndexMismatch = 9,
    CustodyViolation = 10,
    DepositsPaused = 11,
    WithdrawalsPaused = 12,
    NoPauseRequestPending = 13,
    TreeAtCapacity = 14,
    WithdrawalBelowMinimum = 15,
}

// Which root namespace an entry belongs to.
const STATE: bool = true;
const ASP: bool = false;

fn cfg(env: &Env) -> PoolConfig {
    env.storage()
        .instance()
        .get(&Symbol::new(env, "config"))
        .expect("config")
}

fn root_entry_key(env: &Env, kind: bool, root: &BytesN<32>) -> (Symbol, BytesN<32>) {
    let tag = if kind == STATE {
        "state_root"
    } else {
        "asp_root"
    };
    (Symbol::new(env, tag), root.clone())
}

fn history_key(env: &Env, kind: bool) -> Symbol {
    Symbol::new(
        env,
        if kind == STATE {
            "state_hist"
        } else {
            "asp_hist"
        },
    )
}

fn nullifier_key(env: &Env, n: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (Symbol::new(env, "nullifier"), n.clone())
}

fn commitment_key(env: &Env, c: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (Symbol::new(env, "commit"), c.clone())
}

fn deposits_paused_key(env: &Env) -> Symbol {
    Symbol::new(env, "dep_paused")
}

fn wd_pause_request_key(env: &Env) -> Symbol {
    Symbol::new(env, "wd_pause_req")
}

fn deposits_paused_flag(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&deposits_paused_key(env))
        .unwrap_or(false)
}

/// Ledger at which a pending withdrawal-pause request was made, or
/// `NO_PAUSE_REQUEST` if none is pending / it was cancelled.
fn wd_pause_requested_at(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&wd_pause_request_key(env))
        .unwrap_or(NO_PAUSE_REQUEST)
}

/// Withdrawals are paused once `WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS` have
/// elapsed since a pause was requested — computed on every call rather than
/// latched by a separate "finalize" transaction, so the pause activates
/// exactly at the deadline with no extra step required.
fn withdrawals_pause_active(env: &Env) -> bool {
    let requested_at = wd_pause_requested_at(env);
    if requested_at == NO_PAUSE_REQUEST {
        return false;
    }
    let now = env.ledger().sequence();
    now.saturating_sub(requested_at) >= WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS
}

/// Extend the TTL of a persistent storage entry to prevent archival expiry.
/// Called on every write to persistent storage to keep long-lived entries
/// (nullifiers, commitments, roots) from being pruned by Soroban's state
/// archival mechanism.
fn bump_root_ttl(env: &Env, kind: bool, root: &BytesN<32>) {
    let key = root_entry_key(env, kind, root);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_LEDGERS, PERSISTENT_TTL_LEDGERS);
}

fn bump_nullifier_ttl(env: &Env, n: &BytesN<32>) {
    let key = nullifier_key(env, n);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_LEDGERS, PERSISTENT_TTL_LEDGERS);
}

fn bump_commitment_ttl(env: &Env, c: &BytesN<32>) {
    let key = commitment_key(env, c);
    env.storage()
        .persistent()
        .extend_ttl(&key, PERSISTENT_TTL_LEDGERS, PERSISTENT_TTL_LEDGERS);
}

#[contractimpl]
impl PrivacyPool {
    pub fn initialize(
        env: Env,
        admin: Address,
        groth16_verifier: Address,
        native_sac: Address,
        scope: u64,
    ) -> Result<(), PoolError> {
        admin.require_auth();
        if env.storage().instance().has(&Symbol::new(&env, "config")) {
            return Err(PoolError::AlreadyInitialized);
        }
        env.storage().instance().set(
            &Symbol::new(&env, "config"),
            &PoolConfig {
                admin: admin.clone(),
                groth16_verifier,
                native_sac,
                scope,
                root_expiry_ledgers: DEFAULT_ROOT_EXPIRY_LEDGERS,
            },
        );
        env.storage()
            .instance()
            .set(&history_key(&env, STATE), &Vec::<BytesN<32>>::new(&env));
        env.storage()
            .instance()
            .set(&history_key(&env, ASP), &Vec::<BytesN<32>>::new(&env));
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "dep_count"), &0u64);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "tot_dep"), &0i128);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "tot_wd"), &0i128);
        capacity::initialize_capacity_tracking(&env);
        // Start with no minimum (0) for backwards compatibility; admin raises
        // the bar via set_withdrawal_minimum after deployment.
        withdrawal::initialize_withdrawal_config(&env, admin.clone(), 0);
        Ok(())
    }

    /// Read-only config accessor (deploy tooling reads this back to confirm wiring).
    pub fn get_config(env: Env) -> PoolConfig {
        cfg(&env)
    }

    /// Deposit `value` XLM under a client-computed `commitment`.
    ///
    /// `commitment = Poseidon(value, label, precommitment)` with `label = Poseidon(scope,
    /// expected_index)` is computed off-chain; the contract pulls the funds via the SAC,
    /// records the commitment + index, and emits `Deposit` for the indexer/ASP. `expected_index`
    /// must equal the current deposit count (binds the label to the right leaf index without
    /// hashing on-chain); a racing depositor simply retries with the new index.
    pub fn deposit(
        env: Env,
        depositor: Address,
        value: i128,
        commitment: BytesN<32>,
        expected_index: u64,
    ) -> Result<u64, PoolError> {
        depositor.require_auth();
        if deposits_paused_flag(&env) {
            return Err(PoolError::DepositsPaused);
        }
        if value <= 0 {
            return Err(PoolError::BadAmount);
        }
        let config = cfg(&env);
        let index: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "dep_count"))
            .unwrap_or(0);
        if index != expected_index {
            return Err(PoolError::IndexMismatch);
        }
        if capacity::is_tree_at_capacity(&env) {
            return Err(PoolError::TreeAtCapacity);
        }

        // Pull funds into the pool's own SAC balance.
        let pool = env.current_contract_address();
        token::TokenClient::new(&env, &config.native_sac).transfer(&depositor, &pool, &value);

        // Record the commitment as legitimately deposited and bump counters.
        let ckey = commitment_key(&env, &commitment);
        env.storage().persistent().set(&ckey, &index);
        bump_commitment_ttl(&env, &commitment);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "dep_count"), &(index + 1));
        capacity::increment_commitment_count(&env);
        let total: i128 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "tot_dep"))
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "tot_dep"), &(total + value));

        env.events().publish(
            (Symbol::new(&env, "Deposit"), EVENT_VERSION),
            (commitment.clone(), index, value, config.scope),
        );
        Ok(index)
    }

    /// Publish the off-chain-built commitment **state** tree root (admin only).
    pub fn update_state_root(
        env: Env,
        admin: Address,
        root: BytesN<32>,
        dataset_hash: BytesN<32>,
    ) -> Result<(), PoolError> {
        Self::publish_root(env, admin, root, dataset_hash, STATE)
    }

    /// Publish the ASP **association** tree root (admin only).
    pub fn update_asp_root(
        env: Env,
        admin: Address,
        root: BytesN<32>,
        dataset_hash: BytesN<32>,
    ) -> Result<(), PoolError> {
        Self::publish_root(env, admin, root, dataset_hash, ASP)
    }

    fn publish_root(
        env: Env,
        admin: Address,
        root: BytesN<32>,
        dataset_hash: BytesN<32>,
        kind: bool,
    ) -> Result<(), PoolError> {
        admin.require_auth();
        let config = cfg(&env);
        if config.admin != admin {
            return Err(PoolError::Unauthorized);
        }
        let ledger = env.ledger().sequence();
        let rkey = root_entry_key(&env, kind, &root);
        env.storage().persistent().set(
            &rkey,
            &RootEntry {
                ledger,
                dataset_hash: dataset_hash.clone(),
            },
        );
        bump_root_ttl(&env, kind, &root);
        let mut hist: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&history_key(&env, kind))
            .unwrap_or(Vec::new(&env));
        if hist.len() >= MAX_ROOT_HISTORY {
            hist.remove(0);
        }
        hist.push_back(root.clone());
        env.storage()
            .instance()
            .set(&history_key(&env, kind), &hist);

        let topic = if kind == STATE {
            "StateRootPublished"
        } else {
            "AspRootPublished"
        };
        env.events().publish(
            (Symbol::new(&env, topic), EVENT_VERSION),
            (root, ledger, dataset_hash),
        );
        Ok(())
    }

    pub fn set_root_expiry(env: Env, admin: Address, expiry_ledgers: u32) -> Result<(), PoolError> {
        admin.require_auth();
        let mut config = cfg(&env);
        if config.admin != admin {
            return Err(PoolError::Unauthorized);
        }
        config.root_expiry_ledgers = expiry_ledgers;
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "config"), &config);
        Ok(())
    }

    /// Moves admin authority to `new_admin` (Issue #589) — the migration path
    /// from a single-key admin to a deployed `multisig-admin` contract's
    /// address, with no redeployment. Once this call succeeds, the current
    /// `admin` can no longer authorize any admin-gated operation: every check
    /// in this contract compares against `config.admin` fresh from storage,
    /// so the old key's `require_auth()` immediately stops matching.
    pub fn transfer_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), PoolError> {
        admin.require_auth();
        let mut config = cfg(&env);
        if config.admin != admin {
            return Err(PoolError::Unauthorized);
        }
        config.admin = new_admin;
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "config"), &config);
        Ok(())
    }

    // ── Circuit breaker: timelocked pause (#576) ────────────────────────────

    /// Halts new deposits immediately (same ledger as this call). There is no
    /// fund-safety reason to delay this — unlike withdrawals, pausing deposits
    /// cannot itself be used to trap user funds.
    pub fn pause_deposits(env: Env, admin: Address) -> Result<(), PoolError> {
        admin.require_auth();
        let config = cfg(&env);
        if config.admin != admin {
            return Err(PoolError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&deposits_paused_key(&env), &true);
        env.events().publish(
            (Symbol::new(&env, "DepositsPaused"), EVENT_VERSION),
            (env.ledger().sequence(),),
        );
        Ok(())
    }

    /// Resumes deposits.
    pub fn unpause_deposits(env: Env, admin: Address) -> Result<(), PoolError> {
        admin.require_auth();
        let config = cfg(&env);
        if config.admin != admin {
            return Err(PoolError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&deposits_paused_key(&env), &false);
        env.events().publish(
            (Symbol::new(&env, "DepositsUnpaused"), EVENT_VERSION),
            (env.ledger().sequence(),),
        );
        Ok(())
    }

    /// Starts the public timelock for a withdrawal pause. Withdrawals keep
    /// working until `WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS` have elapsed from
    /// this call — there is no separate "finalize" step; `withdraw()` itself
    /// checks elapsed time on every call. Re-requesting while a request is
    /// already pending is a no-op (the original timestamp is preserved, so an
    /// admin can't reset the clock by calling this repeatedly).
    pub fn request_pause_withdrawals(env: Env, admin: Address) -> Result<(), PoolError> {
        admin.require_auth();
        let config = cfg(&env);
        if config.admin != admin {
            return Err(PoolError::Unauthorized);
        }
        if wd_pause_requested_at(&env) != NO_PAUSE_REQUEST {
            return Ok(());
        }
        let now = env.ledger().sequence();
        env.storage()
            .instance()
            .set(&wd_pause_request_key(&env), &now);
        env.events().publish(
            (Symbol::new(&env, "WithdrawalPauseRequested"), EVENT_VERSION),
            (now, now + WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS),
        );
        Ok(())
    }

    /// Cancels a pending withdrawal-pause request before it activates, or
    /// lifts an already-active pause. Either way, withdrawals work again
    /// immediately after this call.
    pub fn unpause_withdrawals(env: Env, admin: Address) -> Result<(), PoolError> {
        admin.require_auth();
        let config = cfg(&env);
        if config.admin != admin {
            return Err(PoolError::Unauthorized);
        }
        if wd_pause_requested_at(&env) == NO_PAUSE_REQUEST {
            return Err(PoolError::NoPauseRequestPending);
        }
        env.storage()
            .instance()
            .set(&wd_pause_request_key(&env), &NO_PAUSE_REQUEST);
        env.events().publish(
            (Symbol::new(&env, "WithdrawalsUnpaused"), EVENT_VERSION),
            (env.ledger().sequence(),),
        );
        Ok(())
    }

    /// Whether new deposits are currently accepted.
    pub fn is_deposits_paused(env: Env) -> bool {
        deposits_paused_flag(&env)
    }

    /// Whether withdrawals are currently paused (timelock elapsed).
    pub fn is_withdrawals_paused(env: Env) -> bool {
        withdrawals_pause_active(&env)
    }

    /// `(requested_at, activates_at)` for a pending/active withdrawal pause
    /// request, or `(0, 0)` if none is pending — lets the frontend show a
    /// countdown to when withdrawals will actually stop.
    pub fn get_withdrawal_pause_request(env: Env) -> (u32, u32) {
        let requested_at = wd_pause_requested_at(&env);
        if requested_at == NO_PAUSE_REQUEST {
            (0, 0)
        } else {
            (
                requested_at,
                requested_at + WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS,
            )
        }
    }

    /// Withdraw `withdrawn_value` XLM from the pool to `recipient` (minus `fee` to `relayer`),
    /// proving in zero knowledge that an unspent deposit (clean per the ASP) backs it.
    pub fn withdraw(
        env: Env,
        proof_a: BytesN<64>,
        proof_b: BytesN<128>,
        proof_c: BytesN<64>,
        withdrawn_value: i128,
        state_root: BytesN<32>,
        asp_root: BytesN<32>,
        nullifier_hash: BytesN<32>,
        new_commitment: BytesN<32>,
        recipient: Address,
        fee: i128,
        relayer: Address,
    ) -> Result<(), PoolError> {
        if withdrawals_pause_active(&env) {
            return Err(PoolError::WithdrawalsPaused);
        }
        let config = cfg(&env);
        if withdrawn_value <= 0 || fee < 0 || fee > withdrawn_value {
            return Err(PoolError::BadAmount);
        }
        if !withdrawal::validate_withdrawal_amount(&env, withdrawn_value as u128) {
            return Err(PoolError::WithdrawalBelowMinimum);
        }

        // Roots must be known and unexpired.
        Self::require_fresh_root(
            &env,
            &config,
            STATE,
            &state_root,
            PoolError::UnknownStateRoot,
        )?;
        Self::require_fresh_root(&env, &config, ASP, &asp_root, PoolError::UnknownAspRoot)?;

        // Nullifier replay protection.
        if env
            .storage()
            .persistent()
            .has(&nullifier_key(&env, &nullifier_hash))
        {
            return Err(PoolError::NullifierUsed);
        }

        // Recompute the bound context — a relayer cannot redirect funds or alter the fee.
        let context = compute_context(
            &env,
            &recipient,
            withdrawn_value,
            fee,
            &relayer,
            config.scope,
        );

        let public_inputs = VerifyPublicInputsV3 {
            withdrawn_value: BytesN::from_array(&env, &i128_be32(withdrawn_value)),
            state_root: state_root.clone(),
            asp_root: asp_root.clone(),
            nullifier_hash: nullifier_hash.clone(),
            new_commitment: new_commitment.clone(),
            context,
        };
        let valid: bool = env.invoke_contract(
            &config.groth16_verifier,
            &Symbol::new(&env, "verify_proof_v3"),
            (proof_a, proof_b, proof_c, public_inputs).into_val(&env),
        );
        if !valid {
            return Err(PoolError::InvalidProof);
        }

        // Custody invariant: aggregate withdrawals can never exceed aggregate deposits.
        let tot_dep: i128 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "tot_dep"))
            .unwrap_or(0);
        let tot_wd: i128 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "tot_wd"))
            .unwrap_or(0);
        if tot_wd + withdrawn_value > tot_dep {
            return Err(PoolError::CustodyViolation);
        }
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "tot_wd"), &(tot_wd + withdrawn_value));

        // Spend the nullifier and re-insert the remainder commitment as a new leaf.
        let nkey = nullifier_key(&env, &nullifier_hash);
        env.storage().persistent().set(&nkey, &true);
        bump_nullifier_ttl(&env, &nullifier_hash);
        let index: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "dep_count"))
            .unwrap_or(0);
        let ckey = commitment_key(&env, &new_commitment);
        env.storage().persistent().set(&ckey, &index);
        bump_commitment_ttl(&env, &new_commitment);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "dep_count"), &(index + 1));

        // Pay out from the pool's own SAC balance.
        let pool = env.current_contract_address();
        let token = token::TokenClient::new(&env, &config.native_sac);
        let payout = withdrawn_value - fee;
        if payout > 0 {
            token.transfer(&pool, &recipient, &payout);
        }
        if fee > 0 {
            token.transfer(&pool, &relayer, &fee);
        }

        env.events().publish(
            (Symbol::new(&env, "Withdraw"), EVENT_VERSION),
            (nullifier_hash, new_commitment, index, withdrawn_value),
        );
        Ok(())
    }

    fn require_fresh_root(
        env: &Env,
        config: &PoolConfig,
        kind: bool,
        root: &BytesN<32>,
        unknown: PoolError,
    ) -> Result<(), PoolError> {
        let entry: RootEntry = env
            .storage()
            .persistent()
            .get(&root_entry_key(env, kind, root))
            .ok_or(unknown)?;
        let now = env.ledger().sequence();
        if now.saturating_sub(entry.ledger) > config.root_expiry_ledgers {
            return Err(PoolError::RootExpired);
        }
        Ok(())
    }

    // ── Views ────────────────────────────────────────────────────────────────
    pub fn get_deposit_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "dep_count"))
            .unwrap_or(0)
    }

    pub fn is_known_state_root(env: Env, root: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&root_entry_key(&env, STATE, &root))
    }

    pub fn is_known_asp_root(env: Env, root: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&root_entry_key(&env, ASP, &root))
    }

    pub fn is_spent(env: Env, nullifier_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&nullifier_key(&env, &nullifier_hash))
    }

    pub fn get_latest_root(env: Env, state: bool) -> Result<BytesN<32>, PoolError> {
        let hist: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&history_key(&env, state))
            .unwrap_or(Vec::new(&env));
        if hist.is_empty() {
            return Err(if state {
                PoolError::UnknownStateRoot
            } else {
                PoolError::UnknownAspRoot
            });
        }
        Ok(hist.get(hist.len() - 1).unwrap())
    }

    /// (total_deposited, total_withdrawn) — the custody counters.
    pub fn get_custody(env: Env) -> (i128, i128) {
        (
            env.storage()
                .instance()
                .get(&Symbol::new(&env, "tot_dep"))
                .unwrap_or(0),
            env.storage()
                .instance()
                .get(&Symbol::new(&env, "tot_wd"))
                .unwrap_or(0),
        )
    }

    /// Return the current minimum withdrawal amount.
    pub fn get_withdrawal_minimum(env: Env) -> u128 {
        withdrawal::get_minimum_withdrawal_amount(&env)
    }

    /// Update the minimum withdrawal threshold (admin only).
    pub fn set_withdrawal_minimum(
        env: Env,
        admin: Address,
        new_minimum: u128,
    ) -> Result<(), PoolError> {
        admin.require_auth();
        let config = cfg(&env);
        if config.admin != admin {
            return Err(PoolError::Unauthorized);
        }
        withdrawal::update_minimum_withdrawal_amount(&env, admin, new_minimum);
        Ok(())
    }

    /// Return the current commitment tree capacity info.
    pub fn get_tree_capacity_info(env: Env) -> capacity::TreeCapacityInfo {
        capacity::get_tree_capacity(&env)
    }
}

/// i128 (>= 0) -> 32-byte big-endian field element.
fn i128_be32(v: i128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..32].copy_from_slice(&v.to_be_bytes());
    out
}

/// context = keccak256(recipient_xdr ∥ withdrawn_value(16, BE) ∥ fee(16, BE) ∥ relayer_xdr ∥
/// scope(8, BE)) mod r. Binds the payout target and fee split into the proof so a relayer
/// cannot redirect funds. The frontend/prover replicates this exact preimage.
fn compute_context(
    env: &Env,
    recipient: &Address,
    withdrawn_value: i128,
    fee: i128,
    relayer: &Address,
    scope: u64,
) -> BytesN<32> {
    use soroban_sdk::xdr::ToXdr;
    let mut buf = recipient.clone().to_xdr(env);
    buf.append(&Bytes::from_array(env, &withdrawn_value.to_be_bytes()));
    buf.append(&Bytes::from_array(env, &fee.to_be_bytes()));
    buf.append(&relayer.clone().to_xdr(env));
    buf.append(&Bytes::from_array(env, &scope.to_be_bytes()));

    let digest: BytesN<32> = env.crypto().keccak256(&buf).into();
    // Reduce the 256-bit digest mod r so it is a valid BN254 scalar / circuit input.
    let v = U256::from_be_bytes(env, &Bytes::from_array(env, &digest.to_array()));
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &SCALAR_FIELD));
    let reduced = v.rem_euclid(&modulus);
    bytes_to_bytesn32(env, &reduced.to_be_bytes())
}

/// Right-align a (≤32-byte) Bytes into a 32-byte BytesN.
fn bytes_to_bytesn32(env: &Env, b: &Bytes) -> BytesN<32> {
    let len = b.len();
    let mut out = [0u8; 32];
    for i in 0..len {
        out[(32 - len + i) as usize] = b.get(i).unwrap();
    }
    BytesN::from_array(env, &out)
}

#[cfg(test)]
mod test;
