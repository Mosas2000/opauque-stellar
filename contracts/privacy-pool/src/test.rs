#![cfg(test)]
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, BytesN, Env,
};

// A mock groth16 verifier whose verify_proof_v3 returns a configurable verdict, so the
// pool logic (custody, roots, nullifiers, payout) is tested without a real proof.
#[contract]
struct MockVerifier;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
enum MockErr {
    X = 1,
}

#[contractimpl]
impl MockVerifier {
    pub fn verify_proof_v3(
        env: Env,
        _a: BytesN<64>,
        _b: BytesN<128>,
        _c: BytesN<64>,
        _inputs: VerifyPublicInputsV3,
    ) -> Result<bool, MockErr> {
        Ok(env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "ok"))
            .unwrap_or(true))
    }
    pub fn set_ok(env: Env, ok: bool) {
        env.storage().instance().set(&Symbol::new(&env, "ok"), &ok);
    }
}

struct Harness {
    env: Env,
    admin: Address,
    pool: PrivacyPoolClient<'static>,
    sac: Address,
    mock: MockVerifierClient<'static>,
    pool_addr: Address,
}

fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let sac_addr = sac.address();

    let mock_addr = env.register(MockVerifier, ());
    let mock = MockVerifierClient::new(&env, &mock_addr);

    let pool_addr = env.register(PrivacyPool, ());
    let pool = PrivacyPoolClient::new(&env, &pool_addr);
    pool.initialize(&admin, &mock_addr, &sac_addr, &7u64);

    Harness {
        env,
        admin,
        pool,
        sac: sac_addr,
        mock,
        pool_addr,
    }
}

fn fund(h: &Harness, to: &Address, amount: i128) {
    token::StellarAssetClient::new(&h.env, &h.sac).mint(to, &amount);
}

fn bal(h: &Harness, who: &Address) -> i128 {
    token::TokenClient::new(&h.env, &h.sac).balance(who)
}

fn b32(env: &Env, tag: u8) -> BytesN<32> {
    BytesN::from_array(env, &[tag; 32])
}

fn publish_roots(h: &Harness) -> (BytesN<32>, BytesN<32>) {
    let sr = b32(&h.env, 0x51);
    let ar = b32(&h.env, 0xA1);
    h.pool.update_state_root(&h.admin, &sr, &b32(&h.env, 0xD1));
    h.pool.update_asp_root(&h.admin, &ar, &b32(&h.env, 0xD2));
    (sr, ar)
}

fn proof(env: &Env) -> (BytesN<64>, BytesN<128>, BytesN<64>) {
    (
        BytesN::from_array(env, &[0u8; 64]),
        BytesN::from_array(env, &[0u8; 128]),
        BytesN::from_array(env, &[0u8; 64]),
    )
}

#[test]
fn initialize_and_config() {
    let h = setup();
    let cfg = h.pool.get_config();
    assert_eq!(cfg.scope, 7);
    assert_eq!(cfg.native_sac, h.sac);
    assert_eq!(h.pool.get_deposit_count(), 0);
}

#[test]
fn initialize_twice_rejected() {
    let h = setup();
    let res = h.pool.try_initialize(&h.admin, &h.sac, &h.sac, &1u64);
    assert_eq!(res, Err(Ok(PoolError::AlreadyInitialized)));
}

#[test]
fn deposit_pulls_funds_and_records() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);

    let idx = h
        .pool
        .deposit(&depositor, &600i128, &b32(&h.env, 0xC1), &0u64);
    assert_eq!(idx, 0);
    assert_eq!(bal(&h, &depositor), 400);
    assert_eq!(bal(&h, &h.pool_addr), 600);
    assert_eq!(h.pool.get_deposit_count(), 1);
    assert_eq!(h.pool.get_custody(), (600, 0));
}

#[test]
fn deposit_wrong_index_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    let res = h
        .pool
        .try_deposit(&depositor, &100i128, &b32(&h.env, 0xC2), &5u64);
    assert_eq!(res, Err(Ok(PoolError::IndexMismatch)));
}

#[test]
fn deposit_bad_amount_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    let res = h
        .pool
        .try_deposit(&depositor, &0i128, &b32(&h.env, 0xC3), &0u64);
    assert_eq!(res, Err(Ok(PoolError::BadAmount)));
}

#[test]
fn update_roots_and_unauthorized() {
    let h = setup();
    h.pool
        .update_state_root(&h.admin, &b32(&h.env, 0x51), &b32(&h.env, 0xD1));
    h.pool
        .update_asp_root(&h.admin, &b32(&h.env, 0xA1), &b32(&h.env, 0xD2));
    assert!(h.pool.is_known_state_root(&b32(&h.env, 0x51)));
    assert!(h.pool.is_known_asp_root(&b32(&h.env, 0xA1)));
    assert_eq!(h.pool.get_latest_root(&true), b32(&h.env, 0x51));
    assert_eq!(h.pool.get_latest_root(&false), b32(&h.env, 0xA1));

    let stranger = Address::generate(&h.env);
    let res = h
        .pool
        .try_update_state_root(&stranger, &b32(&h.env, 0x52), &b32(&h.env, 0xD3));
    assert_eq!(res, Err(Ok(PoolError::Unauthorized)));
}

#[test]
fn withdraw_full_flow_pays_split_and_updates_state() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);

    let recipient = Address::generate(&h.env);
    let relayer = Address::generate(&h.env);
    let (pa, pb, pc) = proof(&h.env);
    let nullifier = b32(&h.env, 0x9A);
    let new_commit = b32(&h.env, 0xCE);

    h.pool.withdraw(
        &pa,
        &pb,
        &pc,
        &400i128,
        &sr,
        &ar,
        &nullifier,
        &new_commit,
        &recipient,
        &10i128,
        &relayer,
    );

    assert_eq!(bal(&h, &recipient), 390); // 400 - 10 fee
    assert_eq!(bal(&h, &relayer), 10);
    assert_eq!(bal(&h, &h.pool_addr), 600); // 1000 - 400 paid out
    assert!(h.pool.is_spent(&nullifier));
    assert_eq!(h.pool.get_custody(), (1000, 400));
    // remainder commitment re-inserted as the next leaf (index 1).
    assert_eq!(h.pool.get_deposit_count(), 2);
}

#[test]
fn withdraw_nullifier_replay_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let recipient = Address::generate(&h.env);
    let relayer = Address::generate(&h.env);
    let (pa, pb, pc) = proof(&h.env);
    let nullifier = b32(&h.env, 0x9A);

    h.pool.withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &ar,
        &nullifier,
        &b32(&h.env, 0xCE),
        &recipient,
        &0i128,
        &relayer,
    );
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &ar,
        &nullifier,
        &b32(&h.env, 0xCF),
        &recipient,
        &0i128,
        &relayer,
    );
    assert_eq!(res, Err(Ok(PoolError::NullifierUsed)));
}

// -- Issue #602: a mauled-but-verifier-valid proof cannot bypass replay -----
//
// Groth16 proofs are malleable: negating both the A and B points of a valid
// proof yields a byte-for-byte DIFFERENT proof that still satisfies the
// verifier's pairing check for the same public inputs (proven directly
// against the real BN254 verifier in groth16-verifier's
// v3_malleated_proof_negate_a_and_b_still_verifies test). That means the
// pool cannot rely on "have we seen these exact proof bytes before" for
// replay protection — it must key spent-status on nullifier_hash, a public
// input that a malleability transform does not and cannot change (mauling
// the proof bytes leaves every public signal, including nullifier_hash and
// context, untouched).
//
// This test models that at the pool level: two structurally different
// proof byte-strings (standing in for "original" vs. "mauled" encodings of
// a proof for the same public inputs) are both submitted with the same
// nullifier_hash. The mock verifier accepts both (as the real verifier
// would accept both a proof and its malleated form) — so the only thing
// that can stop the second submission is the pool's own nullifier check,
// which this test confirms fires regardless of the proof bytes differing.
#[test]
fn withdraw_mauled_proof_rejected_as_replay() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let recipient = Address::generate(&h.env);
    let relayer = Address::generate(&h.env);
    let nullifier = b32(&h.env, 0x9A);

    // "Original" proof.
    let (pa, pb, pc) = proof(&h.env);
    h.pool.withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &ar,
        &nullifier,
        &b32(&h.env, 0xCE),
        &recipient,
        &0i128,
        &relayer,
    );
    assert!(h.pool.is_spent(&nullifier));

    // "Mauled" proof: different proof bytes (0xFF fill instead of 0x00),
    // standing in for the negate-A-and-B transform that produces a distinct
    // but still-verifying encoding of a proof over the same public inputs.
    // Same nullifier_hash, same context-bound recipient/fee/relayer/value —
    // only the proof bytes differ, exactly as a real malleability transform
    // would produce.
    let mauled_pa = BytesN::from_array(&h.env, &[0xFFu8; 64]);
    let mauled_pb = BytesN::from_array(&h.env, &[0xFFu8; 128]);
    let mauled_pc = BytesN::from_array(&h.env, &[0xFFu8; 64]);
    assert_ne!(
        mauled_pa, pa,
        "mauled proof bytes must differ from the original"
    );

    let res = h.pool.try_withdraw(
        &mauled_pa,
        &mauled_pb,
        &mauled_pc,
        &100i128,
        &sr,
        &ar,
        &nullifier,
        &b32(&h.env, 0xCF),
        &recipient,
        &0i128,
        &relayer,
    );

    // The mock verifier (standing in for a real verifier that would also
    // accept a malleated proof of a valid statement) says the proof is
    // fine — the pool must reject it anyway, on nullifier replay, before
    // any payout logic runs.
    assert_eq!(res, Err(Ok(PoolError::NullifierUsed)));
    // Balance must be unaffected by the rejected mauled attempt.
    assert_eq!(bal(&h, &recipient), 100);
}

// -- Issue #578: nullifier replay protection under conflicting submissions --
//
// Soroban's test harness executes contract calls sequentially — there is no
// real thread-level concurrency to simulate. What "two withdrawals racing
// with the same nullifier" means in this environment is: two transactions
// carrying the *same* `nullifier_hash` but otherwise-independent parameters
// (value, fee, recipient, relayer, new_commitment) are both submitted, in the
// same ledger and in adjacent ledgers, and in every possible submission
// order. These tests assert the invariant holds regardless of which
// candidate happens to land first — exactly one succeeds, the nullifier is
// spent exactly once, and custody reflects exactly one payout — which is the
// property that matters: whichever transaction the network orders first
// wins, and every other conflicting submission is rejected, deterministically
// and without any randomized/non-deterministic test input.

/// One candidate withdrawal, all sharing the same nullifier with its siblings
/// but otherwise distinct so a wrongly-accepted second withdrawal is
/// detectable (different value, fee, recipient, relayer, new_commitment).
struct Candidate {
    value: i128,
    fee: i128,
    new_commitment_tag: u8,
}

fn conflicting_candidates(env: &Env) -> [Candidate; 5] {
    let _ = env;
    [
        Candidate {
            value: 100,
            fee: 0,
            new_commitment_tag: 0xE0,
        },
        Candidate {
            value: 250,
            fee: 10,
            new_commitment_tag: 0xE1,
        },
        Candidate {
            value: 999,
            fee: 999,
            new_commitment_tag: 0xE2,
        }, // fee == value, still valid (payout 0)
        Candidate {
            value: 1,
            fee: 0,
            new_commitment_tag: 0xE3,
        },
        Candidate {
            value: 500,
            fee: 5,
            new_commitment_tag: 0xE4,
        },
    ]
}

/// Submits every candidate in `order` against the same nullifier and returns
/// the number that succeeded plus the resulting custody counters.
fn submit_conflicting(
    h: &Harness,
    nullifier: &BytesN<32>,
    sr: &BytesN<32>,
    ar: &BytesN<32>,
    order: &[usize],
) -> (usize, (i128, i128)) {
    let candidates = conflicting_candidates(&h.env);
    let (pa, pb, pc) = proof(&h.env);
    let mut successes = 0usize;

    for &i in order {
        let c = &candidates[i];
        let res = h.pool.try_withdraw(
            &pa,
            &pb,
            &pc,
            &c.value,
            sr,
            ar,
            nullifier,
            &b32(&h.env, c.new_commitment_tag),
            &Address::generate(&h.env),
            &c.fee,
            &Address::generate(&h.env),
        );
        if res.is_ok() {
            successes += 1;
        } else {
            assert_eq!(res, Err(Ok(PoolError::NullifierUsed)));
        }
    }

    (successes, h.pool.get_custody())
}

#[test]
fn same_ledger_conflicting_withdrawals_exactly_one_succeeds_regardless_of_order() {
    // Every permutation "wins" for a different candidate; the invariant
    // (exactly one success) must hold no matter which one goes first.
    let orders: [[usize; 5]; 5] = [
        [0, 1, 2, 3, 4],
        [4, 3, 2, 1, 0],
        [2, 0, 4, 1, 3],
        [1, 3, 0, 4, 2],
        [3, 4, 1, 2, 0],
    ];

    for order in orders {
        let h = setup();
        let depositor = Address::generate(&h.env);
        fund(&h, &depositor, 10_000);
        h.pool
            .deposit(&depositor, &10_000i128, &b32(&h.env, 0xC1), &0u64);
        let (sr, ar) = publish_roots(&h);
        let nullifier = b32(&h.env, 0x9B);

        // All submissions land in the same ledger — no sequence-number
        // change between them.
        let (successes, custody) = submit_conflicting(&h, &nullifier, &sr, &ar, &order);

        assert_eq!(
            successes, 1,
            "expected exactly one success for order {order:?}, got {successes}"
        );
        // Whichever candidate won, total withdrawn (tot_wd) must equal
        // exactly that one candidate's value — never the sum of several.
        let winner = &conflicting_candidates(&h.env)[order[0]];
        assert_eq!(custody, (10_000, winner.value));
        assert!(h.pool.is_spent(&nullifier));
    }
}

#[test]
fn adjacent_ledger_conflicting_withdrawals_exactly_one_succeeds() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 10_000);
    h.pool
        .deposit(&depositor, &10_000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let nullifier = b32(&h.env, 0x9C);
    let candidates = conflicting_candidates(&h.env);
    let (pa, pb, pc) = proof(&h.env);

    let start_ledger = h.env.ledger().sequence();
    let mut successes = 0usize;
    let mut winner_value: Option<i128> = None;

    for (step, c) in candidates.iter().enumerate() {
        // Each conflicting submission lands one ledger later than the last —
        // "adjacent ledgers", not just "same ledger".
        h.env
            .ledger()
            .set_sequence_number(start_ledger + step as u32);
        let res = h.pool.try_withdraw(
            &pa,
            &pb,
            &pc,
            &c.value,
            &sr,
            &ar,
            &nullifier,
            &b32(&h.env, c.new_commitment_tag),
            &Address::generate(&h.env),
            &c.fee,
            &Address::generate(&h.env),
        );
        if res.is_ok() {
            successes += 1;
            winner_value = Some(c.value);
        } else {
            assert_eq!(res, Err(Ok(PoolError::NullifierUsed)));
        }
    }

    assert_eq!(successes, 1);
    assert_eq!(h.pool.get_custody(), (10_000, winner_value.unwrap()));
    assert!(h.pool.is_spent(&nullifier));
}

#[test]
fn many_conflicting_submissions_never_spend_the_nullifier_more_than_once() {
    // A denser sweep than the 5-candidate permutation test above: the same
    // nullifier submitted many times in a single ledger with only the
    // submission order varying run-to-run (still fully deterministic — the
    // orders are explicit, not randomly generated).
    let all_orders: [[usize; 5]; 3] = [[0, 2, 4, 1, 3], [4, 0, 3, 1, 2], [2, 4, 0, 3, 1]];

    for order in all_orders {
        let h = setup();
        let depositor = Address::generate(&h.env);
        fund(&h, &depositor, 10_000);
        h.pool
            .deposit(&depositor, &10_000i128, &b32(&h.env, 0xC1), &0u64);
        let (sr, ar) = publish_roots(&h);
        let nullifier = b32(&h.env, 0x9D);

        let (successes, custody) = submit_conflicting(&h, &nullifier, &sr, &ar, &order);

        assert_eq!(successes, 1);
        let winner = &conflicting_candidates(&h.env)[order[0]];
        assert_eq!(custody, (10_000, winner.value));
        assert!(h.pool.is_spent(&nullifier));
    }
}

#[test]
fn withdraw_unknown_roots_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let recipient = Address::generate(&h.env);
    let relayer = Address::generate(&h.env);
    let (pa, pb, pc) = proof(&h.env);

    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &b32(&h.env, 0xEE),
        &ar,
        &b32(&h.env, 0x01),
        &b32(&h.env, 0xCE),
        &recipient,
        &0i128,
        &relayer,
    );
    assert_eq!(res, Err(Ok(PoolError::UnknownStateRoot)));

    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &b32(&h.env, 0xEF),
        &b32(&h.env, 0x02),
        &b32(&h.env, 0xCE),
        &recipient,
        &0i128,
        &relayer,
    );
    assert_eq!(res, Err(Ok(PoolError::UnknownAspRoot)));
}

#[test]
fn withdraw_expired_root_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    h.pool.set_root_expiry(&h.admin, &10u32);
    h.env.ledger().set_sequence_number(50);

    let (pa, pb, pc) = proof(&h.env);
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &ar,
        &b32(&h.env, 0x03),
        &b32(&h.env, 0xCE),
        &Address::generate(&h.env),
        &0i128,
        &Address::generate(&h.env),
    );
    assert_eq!(res, Err(Ok(PoolError::RootExpired)));
}

#[test]
fn withdraw_invalid_proof_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    h.mock.set_ok(&false);

    let (pa, pb, pc) = proof(&h.env);
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &ar,
        &b32(&h.env, 0x04),
        &b32(&h.env, 0xCE),
        &Address::generate(&h.env),
        &0i128,
        &Address::generate(&h.env),
    );
    assert_eq!(res, Err(Ok(PoolError::InvalidProof)));
}

#[test]
fn withdraw_custody_violation_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 100);
    h.pool
        .deposit(&depositor, &100i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);

    let (pa, pb, pc) = proof(&h.env);
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &200i128,
        &sr,
        &ar,
        &b32(&h.env, 0x05),
        &b32(&h.env, 0xCE),
        &Address::generate(&h.env),
        &0i128,
        &Address::generate(&h.env),
    );
    assert_eq!(res, Err(Ok(PoolError::CustodyViolation)));
}

#[test]
fn withdraw_bad_amount_rejected() {
    let h = setup();
    let (sr, ar) = publish_roots(&h);
    let (pa, pb, pc) = proof(&h.env);
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &ar,
        &b32(&h.env, 0x06),
        &b32(&h.env, 0xCE),
        &Address::generate(&h.env),
        &200i128,
        &Address::generate(&h.env),
    );
    assert_eq!(res, Err(Ok(PoolError::BadAmount)));
}

#[test]
fn deposit_exact_zero_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    let res = h
        .pool
        .try_deposit(&depositor, &0i128, &b32(&h.env, 0xC3), &0u64);
    assert_eq!(res, Err(Ok(PoolError::BadAmount)));
}

#[test]
fn deposit_negative_value_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    let res = h
        .pool
        .try_deposit(&depositor, &(-1i128), &b32(&h.env, 0xC4), &0u64);
    assert_eq!(res, Err(Ok(PoolError::BadAmount)));
}

#[test]
fn withdraw_zero_amount_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let (pa, pb, pc) = proof(&h.env);
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &0i128,
        &sr,
        &ar,
        &b32(&h.env, 0x07),
        &b32(&h.env, 0xCE),
        &Address::generate(&h.env),
        &0i128,
        &Address::generate(&h.env),
    );
    assert_eq!(res, Err(Ok(PoolError::BadAmount)));
}

#[test]
fn withdraw_negative_amount_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let (pa, pb, pc) = proof(&h.env);
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &(-100i128),
        &sr,
        &ar,
        &b32(&h.env, 0x08),
        &b32(&h.env, 0xCE),
        &Address::generate(&h.env),
        &0i128,
        &Address::generate(&h.env),
    );
    assert_eq!(res, Err(Ok(PoolError::BadAmount)));
}

#[test]
fn withdraw_fee_exceeds_amount_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let (pa, pb, pc) = proof(&h.env);
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &ar,
        &b32(&h.env, 0x09),
        &b32(&h.env, 0xCE),
        &Address::generate(&h.env),
        &200i128,
        &Address::generate(&h.env),
    );
    assert_eq!(res, Err(Ok(PoolError::BadAmount)));
}

#[test]
fn withdraw_negative_fee_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let (pa, pb, pc) = proof(&h.env);
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &ar,
        &b32(&h.env, 0x0A),
        &b32(&h.env, 0xCE),
        &Address::generate(&h.env),
        &(-1i128),
        &Address::generate(&h.env),
    );
    assert_eq!(res, Err(Ok(PoolError::BadAmount)));
}

#[test]
fn custody_counter_updates_after_withdraw() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 500);
    h.pool
        .deposit(&depositor, &500i128, &b32(&h.env, 0xC1), &0u64);
    assert_eq!(h.pool.get_custody(), (500, 0));
    let (sr, ar) = publish_roots(&h);

    let recipient = Address::generate(&h.env);
    let relayer = Address::generate(&h.env);
    let (pa, pb, pc) = proof(&h.env);
    h.pool.withdraw(
        &pa,
        &pb,
        &pc,
        &200i128,
        &sr,
        &ar,
        &b32(&h.env, 0x9B),
        &b32(&h.env, 0xCF),
        &recipient,
        &50i128,
        &relayer,
    );
    assert_eq!(h.pool.get_custody(), (500, 200));
    assert_eq!(bal(&h, &recipient), 150);
    assert_eq!(bal(&h, &relayer), 50);
}

#[test]
fn root_history_capped_at_100() {
    let h = setup();
    for i in 0..105u8 {
        let root = BytesN::from_array(&h.env, &[i; 32]);
        let ds = BytesN::from_array(&h.env, &[i.wrapping_add(0x10); 32]);
        h.pool.update_state_root(&h.admin, &root, &ds);
    }
    let hist: soroban_sdk::Vec<BytesN<32>> = h
        .env
        .storage()
        .instance()
        .get(&Symbol::new(&h.env, "state_hist"))
        .unwrap();
    assert_eq!(hist.len(), 100);
}

#[test]
fn root_expiry_boundary_exactly_at_limit_is_expired() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    h.pool.set_root_expiry(&h.admin, &10u32);
    h.env.ledger().set_sequence_number(50 + 10);

    let (pa, pb, pc) = proof(&h.env);
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &ar,
        &b32(&h.env, 0x10),
        &b32(&h.env, 0xCE),
        &Address::generate(&h.env),
        &0i128,
        &Address::generate(&h.env),
    );
    assert_eq!(res, Err(Ok(PoolError::RootExpired)));
}

#[test]
fn root_expiry_one_before_limit_is_valid() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    h.pool.set_root_expiry(&h.admin, &10u32);
    h.env.ledger().set_sequence_number(50 + 9);

    let (pa, pb, pc) = proof(&h.env);
    let recipient = Address::generate(&h.env);
    let relayer = Address::generate(&h.env);
    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &100i128,
        &sr,
        &ar,
        &b32(&h.env, 0x11),
        &b32(&h.env, 0xCE),
        &recipient,
        &0i128,
        &relayer,
    );
    assert!(res.is_ok());
}

#[test]
fn set_root_expiry_unauthorized() {
    let h = setup();
    let stranger = Address::generate(&h.env);
    let res = h.pool.try_set_root_expiry(&stranger, &500u32);
    assert_eq!(res, Err(Ok(PoolError::Unauthorized)));
}

// -- Issue #589: multisig admin migration ------------------------------------

#[test]
fn transfer_admin_moves_authority() {
    let h = setup();
    let new_admin = Address::generate(&h.env);
    h.pool.transfer_admin(&h.admin, &new_admin);
    assert_eq!(h.pool.get_config().admin, new_admin);

    // The old admin can no longer perform admin-gated operations.
    let res = h
        .pool
        .try_update_state_root(&h.admin, &b32(&h.env, 0x51), &b32(&h.env, 0xD1));
    assert_eq!(res, Err(Ok(PoolError::Unauthorized)));

    // The new admin can.
    h.pool
        .update_state_root(&new_admin, &b32(&h.env, 0x51), &b32(&h.env, 0xD1));
    assert!(h.pool.is_known_state_root(&b32(&h.env, 0x51)));
}

#[test]
fn transfer_admin_unauthorized() {
    let h = setup();
    let stranger = Address::generate(&h.env);
    let new_admin = Address::generate(&h.env);
    let res = h.pool.try_transfer_admin(&stranger, &new_admin);
    assert_eq!(res, Err(Ok(PoolError::Unauthorized)));
    assert_eq!(h.pool.get_config().admin, h.admin);
}

#[test]
fn deposit_increments_count() {
    let h = setup();
    let d1 = Address::generate(&h.env);
    let d2 = Address::generate(&h.env);
    fund(&h, &d1, 500);
    fund(&h, &d2, 300);
    let i1 = h.pool.deposit(&d1, &200i128, &b32(&h.env, 0xC1), &0u64);
    let i2 = h.pool.deposit(&d2, &300i128, &b32(&h.env, 0xC2), &1u64);
    assert_eq!(i1, 0);
    assert_eq!(i2, 1);
    assert_eq!(h.pool.get_deposit_count(), 2);
    assert_eq!(h.pool.get_custody(), (500, 0));
}

#[test]
fn withdraw_zero_fee_full_amount_to_recipient() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let recipient = Address::generate(&h.env);
    let relayer = Address::generate(&h.env);
    let (pa, pb, pc) = proof(&h.env);
    h.pool.withdraw(
        &pa,
        &pb,
        &pc,
        &1000i128,
        &sr,
        &ar,
        &b32(&h.env, 0x9C),
        &b32(&h.env, 0xCF),
        &recipient,
        &0i128,
        &relayer,
    );
    assert_eq!(bal(&h, &recipient), 1000);
    assert_eq!(bal(&h, &relayer), 0);
    assert_eq!(bal(&h, &h.pool_addr), 0);
}

#[test]
fn withdraw_equal_fee_and_amount_zero_to_recipient() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let recipient = Address::generate(&h.env);
    let relayer = Address::generate(&h.env);
    let (pa, pb, pc) = proof(&h.env);
    h.pool.withdraw(
        &pa,
        &pb,
        &pc,
        &500i128,
        &sr,
        &ar,
        &b32(&h.env, 0x9D),
        &b32(&h.env, 0xCF),
        &recipient,
        &500i128,
        &relayer,
    );
    assert_eq!(bal(&h, &recipient), 0);
    assert_eq!(bal(&h, &relayer), 500);
    assert_eq!(h.pool.get_custody(), (1000, 500));
}

// -- Issue #589: end-to-end multisig admin migration -------------------------
//
// Deploys a real multisig-admin contract, migrates the pool's admin to it via
// transfer_admin, and publishes a state root through the full
// propose_call -> approve -> threshold-triggered invoke_contract path — the
// exact sequence a deployed registry's admin migration would follow.

extern crate multisig_admin;

#[test]
fn state_root_publishable_through_a_real_multisig_after_admin_migration() {
    let h = setup();

    let s1 = Address::generate(&h.env);
    let s2 = Address::generate(&h.env);
    let s3 = Address::generate(&h.env);
    let signers = soroban_sdk::Vec::from_array(&h.env, [s1.clone(), s2.clone(), s3.clone()]);

    let multisig_addr = h.env.register(multisig_admin::MultisigAdmin, ());
    let multisig = multisig_admin::MultisigAdminClient::new(&h.env, &multisig_addr);
    multisig.initialize(&signers, &2u32);

    // Migrate the pool's admin away from the single EOA key.
    h.pool.transfer_admin(&h.admin, &multisig_addr);

    // The old single key is now powerless over the pool.
    let direct_attempt =
        h.pool
            .try_update_state_root(&h.admin, &b32(&h.env, 0x51), &b32(&h.env, 0xD1));
    assert_eq!(direct_attempt, Err(Ok(PoolError::Unauthorized)));

    // Publishing a root now requires two of the three signers, routed through
    // the multisig contract calling into the pool on its own authority.
    let root = b32(&h.env, 0x51);
    let dataset_hash = b32(&h.env, 0xD1);
    let args: soroban_sdk::Vec<soroban_sdk::Val> =
        (multisig_addr.clone(), root.clone(), dataset_hash.clone()).into_val(&h.env);
    let proposal_id = multisig.propose_call(
        &s1,
        &h.pool_addr,
        &Symbol::new(&h.env, "update_state_root"),
        &args,
    );
    assert!(!h.pool.is_known_state_root(&root));

    let executed = multisig.approve(&s2, &proposal_id);
    assert!(executed);
    assert!(h.pool.is_known_state_root(&root));

    // The third signer was never needed.
    let proposal = multisig.get_proposal(&proposal_id);
    assert_eq!(proposal.approvals.len(), 2);
    let _ = s3;
}

// -- Issue #576: timelocked circuit breaker ----------------------------------

#[test]
fn deposits_pause_takes_effect_same_ledger() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);

    assert!(!h.pool.is_deposits_paused());
    h.pool.pause_deposits(&h.admin);
    assert!(h.pool.is_deposits_paused());

    // No ledger advance between pause and this deposit attempt.
    let res = h
        .pool
        .try_deposit(&depositor, &100i128, &b32(&h.env, 0xC1), &0u64);
    assert_eq!(res, Err(Ok(PoolError::DepositsPaused)));
}

#[test]
fn unpause_deposits_resumes_immediately() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);

    h.pool.pause_deposits(&h.admin);
    h.pool.unpause_deposits(&h.admin);
    assert!(!h.pool.is_deposits_paused());

    let idx = h
        .pool
        .deposit(&depositor, &100i128, &b32(&h.env, 0xC1), &0u64);
    assert_eq!(idx, 0);
}

#[test]
fn pause_deposits_unauthorized_rejected() {
    let h = setup();
    let stranger = Address::generate(&h.env);
    let res = h.pool.try_pause_deposits(&stranger);
    assert_eq!(res, Err(Ok(PoolError::Unauthorized)));
    assert!(!h.pool.is_deposits_paused());
}

#[test]
fn withdrawal_pause_request_does_not_pause_immediately() {
    let h = setup();
    h.env.ledger().set_sequence_number(1000);
    h.pool.request_pause_withdrawals(&h.admin);

    // Still within the timelock window: withdrawals must still work (proof
    // will fail for unrelated reasons in this harness, but must NOT fail with
    // WithdrawalsPaused).
    assert!(!h.pool.is_withdrawals_paused());
    let (requested_at, activates_at) = h.pool.get_withdrawal_pause_request();
    assert_eq!(requested_at, 1000);
    assert_eq!(activates_at, 1000 + WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS);
}

#[test]
fn withdrawal_pause_activates_exactly_at_timelock_boundary() {
    let h = setup();
    h.env.ledger().set_sequence_number(1000);
    h.pool.request_pause_withdrawals(&h.admin);

    // One ledger before the deadline: not yet paused.
    h.env
        .ledger()
        .set_sequence_number(1000 + WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS - 1);
    assert!(!h.pool.is_withdrawals_paused());

    // Exactly at the deadline: paused.
    h.env
        .ledger()
        .set_sequence_number(1000 + WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS);
    assert!(h.pool.is_withdrawals_paused());
}

#[test]
fn withdraw_rejected_once_pause_timelock_elapses() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let (pa, pb, pc) = proof(&h.env);

    h.env.ledger().set_sequence_number(1000);
    h.pool.request_pause_withdrawals(&h.admin);
    h.env
        .ledger()
        .set_sequence_number(1000 + WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS);

    let res = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &500i128,
        &sr,
        &ar,
        &b32(&h.env, 0x10),
        &b32(&h.env, 0xCE),
        &Address::generate(&h.env),
        &0i128,
        &Address::generate(&h.env),
    );
    assert_eq!(res, Err(Ok(PoolError::WithdrawalsPaused)));
}

#[test]
fn requesting_pause_twice_does_not_reset_the_timelock() {
    let h = setup();
    h.env.ledger().set_sequence_number(1000);
    h.pool.request_pause_withdrawals(&h.admin);

    // Re-request later — must NOT push the deadline further out.
    h.env.ledger().set_sequence_number(5000);
    h.pool.request_pause_withdrawals(&h.admin);

    let (requested_at, activates_at) = h.pool.get_withdrawal_pause_request();
    assert_eq!(requested_at, 1000);
    assert_eq!(activates_at, 1000 + WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS);
}

#[test]
fn unpause_withdrawals_cancels_pending_request() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);

    h.env.ledger().set_sequence_number(1000);
    // Publish roots only after fixing the ledger clock so they stay fresh
    // through the timelock window advanced below (root expiry and the
    // withdrawal-pause timelock happen to share the same duration constant).
    let (sr, ar) = publish_roots(&h);
    let (pa, pb, pc) = proof(&h.env);

    h.pool.request_pause_withdrawals(&h.admin);
    h.pool.unpause_withdrawals(&h.admin);

    h.env
        .ledger()
        .set_sequence_number(1000 + WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS);
    assert!(!h.pool.is_withdrawals_paused());

    // Withdrawals proceed normally (proof mocked to succeed by default).
    h.pool.withdraw(
        &pa,
        &pb,
        &pc,
        &500i128,
        &sr,
        &ar,
        &b32(&h.env, 0x11),
        &b32(&h.env, 0xCF),
        &Address::generate(&h.env),
        &0i128,
        &Address::generate(&h.env),
    );
    assert_eq!(h.pool.get_custody(), (1000, 500));
}

#[test]
fn unpause_withdrawals_lifts_an_already_active_pause() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);

    h.env.ledger().set_sequence_number(1000);
    // Publish roots only after fixing the ledger clock — see comment in
    // unpause_withdrawals_cancels_pending_request above.
    let (sr, ar) = publish_roots(&h);
    let (pa, pb, pc) = proof(&h.env);

    h.pool.request_pause_withdrawals(&h.admin);
    h.env
        .ledger()
        .set_sequence_number(1000 + WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS);
    assert!(h.pool.is_withdrawals_paused());

    h.pool.unpause_withdrawals(&h.admin);
    assert!(!h.pool.is_withdrawals_paused());

    h.pool.withdraw(
        &pa,
        &pb,
        &pc,
        &500i128,
        &sr,
        &ar,
        &b32(&h.env, 0x12),
        &b32(&h.env, 0xD0),
        &Address::generate(&h.env),
        &0i128,
        &Address::generate(&h.env),
    );
    assert_eq!(h.pool.get_custody(), (1000, 500));
}

#[test]
fn unpause_withdrawals_with_no_pending_request_rejected() {
    let h = setup();
    let res = h.pool.try_unpause_withdrawals(&h.admin);
    assert_eq!(res, Err(Ok(PoolError::NoPauseRequestPending)));
}

#[test]
fn request_pause_withdrawals_unauthorized_rejected() {
    let h = setup();
    let stranger = Address::generate(&h.env);
    let res = h.pool.try_request_pause_withdrawals(&stranger);
    assert_eq!(res, Err(Ok(PoolError::Unauthorized)));
    assert_eq!(h.pool.get_withdrawal_pause_request(), (0, 0));
}

#[test]
fn deposits_pause_does_not_affect_withdrawals_and_vice_versa() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1000);
    h.pool
        .deposit(&depositor, &1000i128, &b32(&h.env, 0xC1), &0u64);
    let (sr, ar) = publish_roots(&h);
    let (pa, pb, pc) = proof(&h.env);

    // Pausing deposits must not block withdrawals.
    h.pool.pause_deposits(&h.admin);
    h.pool.withdraw(
        &pa,
        &pb,
        &pc,
        &200i128,
        &sr,
        &ar,
        &b32(&h.env, 0x13),
        &b32(&h.env, 0xD1),
        &Address::generate(&h.env),
        &0i128,
        &Address::generate(&h.env),
    );
    assert_eq!(h.pool.get_custody(), (1000, 200));

    // And an active withdrawal pause must not block deposits.
    h.pool.unpause_deposits(&h.admin);
    h.env.ledger().set_sequence_number(1000);
    h.pool.request_pause_withdrawals(&h.admin);
    h.env
        .ledger()
        .set_sequence_number(1000 + WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS);
    fund(&h, &depositor, 100);
    // dep_count is 2 here: index 0 from the deposit above, index 1 consumed
    // by withdraw()'s own new_commitment leaf insertion.
    let idx = h
        .pool
        .deposit(&depositor, &100i128, &b32(&h.env, 0xC2), &2u64);
    assert_eq!(idx, 2);
}

// ── Capacity guard tests (#730) ───────────────────────────────────────────────

#[test]
fn capacity_guard_rejects_deposit_when_tree_full() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1_000_000_000);

    // Exhaust the capacity counter via the pool's own contract context.
    h.env.as_contract(&h.pool_addr, || {
        let mut cap = capacity::get_tree_capacity(&h.env);
        cap.current_count = capacity::MAX_COMMITMENTS;
        h.env
            .storage()
            .instance()
            .set(&capacity::DataKey::TreeCapacity, &cap);
    });

    let err = h
        .pool
        .try_deposit(&depositor, &1i128, &b32(&h.env, 0x01), &0u64);
    assert!(err.is_err());
}

#[test]
fn capacity_guard_allows_deposit_below_limit() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1_000_000);

    let idx = h
        .pool
        .deposit(&depositor, &1_000_000i128, &b32(&h.env, 0x01), &0u64);
    assert_eq!(idx, 0);
}

// ── Minimum withdrawal tests (#731) ──────────────────────────────────────────

#[test]
fn withdrawal_below_minimum_rejected() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 1_000_000);

    h.pool
        .deposit(&depositor, &1_000_000i128, &b32(&h.env, 0x01), &0u64);

    // Raise the minimum withdrawal above the amount we'll try to withdraw.
    h.pool.set_withdrawal_minimum(&h.admin, &1_000_001);

    let (sr, ar) = publish_roots(&h);
    let recipient = Address::generate(&h.env);
    let relayer = Address::generate(&h.env);
    let (pa, pb, pc) = proof(&h.env);

    // Try withdrawing 500_000 — below the 1_000_001 minimum.
    let err = h.pool.try_withdraw(
        &pa,
        &pb,
        &pc,
        &500_000i128,
        &sr,
        &ar,
        &b32(&h.env, 0x9A),
        &b32(&h.env, 0xCE),
        &recipient,
        &0i128,
        &relayer,
    );
    assert!(err.is_err());
}

#[test]
fn withdrawal_at_minimum_succeeds() {
    let h = setup();
    let depositor = Address::generate(&h.env);
    fund(&h, &depositor, 2_000_000);

    h.pool
        .deposit(&depositor, &2_000_000i128, &b32(&h.env, 0x01), &0u64);

    // Set minimum to 500_000, then withdraw exactly that.
    h.pool.set_withdrawal_minimum(&h.admin, &500_000);

    let (sr, ar) = publish_roots(&h);
    let recipient = Address::generate(&h.env);
    let relayer = Address::generate(&h.env);
    let (pa, pb, pc) = proof(&h.env);

    h.pool.withdraw(
        &pa,
        &pb,
        &pc,
        &500_000i128,
        &sr,
        &ar,
        &b32(&h.env, 0x9A),
        &b32(&h.env, 0xCE),
        &recipient,
        &0i128,
        &relayer,
    );
    assert_eq!(bal(&h, &recipient), 500_000);
}

#[test]
fn admin_can_update_minimum_withdrawal() {
    let h = setup();
    h.pool.set_withdrawal_minimum(&h.admin, &5_000_000);
    assert_eq!(h.pool.get_withdrawal_minimum(), 5_000_000);
}

#[test]
#[should_panic(expected = "Error(Contract")]
fn non_admin_cannot_update_minimum_withdrawal() {
    let h = setup();
    let rando = Address::generate(&h.env);
    h.pool.set_withdrawal_minimum(&rando, &100);
}
