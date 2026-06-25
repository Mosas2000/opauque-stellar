#![no_std]
// The classic `events().publish` API is retained intentionally: migrating to the
// `#[contractevent]` macro would change the on-chain event ABI that the WASM scanner
// and frontend depend on. `register_contract` is likewise retained in tests.
#![allow(deprecated)]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Bytes, Env, Symbol,
};

/// Stealth Meta-Address Registry — maps Stellar accounts to stealth meta-addresses.
/// Equivalent to ERC-6538.
///
/// Supported schemes:
/// - scheme_id 1 = secp256k1 DKSAP, 66 bytes: compressed view key || compressed spend key.
/// - scheme_id 2 = Stellar-native Ed25519 DKSAP, 64 bytes: raw view key || raw spend key.
#[contract]
pub struct StealthRegistry;

/// Current event schema version — increment when the event topic/data layout changes.
/// Scanners should reject events with an unrecognised version rather than misparse them.
const EVENT_VERSION: u32 = 1;

#[contracttype]
#[derive(Clone)]
pub struct RegistryEntry {
    pub registrant: Address,
    pub scheme_id: u64,
    pub stealth_meta_address: Bytes,
    pub nonce: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    InvalidMetaAddress = 1,
    InvalidPrefix = 2,
    SameKeys = 3,
    UnsupportedSchemeId = 4,
}

pub const SCHEME_ID_SECP256K1: u64 = 1;
pub const SCHEME_ID_ED25519: u64 = 2;

fn registry_key(registrant: &Address, scheme_id: u64) -> (Symbol, Address, u64) {
    (
        Symbol::new(registrant.env(), "latest"),
        registrant.clone(),
        scheme_id,
    )
}

fn history_key(registrant: &Address, scheme_id: u64, nonce: u64) -> (Symbol, Address, u64, u64) {
    (
        Symbol::new(registrant.env(), "hist"),
        registrant.clone(),
        scheme_id,
        nonce,
    )
}

fn nonce_key(registrant: &Address) -> (Symbol, Address) {
    (Symbol::new(registrant.env(), "nonce"), registrant.clone())
}

fn is_valid_secp256k1_pubkey(bytes: &Bytes) -> bool {
    if bytes.len() != 33 {
        return false;
    }
    let prefix = bytes.get(0).unwrap_or(0);
    prefix == 0x02 || prefix == 0x03
}

fn is_all_zero(bytes: &Bytes) -> bool {
    for i in 0..bytes.len() {
        if bytes.get(i).unwrap_or(0) != 0 {
            return false;
        }
    }
    true
}

#[contractimpl]
impl StealthRegistry {
    pub fn register_keys(
        env: Env,
        registrant: Address,
        scheme_id: u64,
        stealth_meta_address: Bytes,
    ) -> Result<(), RegistryError> {
        registrant.require_auth();

        match scheme_id {
            SCHEME_ID_SECP256K1 => {
                if stealth_meta_address.len() != 66 {
                    return Err(RegistryError::InvalidMetaAddress);
                }

                let view_key = stealth_meta_address.slice(0..33);
                let spend_key = stealth_meta_address.slice(33..66);

                if !is_valid_secp256k1_pubkey(&view_key) || !is_valid_secp256k1_pubkey(&spend_key) {
                    return Err(RegistryError::InvalidPrefix);
                }

                if view_key == spend_key {
                    return Err(RegistryError::SameKeys);
                }
            }
            SCHEME_ID_ED25519 => {
                if stealth_meta_address.len() != 64 {
                    return Err(RegistryError::InvalidMetaAddress);
                }

                let view_key = stealth_meta_address.slice(0..32);
                let spend_key = stealth_meta_address.slice(32..64);
                if is_all_zero(&view_key) || is_all_zero(&spend_key) {
                    return Err(RegistryError::InvalidMetaAddress);
                }
                if view_key == spend_key {
                    return Err(RegistryError::SameKeys);
                }
            }
            _ => return Err(RegistryError::UnsupportedSchemeId),
        }

        // Increment nonce and store
        let n_key = nonce_key(&registrant);
        let nonce: u64 = env.storage().persistent().get(&n_key).unwrap_or(0);
        let new_nonce = nonce.saturating_add(1);
        env.storage().persistent().set(&n_key, &new_nonce);

        let entry = RegistryEntry {
            registrant: registrant.clone(),
            scheme_id,
            stealth_meta_address: stealth_meta_address.clone(),
            nonce: new_nonce,
        };

        // Update latest and historical
        env.storage()
            .persistent()
            .set(&registry_key(&registrant, scheme_id), &entry);

        env.storage()
            .persistent()
            .set(&history_key(&registrant, scheme_id, new_nonce), &entry);

        env.events().publish(
            (Symbol::new(&env, "StealthMetaAddressSet"), EVENT_VERSION),
            (registrant, scheme_id, stealth_meta_address),
        );
        Ok(())
    }

    pub fn increment_nonce(env: Env, registrant: Address) -> u64 {
        registrant.require_auth();
        let key = nonce_key(&registrant);
        let nonce: u64 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_nonce = nonce.saturating_add(1);
        env.storage().persistent().set(&key, &new_nonce);
        env.events().publish(
            (Symbol::new(&env, "NonceIncremented"), EVENT_VERSION),
            (registrant.clone(), new_nonce),
        );
        new_nonce
    }

    pub fn resolve(env: Env, registrant: Address, scheme_id: u64) -> Option<Bytes> {
        env.storage()
            .persistent()
            .get::<_, RegistryEntry>(&registry_key(&registrant, scheme_id))
            .map(|e| e.stealth_meta_address)
    }

    pub fn resolve_historical(
        env: Env,
        registrant: Address,
        scheme_id: u64,
        nonce: u64,
    ) -> Option<Bytes> {
        env.storage()
            .persistent()
            .get::<_, RegistryEntry>(&history_key(&registrant, scheme_id, nonce))
            .map(|e| e.stealth_meta_address)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _},
        Address, Bytes, Env,
    };

    struct Setup {
        env: Env,
        client: StealthRegistryClient<'static>,
        registrant: Address,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, StealthRegistry);
        let client = StealthRegistryClient::new(&env, &contract_id);
        let registrant = Address::generate(&env);
        Setup {
            env,
            client,
            registrant,
        }
    }

    fn valid_meta_address(env: &Env) -> Bytes {
        let mut bytes = Bytes::new(env);
        // Compressed keys with 0x02 prefix
        bytes.push_back(0x02u8);
        for _ in 0..32 {
            bytes.push_back(0x01u8);
        }
        bytes.push_back(0x02u8);
        for _ in 0..32 {
            bytes.push_back(0x02u8);
        }
        bytes
    }

    fn valid_ed25519_meta_address(env: &Env) -> Bytes {
        let mut bytes = Bytes::new(env);
        for _ in 0..32 {
            bytes.push_back(0x11u8);
        }
        for _ in 0..32 {
            bytes.push_back(0x22u8);
        }
        bytes
    }

    #[test]
    fn test_register_keys_success() {
        let Setup {
            env,
            client,
            registrant,
        } = setup();
        let meta = valid_meta_address(&env);
        let scheme_id: u64 = 1;

        client.register_keys(&registrant, &scheme_id, &meta);

        let resolved = client.resolve(&registrant, &scheme_id);
        assert_eq!(resolved, Some(meta));
    }

    #[test]
    fn test_register_keys_ed25519_success() {
        let Setup {
            env,
            client,
            registrant,
        } = setup();
        let meta = valid_ed25519_meta_address(&env);
        let scheme_id: u64 = SCHEME_ID_ED25519;

        client.register_keys(&registrant, &scheme_id, &meta);

        let resolved = client.resolve(&registrant, &scheme_id);
        assert_eq!(resolved, Some(meta));
    }

    #[test]
    fn test_register_keys_ed25519_rejects_wrong_length() {
        let Setup {
            env,
            client,
            registrant,
        } = setup();
        let mut meta = Bytes::new(&env);
        for _ in 0..63 {
            meta.push_back(0x11u8);
        }
        let result = client.try_register_keys(&registrant, &SCHEME_ID_ED25519, &meta);
        assert_eq!(result, Err(Ok(RegistryError::InvalidMetaAddress)));
    }

    #[test]
    fn test_register_keys_invalid_prefix() {
        let Setup {
            env,
            client,
            registrant,
        } = setup();
        let scheme_id: u64 = 1;
        let mut bad_meta = Bytes::new(&env);
        for _ in 0..66 {
            bad_meta.push_back(0x04u8);
        } // 0x04 is invalid for compressed keys

        let result = client.try_register_keys(&registrant, &scheme_id, &bad_meta);
        assert!(result.is_err());
    }

    #[test]
    fn test_register_keys_same_keys_fails() {
        let Setup {
            env,
            client,
            registrant,
        } = setup();
        let scheme_id: u64 = 1;
        let mut same_meta = Bytes::new(&env);
        same_meta.push_back(0x02u8);
        for _ in 0..32 {
            same_meta.push_back(0x01u8);
        }
        same_meta.push_back(0x02u8);
        for _ in 0..32 {
            same_meta.push_back(0x01u8);
        }

        let result = client.try_register_keys(&registrant, &scheme_id, &same_meta);
        assert!(result.is_err());
    }

    #[test]
    fn test_register_keys_history() {
        let Setup {
            env,
            client,
            registrant,
        } = setup();
        let scheme_id: u64 = 1;

        let meta1 = valid_meta_address(&env);
        client.register_keys(&registrant, &scheme_id, &meta1);

        let mut meta2 = Bytes::new(&env);
        meta2.push_back(0x03u8);
        for _ in 0..32 {
            meta2.push_back(0x09u8);
        }
        meta2.push_back(0x03u8);
        for _ in 0..32 {
            meta2.push_back(0x08u8);
        }
        client.register_keys(&registrant, &scheme_id, &meta2);

        // Resolve current
        assert_eq!(client.resolve(&registrant, &scheme_id), Some(meta2.clone()));

        // Resolve historical
        assert_eq!(
            client.resolve_historical(&registrant, &scheme_id, &1),
            Some(meta1)
        );
        assert_eq!(
            client.resolve_historical(&registrant, &scheme_id, &2),
            Some(meta2)
        );
    }

    #[test]
    fn test_increment_nonce_manual() {
        let Setup {
            client, registrant, ..
        } = setup();

        let nonce = client.increment_nonce(&registrant);
        assert_eq!(nonce, 1);
    }

    #[test]
    fn test_resolve_not_found() {
        let Setup { client, .. } = setup();
        let stranger = Address::generate(&client.env);

        let result = client.resolve(&stranger, &1u64);
        assert_eq!(result, None);
    }

    #[test]
    fn test_resolve_different_scheme_ids() {
        let Setup {
            env,
            client,
            registrant,
        } = setup();
        let meta = valid_meta_address(&env);

        client.register_keys(&registrant, &1u64, &meta);

        let not_found = client.resolve(&registrant, &2u64);
        assert_eq!(not_found, None);

        let found = client.resolve(&registrant, &1u64);
        assert_eq!(found, Some(meta));
    }

    #[test]
    fn test_register_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, StealthRegistry);
        let client = StealthRegistryClient::new(&env, &contract_id);
        let registrant = Address::generate(&env);
        let meta = valid_meta_address(&env);

        client.register_keys(&registrant, &1u64, &meta);

        let events = env.events().all();
        let found = !events.filter_by_contract(&contract_id).events().is_empty();
        assert!(found);
    }

    #[test]
    fn test_increment_nonce_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, StealthRegistry);
        let client = StealthRegistryClient::new(&env, &contract_id);
        let registrant = Address::generate(&env);

        client.increment_nonce(&registrant);

        let events = env.events().all();
        let found = !events.filter_by_contract(&contract_id).events().is_empty();
        assert!(found);
    }
}
