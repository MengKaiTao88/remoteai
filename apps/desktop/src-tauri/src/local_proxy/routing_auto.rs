fn upstream_429_retry_delay(retry_number: u16) -> Duration {
    let additional_seconds =
        u64::from(retry_number.saturating_sub(1)).saturating_mul(UPSTREAM_429_DELAY_STEP_SECONDS);
    Duration::from_secs(UPSTREAM_429_INITIAL_DELAY_SECONDS.saturating_add(additional_seconds))
}

fn try_switch_official_account_after_quota<R: Runtime>(
    app: &tauri::AppHandle<R>,
    response: &UpstreamPayload,
    exhausted_account_ids: &HashSet<String>,
) -> bool {
    let Some(account) = response
        .token_usage_account
        .as_ref()
        .filter(|account| credential_can_trigger_auto_switch(account))
    else {
        return false;
    };
    let is_quota = is_official_quota_exhaustion(response);
    match auto_switch_official_account(
        app,
        AutoSwitchRequest {
            observed_generation: account.active_account_generation,
            observed_attempt_generation: account.auto_switch_attempt_generation,
            failed_account_id: &account.account_id,
            exhausted_account_ids,
            allow_quota_reset: !account_failure::is_authentication_failure(response),
            requirements: AutoSwitchRequirements {
                model: is_quota.then(official_recovery_routing::model).flatten(),
                official_only: is_quota && !official_websocket::attempt_can_change_route(),
                manual_selection: official_recovery_routing::observation()
                    .map(|(_, version)| version),
            },
        },
    ) {
        Ok(switched) => switched,
        Err(error) => {
            log_proxy_error!(
                "failed to automatically switch official account after upstream rejection: {error}"
            );
            false
        }
    }
}

fn credential_can_trigger_auto_switch(account: &TokenUsageAccount) -> bool {
    account.auto_switch_eligible
}

fn automatic_switch_is_blocked(state: &ManagerStateFile) -> bool {
    !state.auto_switch_on_quota_exhaustion
        || state.concurrent_account_routing_enabled
        || state.active_provider_id.is_some()
        || state.active_provider_group.is_some()
}

fn can_leave_failed_account(
    account: &AccountSummary,
    current_id: &str,
    failed_account_ids: &HashSet<String>,
) -> bool {
    // Background usage refresh may already have disabled this account. Exclusion
    // prevents selecting it again; it must not pin an in-flight request to it.
    account.id == current_id
        && (account.auto_switch_enabled || failed_account_ids.contains(current_id))
}

fn retain_untried_auto_switch_accounts(
    accounts: &mut Vec<AccountSummary>,
    exhausted_account_ids: &HashSet<String>,
) {
    accounts.retain(|account| !exhausted_account_ids.contains(&account.id));
}

fn all_backup_accounts_have_exhausted_quota(
    accounts: &[AccountSummary],
    current_id: &str,
    custom_threshold_enabled: bool,
    global_threshold: f64,
) -> bool {
    accounts
        .iter()
        .filter(|account| account.id != current_id && account.auto_switch_enabled)
        .filter(|account| {
            account_meets_threshold(account, custom_threshold_enabled, global_threshold)
        })
        .all(|account| {
            account.usage.error.is_none() && !reported_quota_windows_have_remaining(&account.usage)
        })
}

#[cfg(test)]
fn account_with_lowest_remaining_primary_quota<'a>(
    accounts: &'a [AccountSummary],
    current_id: &str,
    custom_priority_enabled: bool,
    custom_threshold_enabled: bool,
    global_threshold: f64,
) -> Option<&'a AccountSummary> {
    ranked_backup_accounts(
        accounts,
        current_id,
        custom_priority_enabled,
        custom_threshold_enabled,
        global_threshold,
    )
    .into_iter()
    .next()
}

fn ranked_backup_accounts<'a>(
    accounts: &'a [AccountSummary],
    current_id: &str,
    custom_priority_enabled: bool,
    custom_threshold_enabled: bool,
    global_threshold: f64,
) -> Vec<&'a AccountSummary> {
    let mut ranked = accounts
        .iter()
        .filter(|account| account.id != current_id)
        .filter(|account| account.auto_switch_enabled)
        .filter_map(|account| {
            let score = primary_remaining_quota_score(&account.usage)?;
            account_meets_threshold(account, custom_threshold_enabled, global_threshold)
                .then_some((account, score))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|(left_account, left_usage), (right_account, right_usage)| {
        let priority_order = if custom_priority_enabled {
            left_account
                .auto_switch_priority
                .cmp(&right_account.auto_switch_priority)
        } else {
            std::cmp::Ordering::Equal
        };
        priority_order.then_with(|| {
            left_usage
                .partial_cmp(right_usage)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    ranked.into_iter().map(|(account, _)| account).collect()
}

#[derive(Clone)]
enum UpstreamQuotaEvent {
    Retry {
        exhausted_account_ids: HashSet<String>,
    },
    RetryTimedOut,
}

fn handle_upstream_quota_event<R: Runtime>(
    app: &tauri::AppHandle<R>,
    response: &UpstreamPayload,
    event: UpstreamQuotaEvent,
) -> bool {
    match event {
        UpstreamQuotaEvent::Retry {
            exhausted_account_ids,
        } => try_switch_official_account_after_quota(app, response, &exhausted_account_ids),
        UpstreamQuotaEvent::RetryTimedOut => {
            if let Err(error) = try_disable_official_account_after_429_timeout(app, response) {
                log_proxy_error!(
                    "failed to automatically disable official account after 429 retry timeout: {error}"
                );
            }
            false
        }
    }
}

fn try_disable_official_account_after_429_timeout<R: Runtime>(
    app: &tauri::AppHandle<R>,
    response: &UpstreamPayload,
) -> Result<(), String> {
    let paths = resolve_paths(app)?;
    let state = read_state(&paths);
    let settings = read_app_settings(app)?;
    let Some(account_id) = account_to_disable_after_429_timeout(response, &state, &settings) else {
        return Ok(());
    };
    let changed =
        crate::commands::set_account_auto_switch_enabled_for_paths(&paths, account_id, false)?;
    if changed {
        app.emit("accounts-changed", ())
            .map_err(|error| error.to_string())?;
        crate::system_tray::refresh_menu(app);
    }
    Ok(())
}

fn account_to_disable_after_429_timeout<'a>(
    response: &'a UpstreamPayload,
    state: &ManagerStateFile,
    settings: &AppSettings,
) -> Option<&'a str> {
    if response.status != 429
        || !state.auto_switch_on_quota_exhaustion
        || state.concurrent_account_routing_enabled
        || !state.auto_disable_unreachable_accounts
        || !settings.auto_disable_status_codes.contains(&429)
    {
        return None;
    }
    response
        .token_usage_account
        .as_ref()
        .filter(|account| credential_can_trigger_auto_switch(account))
        .map(|account| account.account_id.as_str())
}

pub(crate) fn maybe_switch_official_account_below_threshold<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<bool, String> {
    let paths = resolve_paths(app)?;
    let state = read_state(&paths);
    if !state.auto_switch_on_quota_exhaustion
        || state.concurrent_account_routing_enabled
        || !state.custom_auto_switch_threshold_enabled
        || state.active_provider_id.is_some()
        || state.active_provider_group.is_some()
    {
        return Ok(false);
    }
    let Some(current_id) = state.active_account_id else {
        return Ok(false);
    };
    if state.disabled_account_ids.contains(&current_id) {
        return Ok(false);
    }
    let usage = load_usage(&usage_path(&paths, &current_id));
    let Some(primary) = usage.primary.as_ref() else {
        return Ok(false);
    };
    let threshold = effective_auto_switch_threshold(
        load_auto_switch_threshold(&auto_switch_threshold_path(&paths, &current_id)),
        state.global_auto_switch_threshold,
        true,
    );
    if usage.error.is_some() || primary.remaining_percent >= threshold {
        return Ok(false);
    }
    let (observed_generation, observed_attempt_generation, _) =
        auto_switch_coordinator().account_snapshot(|| Ok(()))?;
    auto_switch_official_account(
        app,
        AutoSwitchRequest {
            observed_generation,
            observed_attempt_generation,
            failed_account_id: &current_id,
            exhausted_account_ids: &HashSet::new(),
            allow_quota_reset: true,
            requirements: AutoSwitchRequirements::default(),
        },
    )
}

fn recover_sequential_account_before_request<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &ManagerStateFile,
) -> Result<Option<bool>, String> {
    let Some(model) = official_recovery_routing::model() else {
        return Ok(None);
    };
    let Some(current_id) = &state.active_account_id else {
        return Ok(None);
    };
    if automatic_switch_is_blocked(state)
        || !official_recovery_routing::manual_selection_is_current()
        || !concurrent_quota::confirmed_exhaustion(current_id)?
    {
        return Ok(None);
    }
    let (observed_generation, observed_attempt_generation, ()) =
        auto_switch_coordinator().account_snapshot(|| Ok(()))?;
    auto_switch_official_account(
        app,
        AutoSwitchRequest {
            observed_generation,
            observed_attempt_generation,
            failed_account_id: current_id,
            exhausted_account_ids: &HashSet::from([current_id.clone()]),
            allow_quota_reset: false,
            requirements: AutoSwitchRequirements {
                model: Some(model),
                official_only: true,
                manual_selection: official_recovery_routing::observation()
                    .map(|(_, version)| version),
            },
        },
    )
    .map(Some)
}

fn effective_auto_switch_threshold(
    account_threshold: f64,
    global_threshold: f64,
    custom_threshold_enabled: bool,
) -> f64 {
    if !custom_threshold_enabled {
        return 0.0;
    }
    account_threshold.max(global_threshold)
}

fn account_meets_threshold(
    account: &AccountSummary,
    custom_threshold_enabled: bool,
    global_threshold: f64,
) -> bool {
    if !custom_threshold_enabled {
        return true;
    }
    let threshold = effective_auto_switch_threshold(
        account.auto_switch_threshold,
        global_threshold,
        custom_threshold_enabled,
    );
    primary_remaining_quota_score(&account.usage).is_some_and(|remaining| remaining >= threshold)
}

fn ensure_active_official_account_meets_threshold<R: Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), String> {
    let paths = resolve_paths(app)?;
    let state = read_state(&paths);
    if !state.auto_switch_on_quota_exhaustion || !state.custom_auto_switch_threshold_enabled {
        return Ok(());
    }
    let Some(current_id) = state.active_account_id else {
        return Ok(());
    };
    let usage = load_usage(&usage_path(&paths, &current_id));
    let Some(primary) = usage.primary.as_ref() else {
        return Ok(());
    };
    let threshold = effective_auto_switch_threshold(
        load_auto_switch_threshold(&auto_switch_threshold_path(&paths, &current_id)),
        state.global_auto_switch_threshold,
        true,
    );
    if usage.error.is_none() && primary.remaining_percent < threshold {
        return Err("No enabled official account meets the configured usage threshold".to_string());
    }
    Ok(())
}
