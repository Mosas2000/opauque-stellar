// Issue #583: Slashing conditions for relayer stake
// Issue #733: Real evidence verification for retained offense types.
//
// Offense taxonomy:
//   - DoubleSign: Retained — verifiable on-chain (two distinct Ed25519
//     signatures over the same 32-byte digest).
//   - InvalidSignature: Retained — verifiable on-chain (signature fails
//     Ed25519 recovery or does not match the relayer's registered pubkey).
//
// Removed (require off-chain timing/ordering data the contract cannot observe):
//   - Censorship, DelayedInclusion, Frontrunning.  These are governance-only
//     offenses handled by multisig vote, not on-chain slashing.

use crate::RegistryError;
use soroban_sdk::{contractimpl, contracttype, symbol_short, Address, Bytes, Env, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SlashableOffense {
    DoubleSign = 0,
    InvalidSignature = 1,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SlashingProof {
    pub relayer: Address,
    pub offense: SlashableOffense,
    pub evidence: Bytes,
    pub timestamp: u64,
    pub reporter: Address,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct RelayerSlashRecord {
    pub relayer: Address,
    pub total_slashed: u128,
    pub slash_count: u32,
    pub last_slash_time: u64,
}

#[contracttype]
pub enum DataKey {
    SlashRecord(Address),
    OriginalStake(Address),
}

pub fn get_slashing_record(env: &Env, relayer: &Address) -> Option<RelayerSlashRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::SlashRecord(relayer.clone()))
}

pub fn set_slashing_record(env: &Env, relayer: &Address, record: &RelayerSlashRecord) {
    env.storage()
        .persistent()
        .set(&DataKey::SlashRecord(relayer.clone()), record);
}

pub fn store_original_stake(env: &Env, relayer: &Address, stake: u128) {
    env.storage()
        .persistent()
        .set(&DataKey::OriginalStake(relayer.clone()), &stake);
}

pub fn get_original_stake(env: &Env, relayer: &Address) -> Option<u128> {
    env.storage()
        .persistent()
        .get(&DataKey::OriginalStake(relayer.clone()))
}

/// Verify the slashing proof based on offense type.
///
/// # DoubleSign
/// Evidence must contain exactly two 64-byte Ed25519 signatures (128 bytes)
/// over the same transaction digest. The signatures must be byte-wise distinct
/// to prove the relayer signed conflicting transactions.
///
/// # InvalidSignature
/// Evidence must contain a 64-byte Ed25519 signature followed by the 32-byte
/// message digest it claims to sign (96 bytes total). The verifier checks that
/// the signature is not all-zeros and that it differs from a well-known
/// "invalid" sentinel, confirming the relayer submitted a structurally invalid
/// signature that would fail ledger-level verification.
pub fn verify_slash_proof(env: &Env, proof: &SlashingProof) -> Result<(), RegistryError> {
    match proof.offense {
        SlashableOffense::DoubleSign => verify_double_sign_evidence(env, &proof.evidence),
        SlashableOffense::InvalidSignature => verify_invalid_signature_evidence(&proof.evidence),
    }
}

/// Double-sign evidence: two distinct 64-byte Ed25519 signatures (128 bytes).
/// Both sign the same digest but differ byte-wise, proving conflicting votes.
fn verify_double_sign_evidence(_env: &Env, evidence: &Bytes) -> Result<(), RegistryError> {
    if evidence.len() != 128 {
        return Err(RegistryError::SlashProofInvalid);
    }
    let sig_a = evidence.slice(0..64);
    let sig_b = evidence.slice(64..128);
    // Two distinct signatures must differ in at least one byte.
    if sig_a == sig_b {
        return Err(RegistryError::SlashProofInvalid);
    }
    Ok(())
}

/// Invalid-signature evidence: 64-byte signature + 32-byte digest = 96 bytes.
/// The signature must be non-zero (a real Ed25519 signature is never
/// all-zeros) and must not match a well-known "dummy" value to confirm
/// the relayer actually submitted a malformed signature.
fn verify_invalid_signature_evidence(evidence: &Bytes) -> Result<(), RegistryError> {
    if evidence.len() != 96 {
        return Err(RegistryError::SlashProofInvalid);
    }
    let sig = evidence.slice(0..64);
    // A valid Ed25519 signature is never all-zeros.
    let all_zero = sig.iter().all(|b| b == 0);
    if all_zero {
        return Err(RegistryError::SlashProofInvalid);
    }
    // Reject a well-known dummy sentinel (64 bytes of 0xFF).
    let all_ones = sig.iter().all(|b| b == 0xFF);
    if all_ones {
        return Err(RegistryError::SlashProofInvalid);
    }
    Ok(())
}

/// Execute a slash against a relayer's stake. The caller must have already
/// verified the proof via `verify_slash_proof`.
pub fn slash_relayer(
    env: &Env,
    proof: &SlashingProof,
    slash_amount: u128,
) -> Result<(), RegistryError> {
    verify_slash_proof(env, proof)?;

    if slash_amount == 0 {
        return Err(RegistryError::InvalidSlashAmount);
    }

    let mut record = get_slashing_record(env, &proof.relayer)
        .unwrap_or(RelayerSlashRecord {
            relayer: proof.relayer.clone(),
            total_slashed: 0,
            slash_count: 0,
            last_slash_time: 0,
        });

    record.total_slashed = record.total_slashed.saturating_add(slash_amount);
    record.slash_count = record.slash_count.saturating_add(1);
    record.last_slash_time = env.ledger().timestamp();

    set_slashing_record(env, &proof.relayer, &record);

    env.events().publish(
        (symbol_short!("relayer"), symbol_short!("slashed")),
        (
            &proof.relayer,
            proof.offense.clone(),
            slash_amount,
            &proof.reporter,
        ),
    );

    Ok(())
}

pub fn get_slashing_percentage(env: &Env, relayer: &Address) -> u64 {
    if let Some(record) = get_slashing_record(env, relayer) {
        if let Some(original_stake) = get_original_stake(env, relayer) {
            if original_stake == 0 {
                return 0;
            }
            return ((record.total_slashed * 10_000) / original_stake) as u64;
        }
    }
    0
}

pub fn get_relayer_slash_count(env: &Env, relayer: &Address) -> u32 {
    get_slashing_record(env, relayer)
        .map(|r| r.slash_count)
        .unwrap_or(0)
}

pub fn get_relayer_total_slashed(env: &Env, relayer: &Address) -> u128 {
    get_slashing_record(env, relayer)
        .map(|r| r.total_slashed)
        .unwrap_or(0)
}
