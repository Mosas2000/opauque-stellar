#![no_std]
// The classic `events().publish` API is retained intentionally: migrating to the
// `#[contractevent]` macro would change the on-chain event ABI that the WASM scanner
// and frontend depend on. `register_contract` is likewise retained in tests.
#![allow(deprecated)]
// `verify_reputation` intentionally takes the full proof + public-input set as discrete args.
#![allow(clippy::too_many_arguments)]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, IntoVal, Symbol, Vec,
};

// Default root expiry (~1 day at 5 s/ledger). Overridable via set_root_expiry.
const DEFAULT_ROOT_EXPIRY_LEDGERS: u32 = 17_280;
const MAX_ROOT_HISTORY: u32 = 100;
/// Maximum nullifiers accepted by `are_nullifiers_spent` in one read call.
/// The bound keeps simulation cost predictable for wallet proof preflight.
pub const MAX_NULLIFIER_BATCH_SIZE: u32 = 128;

/// Current event schema version — increment when the event topic/data layout changes.
/// Scanners should reject events with an unrecognised version rather than misparse them.
const EVENT_VERSION: u32 = 1;

#[contract]
pub struct ReputationVerifier;

#[contracttype]
#[derive(Clone)]
pub struct VerifierConfig {
    pub admin: Address,
    pub groth16_verifier: Address,
    // Configurable root validity window (ledgers). Defaults to DEFAULT_ROOT_EXPIRY_LEDGERS.
    pub root_expiry_ledgers: u32,
}

/// Construct a domain-separated external nullifier from application-level inputs.
///
/// Callers should derive `external_nullifier` this way:
///   external_nullifier = compute_external_nullifier(app_id, action_id)
///
/// Where:
///   app_id    — identifies the application or verifier deployment (e.g. a hash of the
///               contract address and chain id, truncated to u64)
///   action_id — identifies the specific action or campaign within the app (e.g. "vote-2024")
///
/// The combination prevents nullifiers from one context being replayed in another
/// because a valid proof for (app_id=A, action_id=X) binds the nullifier to that
/// specific external_nullifier value. Proofs from context A cannot satisfy the
/// circuit check in context B.
///
/// # Example (off-chain, Rust pseudocode)
/// ```ignore
/// let ext_null = compute_external_nullifier(0xDEADBEEF_00000001, 0x0000_0001);
/// ```
pub fn compute_external_nullifier(app_id: u64, action_id: u64) -> u64 {
    // Simple hash-based mix: rotate-XOR to avoid trivial collisions while keeping u64.
    let mixed = app_id.rotate_left(32) ^ action_id;
    // Additional diffusion pass so (a,0) != (0,a)
    let h = mixed.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    h ^ (h >> 30)
}

#[contracttype]
#[derive(Clone)]
pub struct MerkleRootEntry {
    pub root: BytesN<32>,
    pub ledger: u32,
    pub dataset_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone)]
pub struct NullifierEntry {
    pub used: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ReputationError {
    Unauthorized = 1,
    RootExpired = 2,
    InvalidProof = 3,
    NullifierUsed = 4,
    AlreadyInitialized = 5,
    AttestationExpired = 6,
    InvalidDatasetHash = 7,
    ContractFrozen = 8,
    BatchTooLarge = 9,
    /// A direct (non-timelocked) call was rejected because a timelock delay
    /// is configured — the caller must use the schedule/execute flow instead.
    TimelockEnabled = 9,
    /// `schedule_*` was called while no timelock delay is configured (delay == 0).
    TimelockNotEnabled = 10,
    ActionNotFound = 11,
    ActionNotReady = 12,
    ActionAlreadyFinalized = 13,
}

/// A sensitive admin action that has been scheduled behind the optional timelock.
/// See `set_timelock_delay`, `schedule_update_merkle_root`, `schedule_admin_transfer`.
#[contracttype]
#[derive(Clone)]
pub enum PendingAction {
    UpdateMerkleRoot {
        root: BytesN<32>,
        dataset_hash: BytesN<32>,
    },
    TransferAdmin {
        new_admin: Address,
    },
}

#[contracttype]
#[derive(Clone)]
pub struct PendingActionEntry {
    pub action: PendingAction,
    /// Ledger sequence at/after which the action may be executed.
    pub eta_ledger: u32,
    pub executed: bool,
    pub cancelled: bool,
}

fn root_key(root: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (Symbol::new(root.env(), "merkle_root"), root.clone())
}

fn nullifier_key(n: &BytesN<32>) -> (Symbol, BytesN<32>) {
    (Symbol::new(n.env(), "nullifier"), n.clone())
}

fn history_key(env: &Env) -> Symbol {
    Symbol::new(env, "root_history")
}

fn frozen_key(env: &Env) -> Symbol {
    Symbol::new(env, "frozen")
}

fn last_root_update_key(env: &Env) -> Symbol {
    Symbol::new(env, "last_root_upd")
}

fn timelock_delay_key(env: &Env) -> Symbol {
    Symbol::new(env, "tl_delay")
}

fn next_action_id_key(env: &Env) -> Symbol {
    Symbol::new(env, "tl_next_id")
}

fn pending_action_key(env: &Env, id: u64) -> (Symbol, u64) {
    (Symbol::new(env, "tl_action"), id)
}

/// Apply a merkle root update unconditionally (caller has already authorized
/// and checked admin/frozen/timelock gating). Shared by the direct
/// `update_merkle_root` path and the timelocked `execute_pending_action` path.
fn apply_update_merkle_root(
    env: &Env,
    admin: &Address,
    root: BytesN<32>,
    dataset_hash: BytesN<32>,
) -> Result<(), ReputationError> {
    if env.storage().instance().get(&frozen_key(env)).unwrap_or(false) {
        return Err(ReputationError::ContractFrozen);
    }
    let ledger = env.ledger().sequence();
    env.storage().persistent().set(
        &root_key(&root),
        &MerkleRootEntry {
            root: root.clone(),
            ledger,
            dataset_hash: dataset_hash.clone(),
        },
    );
    let mut history: Vec<BytesN<32>> = env
        .storage()
        .instance()
        .get(&history_key(env))
        .unwrap_or(Vec::new(env));
    if history.len() >= MAX_ROOT_HISTORY {
        history.remove(0);
    }
    history.push_back(root.clone());
    env.storage().instance().set(&history_key(env), &history);
    env.storage().instance().set(&last_root_update_key(env), &ledger);

    env.events().publish(
        (Symbol::new(env, "MerkleRootPublished"), EVENT_VERSION),
        (root, ledger, dataset_hash, admin.clone()),
    );
    Ok(())
}

/// Schedule a sensitive admin action behind the configured timelock delay.
/// Fails with `TimelockNotEnabled` if no delay is configured (delay == 0).
fn schedule_action(env: &Env, admin: Address, action: PendingAction) -> Result<u64, ReputationError> {
    admin.require_auth();
    let config: VerifierConfig = env
        .storage()
        .instance()
        .get(&Symbol::new(env, "config"))
        .expect("config");
    if config.admin != admin {
        return Err(ReputationError::Unauthorized);
    }
    let delay: u32 = env
        .storage()
        .instance()
        .get(&timelock_delay_key(env))
        .unwrap_or(0u32);
    if delay == 0 {
        return Err(ReputationError::TimelockNotEnabled);
    }
    let id: u64 = env
        .storage()
        .instance()
        .get(&next_action_id_key(env))
        .unwrap_or(0u64);
    let eta_ledger = env.ledger().sequence() + delay;
    env.storage().persistent().set(
        &pending_action_key(env, id),
        &PendingActionEntry {
            action,
            eta_ledger,
            executed: false,
            cancelled: false,
        },
    );
    env.storage()
        .instance()
        .set(&next_action_id_key(env), &(id + 1));
    env.events().publish(
        (Symbol::new(env, "ActionScheduled"), EVENT_VERSION),
        (id, eta_ledger, admin),
    );
    Ok(id)
}

#[contractimpl]
impl ReputationVerifier {
    pub fn initialize(
        env: Env,
        admin: Address,
        groth16_verifier: Address,
    ) -> Result<(), ReputationError> {
        admin.require_auth();
        if env.storage().instance().has(&Symbol::new(&env, "config")) {
            return Err(ReputationError::AlreadyInitialized);
        }
        let config = VerifierConfig {
            admin: admin.clone(),
            groth16_verifier,
            root_expiry_ledgers: DEFAULT_ROOT_EXPIRY_LEDGERS,
        };
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "config"), &config);
        env.storage()
            .instance()
            .set(&history_key(&env), &Vec::<BytesN<32>>::new(&env));
        Ok(())
    }

    /// Update the root validity window. Only the admin may call this.
    pub fn set_root_expiry(
        env: Env,
        admin: Address,
        expiry_ledgers: u32,
    ) -> Result<(), ReputationError> {
        admin.require_auth();
        let mut config: VerifierConfig = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "config"))
            .expect("config");
        if config.admin != admin {
            return Err(ReputationError::Unauthorized);
        }
        config.root_expiry_ledgers = expiry_ledgers;
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "config"), &config);
        Ok(())
    }

    /// Return a paginated slice of the root history (oldest-first).
    /// `offset` is the index of the first element to return; `limit` caps the count.
    pub fn get_root_history(env: Env, offset: u32, limit: u32) -> Vec<BytesN<32>> {
        // Root history is stored as a Vec<BytesN<32>> in instance storage.
        // Instance storage is bounded by Soroban's instance size limits (~64 KB).
        // MAX_ROOT_HISTORY=100 entries × 32 bytes = ~3.2 KB, well within the limit.
        // Pagination is provided so callers can read partial ranges without pulling
        // the full vector.
        let history: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&history_key(&env))
            .unwrap_or(Vec::new(&env));
        let len = history.len();
        let start = offset.min(len);
        let end = (start + limit).min(len);
        let mut page = Vec::new(&env);
        for i in start..end {
            page.push_back(history.get(i).unwrap());
        }
        page
    }

    pub fn is_frozen(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&frozen_key(&env))
            .unwrap_or(false)
    }

    pub fn set_frozen(env: Env, admin: Address, frozen: bool) -> Result<(), ReputationError> {
        admin.require_auth();
        let config: VerifierConfig = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "config"))
            .expect("config");
        if config.admin != admin {
            return Err(ReputationError::Unauthorized);
        }
        env.storage().instance().set(&frozen_key(&env), &frozen);
        env.events().publish(
            (Symbol::new(&env, "FreezeStatusChanged"), EVENT_VERSION),
            (frozen, admin),
        );
        Ok(())
    }

    pub fn last_root_update(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&last_root_update_key(&env))
            .unwrap_or(0u32)
    }

    pub fn nullifier_batch_limit(_env: Env) -> u32 {
        MAX_NULLIFIER_BATCH_SIZE
    }

    /// Return spent/unspent status for a bounded batch of nullifier hashes.
    ///
    /// Results preserve input order. The batch is capped at
    /// `MAX_NULLIFIER_BATCH_SIZE` so wallets can preflight many proofs without
    /// unbounded simulation cost.
    pub fn are_nullifiers_spent(
        env: Env,
        ids: Vec<BytesN<32>>,
    ) -> Result<Vec<bool>, ReputationError> {
        if ids.len() > MAX_NULLIFIER_BATCH_SIZE {
            return Err(ReputationError::BatchTooLarge);
        }
        let mut out = Vec::new(&env);
        for id in ids.iter() {
            out.push_back(env.storage().persistent().has(&nullifier_key(&id)));
        }
        Ok(out)
    }

    pub fn update_merkle_root(
        env: Env,
        admin: Address,
        root: BytesN<32>,
        dataset_hash: BytesN<32>,
    ) -> Result<(), ReputationError> {
        admin.require_auth();
        if env
            .storage()
            .instance()
            .get(&frozen_key(&env))
            .unwrap_or(false)
        {
            return Err(ReputationError::ContractFrozen);
        let config: VerifierConfig = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "config"))
            .expect("config");
        if config.admin != admin {
            return Err(ReputationError::Unauthorized);
        }
        // Optional timelock (disabled by default — delay 0 — preserves v1 behavior).
        if env
            .storage()
            .instance()
            .get(&timelock_delay_key(&env))
            .unwrap_or(0u32)
            > 0
        {
            return Err(ReputationError::TimelockEnabled);
        }
        apply_update_merkle_root(&env, &admin, root, dataset_hash)
    }

    /// Transfer admin to a new address immediately. Blocked while a timelock
    /// delay is configured — use `schedule_admin_transfer` instead in that case.
    pub fn transfer_admin(
        env: Env,
        admin: Address,
        new_admin: Address,
    ) -> Result<(), ReputationError> {
        admin.require_auth();
        let mut config: VerifierConfig = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "config"))
            .expect("config");
        if config.admin != admin {
            return Err(ReputationError::Unauthorized);
        }
        if env
            .storage()
            .instance()
            .get(&timelock_delay_key(&env))
            .unwrap_or(0u32)
            > 0
        {
            return Err(ReputationError::TimelockEnabled);
        }
        config.admin = new_admin.clone();
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "config"), &config);
        env.events().publish(
            (Symbol::new(&env, "AdminTransferred"), EVENT_VERSION),
            (new_admin, admin),
        );
        Ok(())
    }

    /// Configure the timelock delay (in ledgers) for `update_merkle_root` and
    /// admin transfer. `0` (the default) disables the timelock and preserves
    /// the original immediate-execution behavior.
    pub fn set_timelock_delay(
        env: Env,
        admin: Address,
        delay_ledgers: u32,
    ) -> Result<(), ReputationError> {
        admin.require_auth();
        let config: VerifierConfig = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "config"))
            .expect("config");
        if config.admin != admin {
            return Err(ReputationError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&timelock_delay_key(&env), &delay_ledgers);
        env.events().publish(
            (Symbol::new(&env, "TimelockDelayUpdated"), EVENT_VERSION),
            (delay_ledgers, admin),
        );
        Ok(())
    }

    pub fn get_timelock_delay(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&timelock_delay_key(&env))
            .unwrap_or(0u32)
    }

    /// Schedule a merkle root update behind the configured timelock delay.
    /// Requires `set_timelock_delay` to have been called with a non-zero delay.
    pub fn schedule_update_merkle_root(
        env: Env,
        admin: Address,
        root: BytesN<32>,
        dataset_hash: BytesN<32>,
    ) -> Result<u64, ReputationError> {
        schedule_action(
            &env,
            admin,
            PendingAction::UpdateMerkleRoot { root, dataset_hash },
        )
    }

    /// Schedule an admin transfer behind the configured timelock delay.
    pub fn schedule_admin_transfer(
        env: Env,
        admin: Address,
        new_admin: Address,
    ) -> Result<u64, ReputationError> {
        schedule_action(&env, admin, PendingAction::TransferAdmin { new_admin })
    }

    pub fn get_pending_action(env: Env, action_id: u64) -> Result<PendingActionEntry, ReputationError> {
        env.storage()
            .persistent()
            .get(&pending_action_key(&env, action_id))
            .ok_or(ReputationError::ActionNotFound)
    }

    /// Cancel a scheduled action before it executes. Admin-only.
    pub fn cancel_pending_action(
        env: Env,
        admin: Address,
        action_id: u64,
    ) -> Result<(), ReputationError> {
        admin.require_auth();
        let config: VerifierConfig = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "config"))
            .expect("config");
        if config.admin != admin {
            return Err(ReputationError::Unauthorized);
        }
        let mut entry: PendingActionEntry = env
            .storage()
            .persistent()
            .get(&pending_action_key(&env, action_id))
            .ok_or(ReputationError::ActionNotFound)?;
        if entry.executed || entry.cancelled {
            return Err(ReputationError::ActionAlreadyFinalized);
        }
        history.push_back(root.clone());
        env.storage().instance().set(&history_key(&env), &history);
        env.storage()
            .instance()
            .set(&last_root_update_key(&env), &ledger);
        entry.cancelled = true;
        env.storage()
            .persistent()
            .set(&pending_action_key(&env, action_id), &entry);
        env.events().publish(
            (Symbol::new(&env, "ActionCancelled"), EVENT_VERSION),
            (action_id, admin),
        );
        Ok(())
    }

    /// Execute a scheduled action once its timelock delay has elapsed. Admin-only.
    pub fn execute_pending_action(
        env: Env,
        admin: Address,
        action_id: u64,
    ) -> Result<(), ReputationError> {
        admin.require_auth();
        let mut config: VerifierConfig = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "config"))
            .expect("config");
        if config.admin != admin {
            return Err(ReputationError::Unauthorized);
        }
        let mut entry: PendingActionEntry = env
            .storage()
            .persistent()
            .get(&pending_action_key(&env, action_id))
            .ok_or(ReputationError::ActionNotFound)?;
        if entry.executed || entry.cancelled {
            return Err(ReputationError::ActionAlreadyFinalized);
        }
        if env.ledger().sequence() < entry.eta_ledger {
            return Err(ReputationError::ActionNotReady);
        }
        match entry.action.clone() {
            PendingAction::UpdateMerkleRoot { root, dataset_hash } => {
                apply_update_merkle_root(&env, &admin, root, dataset_hash)?;
            }
            PendingAction::TransferAdmin { new_admin } => {
                config.admin = new_admin.clone();
                env.storage()
                    .instance()
                    .set(&Symbol::new(&env, "config"), &config);
                env.events().publish(
                    (Symbol::new(&env, "AdminTransferred"), EVENT_VERSION),
                    (new_admin, admin.clone()),
                );
            }
        }
        entry.executed = true;
        env.storage()
            .persistent()
            .set(&pending_action_key(&env, action_id), &entry);
        env.events().publish(
            (Symbol::new(&env, "ActionExecuted"), EVENT_VERSION),
            (action_id, admin),
        );
        Ok(())
    }

    pub fn get_latest_root(env: Env) -> Result<BytesN<32>, ReputationError> {
        let config: VerifierConfig = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "config"))
            .expect("config");
        let history: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&history_key(&env))
            .unwrap_or(Vec::new(&env));
        if history.is_empty() {
            return Err(ReputationError::RootExpired);
        }
        let root = history.get(history.len() - 1).unwrap();
        let entry: MerkleRootEntry = env
            .storage()
            .persistent()
            .get(&root_key(&root))
            .ok_or(ReputationError::RootExpired)?;
        let ledger = env.ledger().sequence();
        if ledger.saturating_sub(entry.ledger) > config.root_expiry_ledgers {
            return Err(ReputationError::RootExpired);
        }
        Ok(root)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn verify_reputation(
        env: Env,
        user: Address,
        groth16_verifier: Address,
        proof_a: BytesN<64>,
        proof_b: BytesN<128>,
        proof_c: BytesN<64>,
        root: BytesN<32>,
        attestation_id: u64,
        external_nullifier: u64,
        nullifier: BytesN<32>,
        expiration_ledger: u32,
    ) -> Result<(), ReputationError> {
        user.require_auth();
        let config: VerifierConfig = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "config"))
            .expect("config");
        if config.groth16_verifier != groth16_verifier {
            return Err(ReputationError::Unauthorized);
        }
        let root_entry: MerkleRootEntry = env
            .storage()
            .persistent()
            .get(&root_key(&root))
            .ok_or(ReputationError::RootExpired)?;
        let ledger = env.ledger().sequence();
        if ledger.saturating_sub(root_entry.ledger) > config.root_expiry_ledgers {
            return Err(ReputationError::RootExpired);
        }
        if expiration_ledger != 0 && ledger > expiration_ledger {
            return Err(ReputationError::AttestationExpired);
        }
        if env.storage().persistent().has(&nullifier_key(&nullifier)) {
            return Err(ReputationError::NullifierUsed);
        }

        // V1 public signal order (canonical — see docs/PUBLIC_SIGNALS.md):
        //   [0] nullifier  [1] is_valid (bound to 1)  [2] merkle_root
        //   [3] attestation_id  [4] external_nullifier
        // This MUST match circuits/stealth_attestation.circom and the frontend
        // prover in frontend/src/lib/reputationProver.ts.
        let mut pub_signals = Vec::new(&env);
        pub_signals.push_back(nullifier.clone());
        let mut one = [0u8; 32];
        one[31] = 1;
        pub_signals.push_back(BytesN::from_array(&env, &one));
        pub_signals.push_back(root.clone());
        pub_signals.push_back(BytesN::from_array(&env, &u64_to_be32(attestation_id)));
        pub_signals.push_back(BytesN::from_array(&env, &u64_to_be32(external_nullifier)));

        let valid: bool = env.invoke_contract(
            &groth16_verifier,
            &Symbol::new(&env, "verify_proof"),
            (proof_a, proof_b, proof_c, pub_signals).into_val(&env),
        );
        if !valid {
            return Err(ReputationError::InvalidProof);
        }

        env.storage()
            .persistent()
            .set(&nullifier_key(&nullifier), &NullifierEntry { used: true });

        env.events().publish(
            (Symbol::new(&env, "ReputationVerified"), EVENT_VERSION),
            (attestation_id, nullifier, user, root),
        );
        Ok(())
    }
}

fn u64_to_be32(val: u64) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[24..32].copy_from_slice(&val.to_be_bytes());
    bytes
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        Address, BytesN, Env,
    };

    /// A mock verifier contract that always returns true.
    #[contract]
    struct MockVerifier;

    #[contracterror]
    #[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
    #[repr(u32)]
    pub enum MockVerifierError {
        InvalidPublicSignal = 1,
    }

    #[contractimpl]
    impl MockVerifier {
        pub fn verify_proof(
            _env: Env,
            _proof_a: BytesN<64>,
            _proof_b: BytesN<128>,
            _proof_c: BytesN<64>,
            _pub_signals: Vec<BytesN<32>>,
        ) -> Result<bool, MockVerifierError> {
            Ok(true)
        }
    }

    fn setup() -> (Env, Address, Address, ReputationVerifierClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationVerifier);
        let client = ReputationVerifierClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        (env, admin, contract_id, client)
    }

    fn setup_with_mock() -> (
        Env,
        Address,
        Address,
        ReputationVerifierClient<'static>,
        Address,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationVerifier);
        let client = ReputationVerifierClient::new(&env, &contract_id);
        let admin = Address::generate(&env);

        let mock_id = env.register_contract(None, MockVerifier);
        client.initialize(&admin, &mock_id);
        (env, admin, contract_id, client, mock_id)
    }

    #[test]
    fn test_initialize() {
        let (env, admin, _, client) = setup();
        let groth16_id = Address::generate(&env);
        client.initialize(&admin, &groth16_id);
    }

    #[test]
    fn test_initialize_already_initialized() {
        let (env, admin, _, client) = setup();
        let groth16_id = Address::generate(&env);
        client.initialize(&admin, &groth16_id);
        let result = client.try_initialize(&admin, &groth16_id);
        assert_eq!(result, Err(Ok(ReputationError::AlreadyInitialized)));
    }

    #[test]
    fn test_update_merkle_root() {
        let (env, admin, _, client, mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[1u8; 32]);
        let dataset_hash = BytesN::from_array(&env, &[2u8; 32]);
        client.update_merkle_root(&admin, &root, &dataset_hash);

        let user = Address::generate(&env);
        let nullifier = BytesN::from_array(&env, &[0x99u8; 32]);
        let proof_a = BytesN::from_array(&env, &[0u8; 64]);
        let proof_b = BytesN::from_array(&env, &[0u8; 128]);
        let proof_c = BytesN::from_array(&env, &[0u8; 64]);

        client.verify_reputation(
            &user, &mock_id, &proof_a, &proof_b, &proof_c, &root, &1u64, &1u64, &nullifier, &0u32,
        );
    }

    #[test]
    fn test_update_merkle_root_unauthorized() {
        let (env, _, _, client, _) = setup_with_mock();
        let stranger = Address::generate(&env);
        let root = BytesN::from_array(&env, &[3u8; 32]);
        let dataset_hash = BytesN::from_array(&env, &[4u8; 32]);
        let result = client.try_update_merkle_root(&stranger, &root, &dataset_hash);
        assert_eq!(result, Err(Ok(ReputationError::Unauthorized)));
    }

    #[test]
    fn test_get_latest_root_after_update() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[4u8; 32]);
        let dataset_hash = BytesN::from_array(&env, &[5u8; 32]);
        client.update_merkle_root(&admin, &root, &dataset_hash);

        let latest = client.get_latest_root();
        assert_eq!(latest, root);
    }

    #[test]
    fn test_get_latest_root_empty_history() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, ReputationVerifier);
        let client = ReputationVerifierClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        client.initialize(&admin, &verifier);

        let result = client.try_get_latest_root();
        assert_eq!(result, Err(Ok(ReputationError::RootExpired)));
    }

    #[test]
    fn test_verify_reputation_root_not_published() {
        let (env, _, _, client, mock_id) = setup_with_mock();
        let user = Address::generate(&env);
        let unknown_root = BytesN::from_array(&env, &[0x11u8; 32]);
        let nullifier = BytesN::from_array(&env, &[0x22u8; 32]);
        let proof_a = BytesN::from_array(&env, &[0u8; 64]);
        let proof_b = BytesN::from_array(&env, &[0u8; 128]);
        let proof_c = BytesN::from_array(&env, &[0u8; 64]);

        let result = client.try_verify_reputation(
            &user,
            &mock_id,
            &proof_a,
            &proof_b,
            &proof_c,
            &unknown_root,
            &1u64,
            &1u64,
            &nullifier,
            &0u32,
        );
        assert_eq!(result, Err(Ok(ReputationError::RootExpired)));
    }

    #[test]
    fn test_verify_reputation_nullifier_reuse() {
        let (env, admin, _, client, mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0xAAu8; 32]);
        let dataset_hash = BytesN::from_array(&env, &[0xBBu8; 32]);
        client.update_merkle_root(&admin, &root, &dataset_hash);

        let user = Address::generate(&env);
        let nullifier = BytesN::from_array(&env, &[0xCCu8; 32]);
        let proof_a = BytesN::from_array(&env, &[0u8; 64]);
        let proof_b = BytesN::from_array(&env, &[0u8; 128]);
        let proof_c = BytesN::from_array(&env, &[0u8; 64]);

        client.verify_reputation(
            &user, &mock_id, &proof_a, &proof_b, &proof_c, &root, &1u64, &1u64, &nullifier, &0u32,
        );

        let result = client.try_verify_reputation(
            &user, &mock_id, &proof_a, &proof_b, &proof_c, &root, &1u64, &1u64, &nullifier, &0u32,
        );
        assert_eq!(result, Err(Ok(ReputationError::NullifierUsed)));
    }

    #[test]
    fn test_are_nullifiers_spent_returns_status_in_order() {
        let (env, admin, _, client, mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0xABu8; 32]);
        client.update_merkle_root(&admin, &root, &BytesN::from_array(&env, &[0xBCu8; 32]));

        let user = Address::generate(&env);
        let spent = BytesN::from_array(&env, &[0x10u8; 32]);
        let unspent = BytesN::from_array(&env, &[0x11u8; 32]);
        client.verify_reputation(
            &user,
            &mock_id,
            &BytesN::from_array(&env, &[0u8; 64]),
            &BytesN::from_array(&env, &[0u8; 128]),
            &BytesN::from_array(&env, &[0u8; 64]),
            &root,
            &1u64,
            &1u64,
            &spent,
            &0u32,
        );

        let mut ids = Vec::new(&env);
        ids.push_back(unspent);
        ids.push_back(spent);
        let statuses = client.are_nullifiers_spent(&ids);
        assert_eq!(statuses.len(), 2);
        assert!(!statuses.get(0).unwrap());
        assert!(statuses.get(1).unwrap());
    }

    #[test]
    fn test_are_nullifiers_spent_enforces_batch_limit() {
        let (env, _, _, client, _) = setup_with_mock();
        let mut ids = Vec::new(&env);
        for i in 0..(MAX_NULLIFIER_BATCH_SIZE + 1) {
            ids.push_back(BytesN::from_array(&env, &[i as u8; 32]));
        }
        let result = client.try_are_nullifiers_spent(&ids);
        assert_eq!(result, Err(Ok(ReputationError::BatchTooLarge)));
    }

    #[test]
    fn test_verify_reputation_attestation_expired() {
        let (env, admin, _, client, mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0xDDu8; 32]);
        let dataset_hash = BytesN::from_array(&env, &[0xEEu8; 32]);
        client.update_merkle_root(&admin, &root, &dataset_hash);

        let user = Address::generate(&env);
        let nullifier = BytesN::from_array(&env, &[0xFFu8; 32]);
        let proof_a = BytesN::from_array(&env, &[0u8; 64]);
        let proof_b = BytesN::from_array(&env, &[0u8; 128]);
        let proof_c = BytesN::from_array(&env, &[0u8; 64]);

        env.ledger().set_sequence_number(100);
        let result = client.try_verify_reputation(
            &user, &mock_id, &proof_a, &proof_b, &proof_c, &root, &1u64, &1u64, &nullifier, &50u32,
        );
        assert_eq!(result, Err(Ok(ReputationError::AttestationExpired)));
    }

    #[test]
    fn test_verify_reputation_wrong_verifier_address() {
        let (env, admin, _, client, _) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0x33u8; 32]);
        let dataset_hash = BytesN::from_array(&env, &[0x44u8; 32]);
        client.update_merkle_root(&admin, &root, &dataset_hash);

        let user = Address::generate(&env);
        let nullifier = BytesN::from_array(&env, &[0x55u8; 32]);
        let proof_a = BytesN::from_array(&env, &[0u8; 64]);
        let proof_b = BytesN::from_array(&env, &[0u8; 128]);
        let proof_c = BytesN::from_array(&env, &[0u8; 64]);
        let wrong_verifier = Address::generate(&env);

        let result = client.try_verify_reputation(
            &user,
            &wrong_verifier,
            &proof_a,
            &proof_b,
            &proof_c,
            &root,
            &1u64,
            &1u64,
            &nullifier,
            &0u32,
        );
        assert_eq!(result, Err(Ok(ReputationError::Unauthorized)));
    }

    #[test]
    fn test_full_lifecycle_with_mock_verifier() {
        let (env, admin, _, client, mock_id) = setup_with_mock();

        // 1. Publish merkle root
        let root = BytesN::from_array(&env, &[0xAAu8; 32]);
        let dataset_hash = BytesN::from_array(&env, &[0xBBu8; 32]);
        client.update_merkle_root(&admin, &root, &dataset_hash);

        // 2. Verify reputation (first time — succeeds)
        let user = Address::generate(&env);
        let nullifier = BytesN::from_array(&env, &[0xCCu8; 32]);
        let proof_a = BytesN::from_array(&env, &[0u8; 64]);
        let proof_b = BytesN::from_array(&env, &[0u8; 128]);
        let proof_c = BytesN::from_array(&env, &[0u8; 64]);

        client.verify_reputation(
            &user, &mock_id, &proof_a, &proof_b, &proof_c, &root, &42u64, &1u64, &nullifier, &0u32,
        );

        // 3. Replay with same nullifier — rejected
        let result = client.try_verify_reputation(
            &user, &mock_id, &proof_a, &proof_b, &proof_c, &root, &42u64, &1u64, &nullifier, &0u32,
        );
        assert_eq!(result, Err(Ok(ReputationError::NullifierUsed)));

        // 4. Different nullifier — succeeds again
        let nullifier2 = BytesN::from_array(&env, &[0xDDu8; 32]);
        client.verify_reputation(
            &user,
            &mock_id,
            &proof_a,
            &proof_b,
            &proof_c,
            &root,
            &42u64,
            &1u64,
            &nullifier2,
            &0u32,
        );
    }

    #[test]
    fn test_update_merkle_root_caps_history() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();

        for i in 0u8..105u8 {
            let root = BytesN::from_array(&env, &[i; 32]);
            let _ = client.try_update_merkle_root(&admin, &root, &root);
        }

        let latest = client.get_latest_root();
        let expected = BytesN::from_array(&env, &[104u8; 32]);
        assert_eq!(latest, expected);
    }

    // ── Issue #78: external nullifier domain separation ──────────

    #[test]
    fn test_compute_external_nullifier_different_for_different_inputs() {
        let en1 = compute_external_nullifier(1, 1);
        let en2 = compute_external_nullifier(1, 2);
        let en3 = compute_external_nullifier(2, 1);
        assert_ne!(
            en1, en2,
            "action_id change must produce different nullifier"
        );
        assert_ne!(en1, en3, "app_id change must produce different nullifier");
        assert_ne!(en2, en3);
    }

    #[test]
    fn test_compute_external_nullifier_deterministic() {
        assert_eq!(
            compute_external_nullifier(0xDEADBEEF, 42),
            compute_external_nullifier(0xDEADBEEF, 42),
        );
    }

    #[test]
    fn test_compute_external_nullifier_zero_inputs_distinct() {
        let en_00 = compute_external_nullifier(0, 0);
        let en_01 = compute_external_nullifier(0, 1);
        let en_10 = compute_external_nullifier(1, 0);
        assert_ne!(en_00, en_01);
        assert_ne!(en_00, en_10);
        assert_ne!(en_01, en_10);
    }

    // ── Issue #79: proof replay protection tests ─────────────────

    #[test]
    fn test_replay_same_nullifier_different_external_nullifier_still_rejected() {
        let (env, admin, _, client, mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0xA1u8; 32]);
        client.update_merkle_root(&admin, &root, &BytesN::from_array(&env, &[0xB1u8; 32]));

        let user = Address::generate(&env);
        let nullifier = BytesN::from_array(&env, &[0xC1u8; 32]);
        let proof_a = BytesN::from_array(&env, &[0u8; 64]);
        let proof_b = BytesN::from_array(&env, &[0u8; 128]);
        let proof_c = BytesN::from_array(&env, &[0u8; 64]);

        let ext1 = compute_external_nullifier(1, 1);
        let ext2 = compute_external_nullifier(1, 2);

        // First verify with ext1 succeeds
        client.verify_reputation(
            &user, &mock_id, &proof_a, &proof_b, &proof_c, &root, &1u64, &ext1, &nullifier, &0u32,
        );

        // Same nullifier hash with different external_nullifier is still rejected —
        // replay protection is per nullifier_hash, not per (ext_nullifier, nullifier_hash) pair.
        let result = client.try_verify_reputation(
            &user, &mock_id, &proof_a, &proof_b, &proof_c, &root, &1u64, &ext2, &nullifier, &0u32,
        );
        assert_eq!(result, Err(Ok(ReputationError::NullifierUsed)));
    }

    #[test]
    fn test_replay_different_nullifier_same_external_nullifier_succeeds() {
        let (env, admin, _, client, mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0xA2u8; 32]);
        client.update_merkle_root(&admin, &root, &BytesN::from_array(&env, &[0xB2u8; 32]));

        let user = Address::generate(&env);
        let proof_a = BytesN::from_array(&env, &[0u8; 64]);
        let proof_b = BytesN::from_array(&env, &[0u8; 128]);
        let proof_c = BytesN::from_array(&env, &[0u8; 64]);
        let ext = compute_external_nullifier(10, 5);

        let nullifier1 = BytesN::from_array(&env, &[0xD1u8; 32]);
        let nullifier2 = BytesN::from_array(&env, &[0xD2u8; 32]);

        client.verify_reputation(
            &user,
            &mock_id,
            &proof_a,
            &proof_b,
            &proof_c,
            &root,
            &1u64,
            &ext,
            &nullifier1,
            &0u32,
        );
        // Different nullifier with same external_nullifier is allowed
        client.verify_reputation(
            &user,
            &mock_id,
            &proof_a,
            &proof_b,
            &proof_c,
            &root,
            &1u64,
            &ext,
            &nullifier2,
            &0u32,
        );
    }

    #[test]
    fn test_replay_same_nullifier_different_users_rejected() {
        let (env, admin, _, client, mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0xA3u8; 32]);
        client.update_merkle_root(&admin, &root, &BytesN::from_array(&env, &[0xB3u8; 32]));

        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let proof_a = BytesN::from_array(&env, &[0u8; 64]);
        let proof_b = BytesN::from_array(&env, &[0u8; 128]);
        let proof_c = BytesN::from_array(&env, &[0u8; 64]);
        let nullifier = BytesN::from_array(&env, &[0xE1u8; 32]);
        let ext = compute_external_nullifier(99, 1);

        client.verify_reputation(
            &user1, &mock_id, &proof_a, &proof_b, &proof_c, &root, &1u64, &ext, &nullifier, &0u32,
        );

        // Different user attempting to reuse the same nullifier hash is rejected
        let result = client.try_verify_reputation(
            &user2, &mock_id, &proof_a, &proof_b, &proof_c, &root, &1u64, &ext, &nullifier, &0u32,
        );
        assert_eq!(result, Err(Ok(ReputationError::NullifierUsed)));
    }

    // ── Issue #80: configurable root expiry ───────────────────────

    #[test]
    fn test_set_root_expiry_by_admin_succeeds() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0xF1u8; 32]);
        client.update_merkle_root(&admin, &root, &BytesN::from_array(&env, &[0xF2u8; 32]));

        // Shorten expiry to 10 ledgers
        client.set_root_expiry(&admin, &10u32);

        // Advance 11 ledgers — root should now be expired
        env.ledger().set_sequence_number(11);
        let result = client.try_get_latest_root();
        assert_eq!(result, Err(Ok(ReputationError::RootExpired)));
    }

    #[test]
    fn test_set_root_expiry_extends_validity() {
        let (env, admin, _, client, mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0xF3u8; 32]);
        client.update_merkle_root(&admin, &root, &BytesN::from_array(&env, &[0xF4u8; 32]));

        // Shorten expiry to 20 ledgers, then advance 15 — still valid
        client.set_root_expiry(&admin, &20u32);
        env.ledger().set_sequence_number(15);
        let latest = client.get_latest_root();
        assert_eq!(latest, root);

        // Extend expiry to 50 ledgers, then advance to 40 — still valid
        client.set_root_expiry(&admin, &50u32);
        env.ledger().set_sequence_number(40);
        let latest2 = client.get_latest_root();
        assert_eq!(latest2, root);

        // Can still verify
        let user = Address::generate(&env);
        let nullifier = BytesN::from_array(&env, &[0xE5u8; 32]);
        client.verify_reputation(
            &user,
            &mock_id,
            &BytesN::from_array(&env, &[0u8; 64]),
            &BytesN::from_array(&env, &[0u8; 128]),
            &BytesN::from_array(&env, &[0u8; 64]),
            &root,
            &1u64,
            &1u64,
            &nullifier,
            &0u32,
        );
    }

    #[test]
    fn test_set_root_expiry_unauthorized_rejected() {
        let (env, _, _, client, _mock_id) = setup_with_mock();
        let stranger = Address::generate(&env);
        let result = client.try_set_root_expiry(&stranger, &500u32);
        assert_eq!(result, Err(Ok(ReputationError::Unauthorized)));
    }

    // ── Issue #81: paginated root history ─────────────────────────

    #[test]
    fn test_get_root_history_empty() {
        let (env, admin, _, client) = setup();
        let verifier = Address::generate(&env);
        client.initialize(&admin, &verifier);
        let history = client.get_root_history(&0u32, &10u32);
        assert_eq!(history.len(), 0);
    }

    #[test]
    fn test_get_root_history_pagination() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();

        for i in 0u8..10u8 {
            let root = BytesN::from_array(&env, &[i; 32]);
            client.update_merkle_root(&admin, &root, &root);
        }

        // First page: indices 0-2
        let page0 = client.get_root_history(&0u32, &3u32);
        assert_eq!(page0.len(), 3);
        assert_eq!(page0.get(0).unwrap(), BytesN::from_array(&env, &[0u8; 32]));
        assert_eq!(page0.get(2).unwrap(), BytesN::from_array(&env, &[2u8; 32]));

        // Second page: indices 3-5
        let page1 = client.get_root_history(&3u32, &3u32);
        assert_eq!(page1.len(), 3);
        assert_eq!(page1.get(0).unwrap(), BytesN::from_array(&env, &[3u8; 32]));

        // Offset past end returns empty
        let page_empty = client.get_root_history(&100u32, &10u32);
        assert_eq!(page_empty.len(), 0);

        // Partial last page
        let page_tail = client.get_root_history(&8u32, &10u32);
        assert_eq!(page_tail.len(), 2);
    }

    #[test]
    fn test_get_root_history_respects_cap() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();

        for i in 0u8..105u8 {
            let root = BytesN::from_array(&env, &[i; 32]);
            let _ = client.try_update_merkle_root(&admin, &root, &root);
        }

        // History is capped at MAX_ROOT_HISTORY (100)
        let all = client.get_root_history(&0u32, &200u32);
        assert_eq!(all.len(), 100u32);
    }

    #[test]
    fn test_is_frozen_defaults_to_false() {
        let (env, _, _, client, _) = setup_with_mock();
        let _ = env;
        assert!(!client.is_frozen());
    }

    #[test]
    fn test_set_frozen_by_admin_succeeds() {
        let (env, admin, _, client, _) = setup_with_mock();
        let _ = env;
        client.set_frozen(&admin, &true);
        assert!(client.is_frozen());
        client.set_frozen(&admin, &false);
        assert!(!client.is_frozen());
    }

    #[test]
    fn test_set_frozen_unauthorized_rejected() {
        let (env, _, _, client, _) = setup_with_mock();
        let impostor = Address::generate(&env);
        env.mock_all_auths();
        let result = client.try_set_frozen(&impostor, &true);
        assert_eq!(result, Err(Ok(ReputationError::Unauthorized)));
    }

    #[test]
    fn test_update_merkle_root_blocked_when_frozen() {
        let (env, admin, _, client, _) = setup_with_mock();
        let _ = env;
        client.set_frozen(&admin, &true);
        let root = BytesN::from_array(&env, &[0xaau8; 32]);
        let result = client.try_update_merkle_root(&admin, &root, &root);
        assert_eq!(result, Err(Ok(ReputationError::ContractFrozen)));
    }

    #[test]
    fn test_update_merkle_root_succeeds_after_unfreeze() {
        let (env, admin, _, client, _) = setup_with_mock();
        client.set_frozen(&admin, &true);
        client.set_frozen(&admin, &false);
        let root = BytesN::from_array(&env, &[0xbbu8; 32]);
        client.update_merkle_root(&admin, &root, &root);
        assert!(!client.is_frozen());
    }

    #[test]
    fn test_last_root_update_is_zero_before_any_publish() {
        let (env, _, _, client, _) = setup_with_mock();
        let _ = env;
        assert_eq!(client.last_root_update(), 0u32);
    }

    #[test]
    fn test_last_root_update_reflects_ledger_after_publish() {
        let (env, admin, _, client, _) = setup_with_mock();
        env.ledger().set_sequence_number(42);
        let root = BytesN::from_array(&env, &[0xccu8; 32]);
        client.update_merkle_root(&admin, &root, &root);
        assert_eq!(client.last_root_update(), 42u32);
    }

    #[test]
    fn test_last_root_update_tracks_latest_publish() {
        let (env, admin, _, client, _) = setup_with_mock();
        env.ledger().set_sequence_number(10);
        let root1 = BytesN::from_array(&env, &[0x01u8; 32]);
        client.update_merkle_root(&admin, &root1, &root1);
        env.ledger().set_sequence_number(20);
        let root2 = BytesN::from_array(&env, &[0x02u8; 32]);
        client.update_merkle_root(&admin, &root2, &root2);
        assert_eq!(client.last_root_update(), 20u32);
    }

    // ── Issue #380: optional timelock for sensitive admin actions ─────────

    #[test]
    fn test_timelock_delay_defaults_to_zero_disabled() {
        let (env, _, _, client, _) = setup_with_mock();
        let _ = env;
        assert_eq!(client.get_timelock_delay(), 0u32);
    }

    #[test]
    fn test_set_timelock_delay_unauthorized_rejected() {
        let (env, _, _, client, _) = setup_with_mock();
        let stranger = Address::generate(&env);
        let result = client.try_set_timelock_delay(&stranger, &100u32);
        assert_eq!(result, Err(Ok(ReputationError::Unauthorized)));
    }

    #[test]
    fn test_update_merkle_root_unaffected_when_timelock_disabled() {
        // Default (delay == 0) keeps existing direct-call behavior — no breaking change.
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0x10u8; 32]);
        client.update_merkle_root(&admin, &root, &root);
        assert_eq!(client.get_latest_root(), root);
    }

    #[test]
    fn test_update_merkle_root_blocked_when_timelock_enabled() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        client.set_timelock_delay(&admin, &50u32);
        let root = BytesN::from_array(&env, &[0x11u8; 32]);
        let result = client.try_update_merkle_root(&admin, &root, &root);
        assert_eq!(result, Err(Ok(ReputationError::TimelockEnabled)));
    }

    #[test]
    fn test_transfer_admin_blocked_when_timelock_enabled() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        client.set_timelock_delay(&admin, &50u32);
        let new_admin = Address::generate(&env);
        let result = client.try_transfer_admin(&admin, &new_admin);
        assert_eq!(result, Err(Ok(ReputationError::TimelockEnabled)));
    }

    #[test]
    fn test_transfer_admin_immediate_when_timelock_disabled() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        let new_admin = Address::generate(&env);
        client.transfer_admin(&admin, &new_admin);
        // Old admin no longer authorized for admin-only calls.
        let result = client.try_set_timelock_delay(&admin, &10u32);
        assert_eq!(result, Err(Ok(ReputationError::Unauthorized)));
        // New admin is authorized.
        client.set_timelock_delay(&new_admin, &10u32);
    }

    #[test]
    fn test_schedule_update_merkle_root_requires_timelock_enabled() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        let root = BytesN::from_array(&env, &[0x12u8; 32]);
        let result = client.try_schedule_update_merkle_root(&admin, &root, &root);
        assert_eq!(result, Err(Ok(ReputationError::TimelockNotEnabled)));
    }

    #[test]
    fn test_schedule_and_execute_update_merkle_root() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        client.set_timelock_delay(&admin, &10u32);
        env.ledger().set_sequence_number(100);

        let root = BytesN::from_array(&env, &[0x13u8; 32]);
        let action_id = client.schedule_update_merkle_root(&admin, &root, &root);

        // Not ready yet.
        let result = client.try_execute_pending_action(&admin, &action_id);
        assert_eq!(result, Err(Ok(ReputationError::ActionNotReady)));

        // Advance past the delay.
        env.ledger().set_sequence_number(111);
        client.execute_pending_action(&admin, &action_id);
        assert_eq!(client.get_latest_root(), root);

        // Cannot execute twice.
        let result = client.try_execute_pending_action(&admin, &action_id);
        assert_eq!(result, Err(Ok(ReputationError::ActionAlreadyFinalized)));
    }

    #[test]
    fn test_schedule_and_execute_admin_transfer() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        client.set_timelock_delay(&admin, &5u32);
        env.ledger().set_sequence_number(10);

        let new_admin = Address::generate(&env);
        let action_id = client.schedule_admin_transfer(&admin, &new_admin);

        env.ledger().set_sequence_number(16);
        client.execute_pending_action(&admin, &action_id);

        // Old admin no longer authorized; new admin is.
        let result = client.try_set_timelock_delay(&admin, &1u32);
        assert_eq!(result, Err(Ok(ReputationError::Unauthorized)));
        client.set_timelock_delay(&new_admin, &1u32);
    }

    #[test]
    fn test_cancel_pending_action() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        client.set_timelock_delay(&admin, &5u32);
        let root = BytesN::from_array(&env, &[0x14u8; 32]);
        let action_id = client.schedule_update_merkle_root(&admin, &root, &root);

        client.cancel_pending_action(&admin, &action_id);

        env.ledger().set_sequence_number(1000);
        let result = client.try_execute_pending_action(&admin, &action_id);
        assert_eq!(result, Err(Ok(ReputationError::ActionAlreadyFinalized)));
    }

    #[test]
    fn test_cancel_pending_action_unauthorized_rejected() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        client.set_timelock_delay(&admin, &5u32);
        let root = BytesN::from_array(&env, &[0x15u8; 32]);
        let action_id = client.schedule_update_merkle_root(&admin, &root, &root);

        let stranger = Address::generate(&env);
        let result = client.try_cancel_pending_action(&stranger, &action_id);
        assert_eq!(result, Err(Ok(ReputationError::Unauthorized)));
    }

    #[test]
    fn test_execute_pending_action_not_found() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        let result = client.try_execute_pending_action(&admin, &999u64);
        assert_eq!(result, Err(Ok(ReputationError::ActionNotFound)));
    }

    #[test]
    fn test_get_pending_action_returns_scheduled_entry() {
        let (env, admin, _, client, _mock_id) = setup_with_mock();
        client.set_timelock_delay(&admin, &7u32);
        env.ledger().set_sequence_number(50);
        let new_admin = Address::generate(&env);
        let action_id = client.schedule_admin_transfer(&admin, &new_admin);

        let entry = client.get_pending_action(&action_id);
        assert_eq!(entry.eta_ledger, 57u32);
        assert!(!entry.executed);
        assert!(!entry.cancelled);
    }

    // ── Issue #379: footprint regression test for the `verify_reputation` hot path ──
    //
    // Baseline fixture: ceilings below are an initial, intentionally generous
    // budget for `verify_reputation` against the mock Groth16 verifier used
    // in unit tests, pending the first real CI run (see the matching comment
    // in attestation-engine-v2's footprint test for the recalibration plan).
    // Worst case in production is dominated by the real `groth16-verifier`
    // contract's pairing check, which this mock does not exercise — that
    // cross-contract cost should be tracked separately in
    // `groth16-verifier`'s own test suite.
    mod footprint {
        use super::*;

        const VERIFY_CPU_INSNS_CEILING: u64 = 50_000_000;
        const VERIFY_MEM_BYTES_CEILING: u64 = 20_000_000;

        #[test]
        fn footprint_verify_reputation_within_ceiling() {
            let (env, admin, _, client, mock_id) = setup_with_mock();
            let root = BytesN::from_array(&env, &[0x20u8; 32]);
            client.update_merkle_root(&admin, &root, &root);

            let user = Address::generate(&env);
            let nullifier = BytesN::from_array(&env, &[0x21u8; 32]);
            let proof_a = BytesN::from_array(&env, &[0u8; 64]);
            let proof_b = BytesN::from_array(&env, &[0u8; 128]);
            let proof_c = BytesN::from_array(&env, &[0u8; 64]);

            // Reset accounting so setup (root publication) isn't counted.
            env.budget().reset_default();
            client.verify_reputation(
                &user, &mock_id, &proof_a, &proof_b, &proof_c, &root, &1u64, &1u64, &nullifier,
                &0u32,
            );
            let cpu = env.budget().cpu_instruction_cost();
            let mem = env.budget().memory_bytes_cost();

            assert!(
                cpu <= VERIFY_CPU_INSNS_CEILING,
                "verify_reputation cpu_insns={cpu} exceeds baseline ceiling={VERIFY_CPU_INSNS_CEILING} \
                 — investigate before raising the ceiling"
            );
            assert!(
                mem <= VERIFY_MEM_BYTES_CEILING,
                "verify_reputation mem_bytes={mem} exceeds baseline ceiling={VERIFY_MEM_BYTES_CEILING} \
                 — investigate before raising the ceiling"
            );
        }
    }
}
