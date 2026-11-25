pub(crate) fn enabled_concurrent_account_ids(
    paths: &Paths,
    state: &ManagerStateFile,
) -> Result<Vec<String>, String> {
    let mut account_ids = fs::read_dir(&paths.accounts)
        .map_err(|error| format!("Failed to read account directory: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir() && entry.path().join("auth.json").is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|account_id| !state.disabled_account_ids.contains(account_id))
        .filter(|account_id| {
            state.concurrent_account_group.as_ref().is_none_or(|group| {
                load_account_group(&account_group_path(paths, account_id)) == *group
            })
        })
        .collect::<Vec<_>>();
    account_ids.sort();
    Ok(account_ids)
}

fn concurrent_custom_priority_enabled(state: &ManagerStateFile) -> bool {
    state.auto_switch_on_quota_exhaustion && state.custom_auto_switch_priority_enabled
}

fn quota_available_for_concurrent_routing(usage: &UsageSummary, threshold: Option<f64>) -> bool {
    let Some(threshold) = threshold else {
        return reported_quota_windows_have_remaining(usage);
    };
    primary_remaining_quota_score(usage).is_some_and(|remaining| remaining >= threshold)
}

fn available_concurrent_account_ids(
    paths: &Paths,
    state: &ManagerStateFile,
) -> Result<Vec<String>, String> {
    let mut account_ids = enabled_concurrent_account_ids(paths, state)?
        .into_iter()
        .filter(|account_id| {
            let custom_threshold_enabled =
                state.auto_switch_on_quota_exhaustion && state.custom_auto_switch_threshold_enabled;
            let threshold = custom_threshold_enabled.then(|| {
                effective_auto_switch_threshold(
                    load_auto_switch_threshold(&auto_switch_threshold_path(paths, account_id)),
                    state.global_auto_switch_threshold,
                    true,
                )
            });
            quota_available_for_concurrent_routing(
                &load_usage(&usage_path(paths, account_id)),
                threshold,
            )
        })
        .collect();
    concurrent_quota::retain_available(&mut account_ids)?;
    Ok(account_ids)
}

fn preferred_concurrent_account_ids(
    paths: &Paths,
    state: &ManagerStateFile,
    eligible_account_ids: &[String],
) -> Vec<String> {
    if !concurrent_custom_priority_enabled(state) {
        return eligible_account_ids.to_vec();
    }
    // Read each priority once per request, before taking the router lock. A setting
    // change must not produce an empty tier by changing between two file reads.
    let now = chrono::Utc::now().timestamp();
    let priorities = eligible_account_ids
        .iter()
        .map(|account_id| {
            let priority = reset_priority::stored_key(paths, state, account_id, now);
            (account_id, priority)
        })
        .collect::<Vec<_>>();
    let Some(highest_priority) = priorities.iter().map(|(_, priority)| *priority).min() else {
        return Vec::new();
    };
    priorities
        .into_iter()
        .filter(|(_, priority)| *priority == highest_priority)
        .map(|(account_id, _)| account_id.clone())
        .collect()
}

const NO_AVAILABLE_CONCURRENT_ACCOUNT: &str =
    "No enabled official account currently meets the configured usage threshold";

#[cfg(test)]
fn concurrent_account_for_session(
    paths: &Paths,
    state: &ManagerStateFile,
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    let eligible_account_ids = available_concurrent_account_ids(paths, state)?;
    choose_concurrent_account(paths, state, session_id, &eligible_account_ids)
}

fn choose_concurrent_account(
    paths: &Paths,
    state: &ManagerStateFile,
    session_id: Option<&str>,
    eligible_account_ids: &[String],
) -> Result<Option<String>, String> {
    let preferred_account_ids =
        preferred_concurrent_account_ids(paths, state, eligible_account_ids);
    let no_available_account = || NO_AVAILABLE_CONCURRENT_ACCOUNT.to_string();
    let Some(session_id) = session_id else {
        return preferred_account_ids
            .first()
            .cloned()
            .map(Some)
            .ok_or_else(no_available_account);
    };
    let account_id = concurrent_account_router()
        .lock()
        .map_err(|_| "Concurrent account router lock is poisoned".to_string())?
        .account_for_session(session_id, eligible_account_ids, &preferred_account_ids)
        .ok_or_else(no_available_account)?;
    Ok(Some(account_id))
}

fn concurrent_account_for_request<R: Runtime>(
    app: &tauri::AppHandle<R>,
    paths: &Paths,
    state: &ManagerStateFile,
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    let mut available = available_concurrent_account_ids(paths, state)?;
    if concurrent_recovery_needed(state, session_id)? {
        available.retain(|id| official_recovery_routing::concurrent_account_untried(id));
        available.retain(|id| official_recovery_routing::account_matches(app, id));
        let latest = try_read_state(paths)?;
        if !official_recovery_routing::manual_selection_is_current()
            || !latest.concurrent_account_routing_enabled
            || latest.active_provider_id.is_some()
            || latest.active_provider_group.is_some()
            || latest.concurrent_account_group != state.concurrent_account_group
        {
            return Err(NO_AVAILABLE_CONCURRENT_ACCOUNT.into());
        }
        let eligible_now = available_concurrent_account_ids(paths, &latest)?;
        available.retain(|id| eligible_now.contains(id));
        if available.is_empty() {
            return Err(NO_AVAILABLE_CONCURRENT_ACCOUNT.into());
        }
        return choose_concurrent_account(paths, &latest, session_id, &available);
    }
    choose_concurrent_account(paths, state, session_id, &available)
}

fn concurrent_recovery_needed(
    state: &ManagerStateFile,
    session_id: Option<&str>,
) -> Result<bool, String> {
    if official_recovery_routing::is_concurrent_retry() {
        return Ok(true);
    }
    if official_recovery_routing::model().is_none() {
        return Ok(false);
    }
    let assigned = session_id.and_then(|session| {
        concurrent_account_router()
            .lock()
            .ok()
            .and_then(|router| router.assignments.get(session).cloned())
    });
    let original = assigned.as_deref().or(state.active_account_id.as_deref());
    original
        .map(concurrent_quota::confirmed_exhaustion)
        .transpose()
        .map(Option::unwrap_or_default)
}
