#![no_std]
#![allow(deprecated)]
#![allow(clippy::too_many_arguments)]

//! Relayer market registry + job escrow for Opaque privacy-pool withdrawals.
//!
//! The market hides the submitter link for pool withdrawals. A user creates an escrowed
//! job that commits to a hidden `privacy-pool.withdraw` payload. A registered relayer
//! accepts only after decrypting and validating that payload off-chain, then submits it
//! through this registry. The registry recomputes the payload hash, invokes the pool,
//! releases the relayer's bonded stake, and pays the escrowed fee atomically.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Bytes, BytesN, Env,
    IntoVal, String, Symbol,
};

/// TTL for persistent storage entries, matching the privacy-pool convention (#734).
/// At 5 s/ledger this equals ~120 days (2 073 600 ledgers).
const PERSISTENT_TTL_LEDGERS: u32 = 2_073_600;

const DEFAULT_MINIMUM_STAKE: i128 = 1_000_000; // 0.1 XLM on testnet.
const DEFAULT_UNSTAKE_COOLDOWN_LEDGERS: u32 = 720; // ~1 hour at 5s/ledger.
const DEFAULT_MAX_DEADLINE_LEDGERS: u32 = 17_280; // ~1 day.
const STATUS_OPEN: u32 = 0;
const STATUS_ACCEPTED: u32 = 1;
const STATUS_SUBMITTED: u32 = 2;
const STATUS_SLASHED: u32 = 3;
const STATUS_CANCELED: u32 = 4;
const EVENT_VERSION: u32 = 1;
const PAYLOAD_DOMAIN: &[u8] = b"opaque-stellar-relay-v1";

#[contract]
pub struct RelayerRegistry;

#[contracttype]
#[derive(Clone)]
pub struct RegistryConfig {
    pub admin: Address,
    pub native_sac: Address,
    pub privacy_pool: Address,
    pub minimum_stake: i128,
    pub unstake_cooldown_ledgers: u32,
    pub max_deadline_ledgers: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct RelayerRecord {
    pub operator: Address,
    pub x25519_pubkey: BytesN<32>,
    pub endpoint: String,
    pub free_stake: i128,
    pub bonded_stake: i128,
    pub pending_unstake: i128,
    pub unstake_unlock_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct JobRecord {
    pub creator: Address,
    pub payload_hash: BytesN<32>,
    pub fee: i128,
    pub deadline_ledger: u32,
    pub accepted_relayer: Option<Address>,
    pub status: u32,
    pub created_ledger: u32,
    pub submitted_ledger: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    NotInitialized = 3,
    RelayerExists = 4,
    RelayerMissing = 5,
    StakeTooLow = 6,
    BadAmount = 7,
    InsufficientFreeStake = 8,
    UnstakeLocked = 9,
    JobExists = 10,
    JobMissing = 11,
    BadDeadline = 12,
    JobNotOpen = 13,
    JobNotAccepted = 14,
    WrongRelayer = 15,
    DeadlinePassed = 16,
    DeadlineNotPassed = 17,
    PayloadHashMismatch = 18,
    AlreadyFinalized = 19,
    InvalidSlashAmount = 20,
    SlashProofInvalid = 21,
    RelayerNotSlashed = 22,
}

fn config_key(env: &Env) -> Symbol {
    Symbol::new(env, "config")
}

fn relayer_key(env: &Env, operator: &Address) -> (Symbol, Address) {
    (Symbol::new(env, "relayer"), operator.clone())
}

fn job_key(env: &Env, job_id: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (Symbol::new(env, "job"), job_id.clone())
}

fn cfg(env: &Env) -> Result<RegistryConfig, RegistryError> {
    env.storage()
        .instance()
        .get(&config_key(env))
        .ok_or(RegistryError::NotInitialized)
}

/// Extend the TTL of a persistent storage key to prevent archival (#734).
fn bump_persistent_ttl<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_LEDGERS, PERSISTENT_TTL_LEDGERS);
}

fn require_admin(env: &Env, admin: &Address) -> Result<RegistryConfig, RegistryError> {
    admin.require_auth();
    let config = cfg(env)?;
    if config.admin != *admin {
        return Err(RegistryError::Unauthorized);
    }
    Ok(config)
}

fn read_relayer(env: &Env, operator: &Address) -> Result<RelayerRecord, RegistryError> {
    env.storage()
        .persistent()
        .get(&relayer_key(env, operator))
        .ok_or(RegistryError::RelayerMissing)
}

fn write_relayer(env: &Env, record: &RelayerRecord) {
    let key = relayer_key(env, &record.operator);
    env.storage()
        .persistent()
        .set(&key, record);
    bump_persistent_ttl(env, &key);
}

fn read_job(env: &Env, job_id: &BytesN<32>) -> Result<JobRecord, RegistryError> {
    env.storage()
        .persistent()
        .get(&job_key(env, job_id))
        .ok_or(RegistryError::JobMissing)
}

fn write_job(env: &Env, job_id: &BytesN<32>, job: &JobRecord) {
    let key = job_key(env, job_id);
    env.storage().persistent().set(&key, job);
    bump_persistent_ttl(env, &key);
}

fn token_transfer(env: &Env, sac: &Address, from: &Address, to: &Address, amount: i128) {
    if amount > 0 {
        token::TokenClient::new(env, sac).transfer(from, to, &amount);
    }
}

#[contractimpl]
impl RelayerRegistry {
    pub fn initialize(
        env: Env,
        admin: Address,
        native_sac: Address,
        privacy_pool: Address,
        minimum_stake: i128,
        unstake_cooldown_ledgers: u32,
        max_deadline_ledgers: u32,
    ) -> Result<(), RegistryError> {
        admin.require_auth();
        if env.storage().instance().has(&config_key(&env)) {
            return Err(RegistryError::AlreadyInitialized);
        }
        env.storage().instance().set(
            &config_key(&env),
            &RegistryConfig {
                admin,
                native_sac,
                privacy_pool,
                minimum_stake: if minimum_stake > 0 {
                    minimum_stake
                } else {
                    DEFAULT_MINIMUM_STAKE
                },
                unstake_cooldown_ledgers: if unstake_cooldown_ledgers > 0 {
                    unstake_cooldown_ledgers
                } else {
                    DEFAULT_UNSTAKE_COOLDOWN_LEDGERS
                },
                max_deadline_ledgers: if max_deadline_ledgers > 0 {
                    max_deadline_ledgers
                } else {
                    DEFAULT_MAX_DEADLINE_LEDGERS
                },
            },
        );
        Ok(())
    }

    pub fn get_config(env: Env) -> Result<RegistryConfig, RegistryError> {
        cfg(&env)
    }

    pub fn register(
        env: Env,
        operator: Address,
        x25519_pubkey: BytesN<32>,
        endpoint: String,
        stake: i128,
    ) -> Result<(), RegistryError> {
        operator.require_auth();
        let config = cfg(&env)?;
        if stake < config.minimum_stake {
            return Err(RegistryError::StakeTooLow);
        }
        if env
            .storage()
            .persistent()
            .has(&relayer_key(&env, &operator))
        {
            return Err(RegistryError::RelayerExists);
        }
        let registry = env.current_contract_address();
        token_transfer(&env, &config.native_sac, &operator, &registry, stake);
        let record = RelayerRecord {
            operator: operator.clone(),
            x25519_pubkey,
            endpoint,
            free_stake: stake,
            bonded_stake: 0,
            pending_unstake: 0,
            unstake_unlock_ledger: 0,
        };
        write_relayer(&env, &record);
        env.events().publish(
            (Symbol::new(&env, "RelayerRegistered"), EVENT_VERSION),
            (operator, stake),
        );
        Ok(())
    }

    pub fn add_stake(env: Env, operator: Address, amount: i128) -> Result<(), RegistryError> {
        operator.require_auth();
        if amount <= 0 {
            return Err(RegistryError::BadAmount);
        }
        let config = cfg(&env)?;
        let mut relayer = read_relayer(&env, &operator)?;
        let registry = env.current_contract_address();
        token_transfer(&env, &config.native_sac, &operator, &registry, amount);
        relayer.free_stake += amount;
        write_relayer(&env, &relayer);
        env.events().publish(
            (Symbol::new(&env, "StakeAdded"), EVENT_VERSION),
            (operator, amount),
        );
        Ok(())
    }

    pub fn request_unstake(env: Env, operator: Address, amount: i128) -> Result<(), RegistryError> {
        operator.require_auth();
        if amount <= 0 {
            return Err(RegistryError::BadAmount);
        }
        let config = cfg(&env)?;
        let mut relayer = read_relayer(&env, &operator)?;
        if relayer.free_stake < amount {
            return Err(RegistryError::InsufficientFreeStake);
        }
        relayer.free_stake -= amount;
        relayer.pending_unstake += amount;
        relayer.unstake_unlock_ledger = env
            .ledger()
            .sequence()
            .saturating_add(config.unstake_cooldown_ledgers);
        write_relayer(&env, &relayer);
        env.events().publish(
            (Symbol::new(&env, "UnstakeRequested"), EVENT_VERSION),
            (operator, amount, relayer.unstake_unlock_ledger),
        );
        Ok(())
    }

    pub fn withdraw_stake(env: Env, operator: Address) -> Result<(), RegistryError> {
        operator.require_auth();
        let config = cfg(&env)?;
        let mut relayer = read_relayer(&env, &operator)?;
        if relayer.pending_unstake <= 0 {
            return Err(RegistryError::BadAmount);
        }
        if env.ledger().sequence() < relayer.unstake_unlock_ledger {
            return Err(RegistryError::UnstakeLocked);
        }
        let amount = relayer.pending_unstake;
        relayer.pending_unstake = 0;
        relayer.unstake_unlock_ledger = 0;
        write_relayer(&env, &relayer);
        let registry = env.current_contract_address();
        token_transfer(&env, &config.native_sac, &registry, &operator, amount);
        env.events().publish(
            (Symbol::new(&env, "StakeWithdrawn"), EVENT_VERSION),
            (operator, amount),
        );
        Ok(())
    }

    pub fn create_job(
        env: Env,
        creator: Address,
        job_id: BytesN<32>,
        payload_hash: BytesN<32>,
        deadline_ledger: u32,
        fee: i128,
    ) -> Result<(), RegistryError> {
        creator.require_auth();
        if fee <= 0 {
            return Err(RegistryError::BadAmount);
        }
        let config = cfg(&env)?;
        let now = env.ledger().sequence();
        if deadline_ledger <= now
            || deadline_ledger.saturating_sub(now) > config.max_deadline_ledgers
        {
            return Err(RegistryError::BadDeadline);
        }
        if env.storage().persistent().has(&job_key(&env, &job_id)) {
            return Err(RegistryError::JobExists);
        }
        let registry = env.current_contract_address();
        token_transfer(&env, &config.native_sac, &creator, &registry, fee);
        let job = JobRecord {
            creator: creator.clone(),
            payload_hash,
            fee,
            deadline_ledger,
            accepted_relayer: None,
            status: STATUS_OPEN,
            created_ledger: now,
            submitted_ledger: 0,
        };
        write_job(&env, &job_id, &job);
        env.events().publish(
            (Symbol::new(&env, "JobCreated"), EVENT_VERSION),
            (job_id, creator, fee, deadline_ledger),
        );
        Ok(())
    }

    pub fn accept_job(
        env: Env,
        operator: Address,
        job_id: BytesN<32>,
    ) -> Result<(), RegistryError> {
        operator.require_auth();
        let mut job = read_job(&env, &job_id)?;
        if job.status != STATUS_OPEN {
            return Err(RegistryError::JobNotOpen);
        }
        if env.ledger().sequence() >= job.deadline_ledger {
            return Err(RegistryError::DeadlinePassed);
        }
        let mut relayer = read_relayer(&env, &operator)?;
        if relayer.free_stake < job.fee {
            return Err(RegistryError::InsufficientFreeStake);
        }
        relayer.free_stake -= job.fee;
        relayer.bonded_stake += job.fee;
        write_relayer(&env, &relayer);
        job.accepted_relayer = Some(operator.clone());
        job.status = STATUS_ACCEPTED;
        write_job(&env, &job_id, &job);
        env.events().publish(
            (Symbol::new(&env, "JobAccepted"), EVENT_VERSION),
            (job_id, operator, job.fee),
        );
        Ok(())
    }

    pub fn submit_pool_withdraw(
        env: Env,
        operator: Address,
        job_id: BytesN<32>,
        proof_a: BytesN<64>,
        proof_b: BytesN<128>,
        proof_c: BytesN<64>,
        withdrawn_value: i128,
        state_root: BytesN<32>,
        asp_root: BytesN<32>,
        nullifier_hash: BytesN<32>,
        new_commitment: BytesN<32>,
        recipient: Address,
        pool_fee: i128,
        pool_relayer: Address,
    ) -> Result<(), RegistryError> {
        operator.require_auth();
        let config = cfg(&env)?;
        let mut job = read_job(&env, &job_id)?;
        if job.status != STATUS_ACCEPTED {
            return Err(RegistryError::JobNotAccepted);
        }
        if job.accepted_relayer != Some(operator.clone()) {
            return Err(RegistryError::WrongRelayer);
        }
        if env.ledger().sequence() >= job.deadline_ledger {
            return Err(RegistryError::DeadlinePassed);
        }
        let actual_hash = pool_withdraw_payload_hash(
            &env,
            &config.privacy_pool,
            &proof_a,
            &proof_b,
            &proof_c,
            withdrawn_value,
            &state_root,
            &asp_root,
            &nullifier_hash,
            &new_commitment,
            &recipient,
            pool_fee,
            &pool_relayer,
        );
        if actual_hash != job.payload_hash {
            return Err(RegistryError::PayloadHashMismatch);
        }

        let _: () = env.invoke_contract(
            &config.privacy_pool,
            &Symbol::new(&env, "withdraw"),
            (
                proof_a,
                proof_b,
                proof_c,
                withdrawn_value,
                state_root,
                asp_root,
                nullifier_hash,
                new_commitment,
                recipient,
                pool_fee,
                pool_relayer,
            )
                .into_val(&env),
        );

        let mut relayer = read_relayer(&env, &operator)?;
        relayer.bonded_stake -= job.fee;
        relayer.free_stake += job.fee;
        write_relayer(&env, &relayer);

        job.status = STATUS_SUBMITTED;
        job.submitted_ledger = env.ledger().sequence();
        write_job(&env, &job_id, &job);

        let registry = env.current_contract_address();
        token_transfer(&env, &config.native_sac, &registry, &operator, job.fee);
        env.events().publish(
            (Symbol::new(&env, "JobSubmitted"), EVENT_VERSION),
            (job_id, operator, job.fee),
        );
        Ok(())
    }

    pub fn slash_job(env: Env, creator: Address, job_id: BytesN<32>) -> Result<(), RegistryError> {
        creator.require_auth();
        let config = cfg(&env)?;
        let mut job = read_job(&env, &job_id)?;
        if job.creator != creator {
            return Err(RegistryError::Unauthorized);
        }
        if job.status != STATUS_ACCEPTED {
            return Err(RegistryError::JobNotAccepted);
        }
        if env.ledger().sequence() <= job.deadline_ledger {
            return Err(RegistryError::DeadlineNotPassed);
        }
        let operator = job
            .accepted_relayer
            .clone()
            .ok_or(RegistryError::JobNotAccepted)?;
        let mut relayer = read_relayer(&env, &operator)?;
        relayer.bonded_stake -= job.fee;
        if relayer.pending_unstake > 0 {
            let slash_from_pending = core::cmp::min(relayer.pending_unstake, job.fee);
            relayer.pending_unstake -= slash_from_pending;
            if relayer.pending_unstake == 0 {
                relayer.unstake_unlock_ledger = 0;
            }
        }
        write_relayer(&env, &relayer);

        job.status = STATUS_SLASHED;
        write_job(&env, &job_id, &job);

        let registry = env.current_contract_address();
        token_transfer(&env, &config.native_sac, &registry, &creator, job.fee * 2);
        env.events().publish(
            (Symbol::new(&env, "JobSlashed"), EVENT_VERSION),
            (job_id, operator, job.fee),
        );
        Ok(())
    }

    pub fn cancel_job(env: Env, creator: Address, job_id: BytesN<32>) -> Result<(), RegistryError> {
        creator.require_auth();
        let config = cfg(&env)?;
        let mut job = read_job(&env, &job_id)?;
        if job.creator != creator {
            return Err(RegistryError::Unauthorized);
        }
        if job.status != STATUS_OPEN {
            return Err(RegistryError::JobNotOpen);
        }
        if env.ledger().sequence() <= job.deadline_ledger {
            return Err(RegistryError::DeadlineNotPassed);
        }
        job.status = STATUS_CANCELED;
        write_job(&env, &job_id, &job);
        let registry = env.current_contract_address();
        token_transfer(&env, &config.native_sac, &registry, &creator, job.fee);
        env.events().publish(
            (Symbol::new(&env, "JobCanceled"), EVENT_VERSION),
            (job_id, creator, job.fee),
        );
        Ok(())
    }

    pub fn get_relayer(env: Env, operator: Address) -> Result<RelayerRecord, RegistryError> {
        read_relayer(&env, &operator)
    }

    pub fn get_unbonding_status(
        env: Env,
        operator: Address,
    ) -> Result<(i128, u32, bool), RegistryError> {
        let relayer = read_relayer(&env, &operator)?;
        let is_unlockable =
            relayer.pending_unstake > 0 && env.ledger().sequence() >= relayer.unstake_unlock_ledger;
        Ok((
            relayer.pending_unstake,
            relayer.unstake_unlock_ledger,
            is_unlockable,
        ))
    }

    pub fn get_job(env: Env, job_id: BytesN<32>) -> Result<JobRecord, RegistryError> {
        read_job(&env, &job_id)
    }

    pub fn hash_pool_withdraw_payload(
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
        pool_fee: i128,
        pool_relayer: Address,
    ) -> Result<BytesN<32>, RegistryError> {
        let config = cfg(&env)?;
        Ok(pool_withdraw_payload_hash(
            &env,
            &config.privacy_pool,
            &proof_a,
            &proof_b,
            &proof_c,
            withdrawn_value,
            &state_root,
            &asp_root,
            &nullifier_hash,
            &new_commitment,
            &recipient,
            pool_fee,
            &pool_relayer,
        ))
    }

    pub fn status_open(_env: Env) -> u32 {
        STATUS_OPEN
    }
    pub fn status_accepted(_env: Env) -> u32 {
        STATUS_ACCEPTED
    }
    pub fn status_submitted(_env: Env) -> u32 {
        STATUS_SUBMITTED
    }
    pub fn status_slashed(_env: Env) -> u32 {
        STATUS_SLASHED
    }
    pub fn status_canceled(_env: Env) -> u32 {
        STATUS_CANCELED
    }

    pub fn set_config(
        env: Env,
        admin: Address,
        minimum_stake: i128,
        unstake_cooldown_ledgers: u32,
        max_deadline_ledgers: u32,
    ) -> Result<(), RegistryError> {
        let mut config = require_admin(&env, &admin)?;
        if minimum_stake <= 0 || unstake_cooldown_ledgers == 0 || max_deadline_ledgers == 0 {
            return Err(RegistryError::BadAmount);
        }
        config.minimum_stake = minimum_stake;
        config.unstake_cooldown_ledgers = unstake_cooldown_ledgers;
        config.max_deadline_ledgers = max_deadline_ledgers;
        env.storage().instance().set(&config_key(&env), &config);
        Ok(())
    }

    /// Moves admin authority to `new_admin` (Issue #589) — the migration path
    /// from a single-key admin to a deployed `multisig-admin` contract's
    /// address, with no redeployment. Once this call succeeds, the current
    /// `admin` can no longer authorize any admin-gated operation.
    pub fn transfer_admin(
        env: Env,
        admin: Address,
        new_admin: Address,
    ) -> Result<(), RegistryError> {
        let mut config = require_admin(&env, &admin)?;
        config.admin = new_admin;
        env.storage().instance().set(&config_key(&env), &config);
        Ok(())
    }

    // ── Slashing (#583, #732) ────────────────────────────────────────────────

    /// Report a relayer offense and slash their stake. Anyone may call this.
    ///
    /// `slash_amount` is deducted from the relayer's `bonded_stake` (or
    /// `free_stake` if bonded is insufficient). The slashed amount is
    /// transferred to the reporter.
    pub fn report_slash(
        env: Env,
        proof: slashing::SlashingProof,
        slash_amount: i128,
    ) -> Result<(), RegistryError> {
        if slash_amount <= 0 {
            return Err(RegistryError::InvalidSlashAmount);
        }
        let slash_u128 = slash_amount as u128;

        // Verify cryptographic evidence and record the slash.
        slashing::slash_relayer(&env, &proof, slash_u128)?;

        // Deduct from the relayer's stake.
        let config = cfg(&env)?;
        let mut relayer = read_relayer(&env, &proof.relayer)?;

        let actual_slash = core::cmp::min(slash_u128, relayer.bonded_stake as u128);
        relayer.bonded_stake -= actual_slash as i128;

        // If bonded wasn't enough, also slash free stake.
        let remaining = slash_u128 - actual_slash;
        if remaining > 0 {
            let free_slash = core::cmp::min(remaining, relayer.free_stake as u128);
            relayer.free_stake -= free_slash as i128;
        }

        write_relayer(&env, &relayer);

        // Pay the reporter.
        let registry = env.current_contract_address();
        token_transfer(
            &env,
            &config.native_sac,
            &registry,
            &proof.reporter,
            slash_amount,
        );

        env.events().publish(
            (Symbol::new(&env, "SlashReported"), EVENT_VERSION),
            (
                proof.relayer,
                proof.offense,
                slash_amount,
                proof.reporter,
            ),
        );
        Ok(())
    }

    /// Return the slashing record for a relayer (slash count, total slashed, etc.).
    pub fn get_slashing_record(
        env: Env,
        relayer: Address,
    ) -> Option<slashing::RelayerSlashRecord> {
        slashing::get_slashing_record(&env, &relayer)
    }

    /// Return the slashing percentage (total_slashed * 10000 / original_stake).
    pub fn get_slashing_percentage(env: Env, relayer: Address) -> u64 {
        slashing::get_slashing_percentage(&env, &relayer)
    }
}

fn push_array<const N: usize>(env: &Env, buf: &mut Bytes, value: &[u8; N]) {
    buf.append(&Bytes::from_array(env, value));
}

fn pool_withdraw_payload_hash(
    env: &Env,
    privacy_pool: &Address,
    proof_a: &BytesN<64>,
    proof_b: &BytesN<128>,
    proof_c: &BytesN<64>,
    withdrawn_value: i128,
    state_root: &BytesN<32>,
    asp_root: &BytesN<32>,
    nullifier_hash: &BytesN<32>,
    new_commitment: &BytesN<32>,
    recipient: &Address,
    pool_fee: i128,
    pool_relayer: &Address,
) -> BytesN<32> {
    use soroban_sdk::xdr::ToXdr;
    let mut buf = Bytes::from_slice(env, PAYLOAD_DOMAIN);
    buf.append(&privacy_pool.clone().to_xdr(env));
    buf.append(&Symbol::new(env, "withdraw").to_xdr(env));
    push_array(env, &mut buf, &proof_a.to_array());
    push_array(env, &mut buf, &proof_b.to_array());
    push_array(env, &mut buf, &proof_c.to_array());
    push_array(env, &mut buf, &withdrawn_value.to_be_bytes());
    push_array(env, &mut buf, &state_root.to_array());
    push_array(env, &mut buf, &asp_root.to_array());
    push_array(env, &mut buf, &nullifier_hash.to_array());
    push_array(env, &mut buf, &new_commitment.to_array());
    buf.append(&recipient.clone().to_xdr(env));
    push_array(env, &mut buf, &pool_fee.to_be_bytes());
    buf.append(&pool_relayer.clone().to_xdr(env));
    env.crypto().keccak256(&buf).into()
}

mod slashing;

#[cfg(test)]
mod test;
