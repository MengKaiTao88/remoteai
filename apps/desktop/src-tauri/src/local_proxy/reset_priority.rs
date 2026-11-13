use crate::{
    models::{AccountSummary, ManagerStateFile, UsageSummary},
    storage::{
        auto_switch_priority_path, load_auto_switch_priority, load_usage, usage_path, Paths,
    },
};

/// Unknown or already elapsed reset times follow every confirmed future reset.
/// A reset timestamp alone never establishes that an account has available quota.
pub(crate) fn secondary_reset_key(usage: &UsageSummary, now: i64) -> i64 {
    if usage.error.is_some() {
        return i64::MAX;
    }
    usage
        .secondary
        .as_ref()
        .and_then(|window| window.resets_at)
        .filter(|reset| *reset > now)
        .unwrap_or(i64::MAX)
}

pub(crate) fn enabled(state: &ManagerStateFile) -> bool {
    state.auto_switch_on_quota_exhaustion
        && state.custom_auto_switch_priority_enabled
        && state.auto_switch_priority_by_reset
}

/// Project dynamic ranks into response summaries without overwriting manual priorities.
pub(crate) fn apply(accounts: &mut [AccountSummary], state: &ManagerStateFile) {
    if !enabled(state) {
        return;
    }
    let now = chrono::Utc::now().timestamp();
    let mut resets = accounts
        .iter()
        .map(|account| secondary_reset_key(&account.usage, now))
        .collect::<Vec<_>>();
    resets.sort_unstable();
    resets.dedup();
    for account in accounts {
        let key = secondary_reset_key(&account.usage, now);
        // The key was inserted above. Saturation also bounds unusually large catalogs.
        let rank = resets
            .partition_point(|reset| *reset < key)
            .saturating_add(1);
        account.auto_switch_priority = i32::try_from(rank).unwrap_or(i32::MAX);
    }
}

/// Usage refreshes may outlive a mode change; resolve the latest manual values first.
pub(super) fn reload(paths: &Paths, accounts: &mut [AccountSummary], state: &ManagerStateFile) {
    for account in accounts.iter_mut() {
        account.auto_switch_priority =
            load_auto_switch_priority(&auto_switch_priority_path(paths, &account.id));
    }
    apply(accounts, state);
}

/// Read once per routing decision; both concurrency tiers and image fallback use this key.
pub(super) fn stored_key(paths: &Paths, state: &ManagerStateFile, id: &str, now: i64) -> i64 {
    if enabled(state) {
        secondary_reset_key(&load_usage(&usage_path(paths, id)), now)
    } else {
        i64::from(load_auto_switch_priority(&auto_switch_priority_path(
            paths, id,
        )))
    }
}
