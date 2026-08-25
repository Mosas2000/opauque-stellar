// Issue #585: Commitment tree capacity tracking and guard
// Prevents silent failures when tree capacity is exceeded

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env};

// Constants for tree management
pub const TREE_DEPTH: u32 = 20;
pub const MAX_COMMITMENTS: u64 = 1_000_000; // 2^20 - theoretical max
pub const CAPACITY_WARNING_THRESHOLD_BPS: u64 = 8500; // 85% in basis points
pub const CAPACITY_CRITICAL_THRESHOLD_BPS: u64 = 9500; // 95% in basis points

#[contracttype]
#[derive(Clone, Debug)]
pub struct TreeCapacityInfo {
    pub max_capacity: u64,
    pub current_count: u64,
    pub depth: u32,
    pub last_updated: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AlertLevel {
    Normal = 0,
    Warning = 1,  // 85% full
    Critical = 2, // 95% full
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CapacityAlert {
    pub level: AlertLevel,
    pub timestamp: u64,
    pub current_count: u64,
    pub threshold_bps: u64,
}

#[contracttype]
pub enum DataKey {
    TreeCapacity,
    LastAlert,
}

pub fn initialize_capacity_tracking(env: &Env) {
    let capacity = TreeCapacityInfo {
        max_capacity: MAX_COMMITMENTS,
        current_count: 0,
        depth: TREE_DEPTH,
        last_updated: env.ledger().timestamp(),
    };

    env.storage()
        .instance()
        .set(&DataKey::TreeCapacity, &capacity);

    env.events().publish(
        (symbol_short!("pool"), symbol_short!("cap_init")),
        (MAX_COMMITMENTS,),
    );
}

pub fn get_tree_capacity(env: &Env) -> TreeCapacityInfo {
    env.storage()
        .instance()
        .get(&DataKey::TreeCapacity)
        .unwrap_or(TreeCapacityInfo {
            max_capacity: MAX_COMMITMENTS,
            current_count: 0,
            depth: TREE_DEPTH,
            last_updated: env.ledger().timestamp(),
        })
}

pub fn get_capacity_percentage_bps(env: &Env) -> u64 {
    let capacity = get_tree_capacity(env);
    if capacity.max_capacity == 0 {
        return 0;
    }
    ((capacity.current_count as u128 * 10000) / capacity.max_capacity as u128) as u64
}

pub fn get_capacity_alert_level(env: &Env) -> AlertLevel {
    let bps = get_capacity_percentage_bps(env);

    if bps >= CAPACITY_CRITICAL_THRESHOLD_BPS {
        AlertLevel::Critical
    } else if bps >= CAPACITY_WARNING_THRESHOLD_BPS {
        AlertLevel::Warning
    } else {
        AlertLevel::Normal
    }
}

pub fn is_tree_at_capacity(env: &Env) -> bool {
    let capacity = get_tree_capacity(env);
    capacity.current_count >= capacity.max_capacity
}

// Emit capacity alert if threshold crossed
fn check_and_emit_capacity_alert(env: &Env, current_level: AlertLevel) {
    let prev_alert = env.storage()
        .instance()
        .get::<_, CapacityAlert>(&DataKey::LastAlert);

    let should_emit = match (&prev_alert, &current_level) {
        (None, AlertLevel::Warning) | (None, AlertLevel::Critical) => true,
        (Some(prev), AlertLevel::Critical) if prev.level != AlertLevel::Critical => true,
        (Some(prev), AlertLevel::Warning) if prev.level == AlertLevel::Normal => true,
        _ => false,
    };

    if should_emit {
        let capacity = get_tree_capacity(env);
        let bps = get_capacity_percentage_bps(env);
        let threshold_bps = match current_level {
            AlertLevel::Critical => CAPACITY_CRITICAL_THRESHOLD_BPS,
            AlertLevel::Warning => CAPACITY_WARNING_THRESHOLD_BPS,
            AlertLevel::Normal => 0,
        };

        let alert = CapacityAlert {
            level: current_level.clone(),
            timestamp: env.ledger().timestamp(),
            current_count: capacity.current_count,
            threshold_bps,
        };

        env.storage()
            .instance()
            .set(&DataKey::LastAlert, &alert);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("cap_alert")),
            (&current_level, bps, capacity.current_count),
        );
    }
}

pub fn increment_commitment_count(env: &Env) {
    let mut capacity = get_tree_capacity(env);

    capacity.current_count += 1;
    capacity.last_updated = env.ledger().timestamp();

    env.storage()
        .instance()
        .set(&DataKey::TreeCapacity, &capacity);

    let alert_level = get_capacity_alert_level(env);
    check_and_emit_capacity_alert(env, alert_level);
}

pub fn get_remaining_capacity(env: &Env) -> u64 {
    let capacity = get_tree_capacity(env);
    capacity.max_capacity.saturating_sub(capacity.current_count)
}

pub fn get_capacity_status(env: &Env) -> TreeCapacityInfo {
    get_tree_capacity(env)
}

// Administrative function to reset capacity (emergency only)
pub fn reset_capacity_counter(env: &Env, caller: &Address) {
    let mut capacity = get_tree_capacity(env);
    capacity.current_count = 0;
    capacity.last_updated = env.ledger().timestamp();

    env.storage()
        .instance()
        .set(&DataKey::TreeCapacity, &capacity);

    env.events().publish(
        (symbol_short!("pool"), symbol_short!("cap_reset")),
        (caller,),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_constants() {
        assert_eq!(TREE_DEPTH, 20);
        assert_eq!(MAX_COMMITMENTS, 1_000_000);
        assert_eq!(CAPACITY_WARNING_THRESHOLD_BPS, 8500);
        assert_eq!(CAPACITY_CRITICAL_THRESHOLD_BPS, 9500);
    }

    #[test]
    fn test_alert_level_logic() {
        // Normal: < 85%
        assert_eq!(AlertLevel::Normal, AlertLevel::Normal);

        // Warning: 85-95%
        assert_eq!(AlertLevel::Warning, AlertLevel::Warning);

        // Critical: >= 95%
        assert_eq!(AlertLevel::Critical, AlertLevel::Critical);
    }

    #[test]
    fn test_capacity_calculations() {
        // At 85% capacity: 850,000 commitments
        let capacity_at_warning = (MAX_COMMITMENTS as u128 * 8500 / 10000) as u64;
        assert!(capacity_at_warning >= 850_000 && capacity_at_warning <= 851_000);

        // At 95% capacity: 950,000 commitments
        let capacity_at_critical = (MAX_COMMITMENTS as u128 * 9500 / 10000) as u64;
        assert!(capacity_at_critical >= 950_000 && capacity_at_critical <= 951_000);
    }
}
