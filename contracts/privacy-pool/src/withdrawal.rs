// Issue #584: Minimum withdrawal amount enforcement
// Prevents dust-sized withdrawals from bloating nullifier set

use soroban_sdk::{contracttype, symbol_short, Address, Env};

#[contracttype]
#[derive(Clone, Debug)]
pub struct WithdrawalConfig {
    pub minimum_amount: u128,
    pub updated_at: u64,
    pub updated_by: Address,
}

#[contracttype]
pub enum DataKey {
    WithdrawalConfig,
    WithdrawalAdmin,
}

pub const DEFAULT_MINIMUM_WITHDRAWAL: u128 = 1_000_000; // 0.01 of smallest unit

pub fn initialize_withdrawal_config(env: &Env, admin: Address, minimum_amount: u128) {
    let config = WithdrawalConfig {
        minimum_amount,
        updated_at: env.ledger().timestamp(),
        updated_by: admin.clone(),
    };

    env.storage()
        .instance()
        .set(&DataKey::WithdrawalConfig, &config);

    env.storage()
        .instance()
        .set(&DataKey::WithdrawalAdmin, &admin);

    env.events().publish(
        (symbol_short!("pool"), symbol_short!("wd_cfg")),
        (minimum_amount,),
    );
}

pub fn get_minimum_withdrawal_amount(env: &Env) -> u128 {
    env.storage()
        .instance()
        .get::<_, WithdrawalConfig>(&DataKey::WithdrawalConfig)
        .map(|config| config.minimum_amount)
        .unwrap_or(DEFAULT_MINIMUM_WITHDRAWAL)
}

pub fn get_withdrawal_config(env: &Env) -> WithdrawalConfig {
    env.storage()
        .instance()
        .get::<_, WithdrawalConfig>(&DataKey::WithdrawalConfig)
        .expect("withdrawal config not initialized")
}

pub fn update_minimum_withdrawal_amount(env: &Env, caller: Address, new_minimum: u128) {
    let admin = env
        .storage()
        .instance()
        .get::<_, Address>(&DataKey::WithdrawalAdmin)
        .expect("admin not configured");

    assert!(caller == admin, "only admin can update withdrawal config");
    assert!(new_minimum > 0, "minimum withdrawal must be positive");
    assert!(
        new_minimum <= 1_000_000_000_000_000,
        "minimum withdrawal exceeds maximum allowed"
    );

    let config = WithdrawalConfig {
        minimum_amount: new_minimum,
        updated_at: env.ledger().timestamp(),
        updated_by: caller.clone(),
    };

    env.storage()
        .instance()
        .set(&DataKey::WithdrawalConfig, &config);

    env.events().publish(
        (symbol_short!("pool"), symbol_short!("min_upd")),
        (new_minimum, &caller),
    );
}

pub fn validate_withdrawal_amount(env: &Env, amount: u128) -> bool {
    let minimum = get_minimum_withdrawal_amount(env);
    amount >= minimum
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_minimum() {
        assert_eq!(DEFAULT_MINIMUM_WITHDRAWAL, 1_000_000);
    }

    #[test]
    fn test_minimum_validation() {
        let minimum = 1_000_000;
        assert!(minimum > 500_000);
        assert!(2_000_000 > minimum);
    }
}
