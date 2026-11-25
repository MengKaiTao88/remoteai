struct AutoSwitchRequest<'a> {
    observed_generation: u64,
    observed_attempt_generation: u64,
    failed_account_id: &'a str,
    exhausted_account_ids: &'a HashSet<String>,
    allow_quota_reset: bool,
    requirements: AutoSwitchRequirements,
}

#[derive(Clone, Default, PartialEq, Eq)]
struct AutoSwitchRequirements {
    model: Option<official_recovery_routing::Model>,
    official_only: bool,
    manual_selection: Option<u64>,
}

impl AutoSwitchRequirements {
    fn selection_is_current(&self) -> bool {
        self.manual_selection
            .is_none_or(|version| version == crate::commands::manual_account_selection())
    }

    fn account_matches<R: Runtime>(&self, app: &tauri::AppHandle<R>, id: &str) -> bool {
        self.model.is_none() || official_recovery_routing::account_matches(app, id)
    }
}

fn auto_switch_official_account<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: AutoSwitchRequest<'_>,
) -> Result<bool, String> {
    if !request.requirements.selection_is_current() {
        return Ok(false);
    }
    diagnostic_event(json!({
        "event": "account_switch_started", "failedAccountHash": short_hash_str(request.failed_account_id),
        "exhaustedAccountCount": request.exhausted_account_ids.len()
    }));
    let should_retry = auto_switch_coordinator().switch_for(
        AutoSwitchObservation {
            generation: request.observed_generation,
            attempt_generation: request.observed_attempt_generation,
            failed_account_id: request.failed_account_id,
            requirements: Some(&request.requirements),
        },
        || try_auto_switch_official_account(app, &request),
        || {},
    )?;
    diagnostic_event(json!({ "event": "account_switch_finished", "retry": should_retry }));
    if !should_retry {
        return Ok(false);
    }

    // The retry resolves the active target again. A successful automatic fallback may now
    // point at either another official account or the configured third-party Provider.
    retry_after_shared_switch(app, &request)
}

fn retry_after_shared_switch<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: &AutoSwitchRequest<'_>,
) -> Result<bool, String> {
    let state = try_read_state(&resolve_paths(app)?)?;
    if !request.requirements.selection_is_current() {
        return Ok(false);
    }
    if request.requirements.model.is_none() {
        return Ok(state.active_provider_id.is_some()
            || state.active_provider_group.is_some()
            || state.active_account_id.is_some());
    }
    if state.concurrent_account_routing_enabled || !state.auto_switch_on_quota_exhaustion {
        return Ok(false);
    }
    if let Some(id) = state.active_provider_id {
        let matches = !request.requirements.official_only
            && state.auto_switch_provider_id.as_ref() == Some(&id);
        if matches {
            official_recovery_routing::approve_provider(id);
        }
        return Ok(matches);
    }
    let Some(id) = state.active_account_id else {
        return Ok(false);
    };
    let restored_current = id == request.failed_account_id
        && request.allow_quota_reset
        && !concurrent_quota::confirmed_exhaustion(&id)?;
    if state.active_provider_group.is_some()
        || state.disabled_account_ids.contains(&id)
        || (!restored_current && request.exhausted_account_ids.contains(&id))
        || (!restored_current && !request.requirements.account_matches(app, &id))
        || !request.requirements.selection_is_current()
    {
        return Ok(false);
    }
    official_recovery_routing::approve_account(id);
    Ok(true)
}

#[derive(Default)]
struct RefreshedAccounts {
    accounts: Vec<AccountSummary>,
    backup_usage_unknown: bool,
}

fn refresh_auto_switch_accounts<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: &AutoSwitchRequest<'_>,
) -> Result<Option<RefreshedAccounts>, String> {
    // The quota result that triggered this flow can be stale, so refresh every enabled
    // official account before choosing a replacement instead of relying on cached usage.
    let accounts = crate::commands::list_accounts_blocking(app.clone())?;
    if !accounts.iter().any(|account| {
        can_leave_failed_account(
            account,
            request.failed_account_id,
            request.exhausted_account_ids,
        )
    }) {
        return Ok(None);
    }
    let mut refreshed = RefreshedAccounts::default();
    for mut account in accounts
        .into_iter()
        .filter(|account| account.auto_switch_enabled)
    {
        if request.requirements.model.is_some()
            && request.exhausted_account_ids.contains(&account.id)
        {
            continue;
        }
        match crate::commands::refresh_usage_blocking(app.clone(), account.id.clone()) {
            Ok(usage) => {
                if request.requirements.model.is_some()
                    && reported_quota_windows_have_remaining(&usage)
                    && concurrent_quota::confirmed_exhaustion(&account.id)?
                {
                    refreshed.backup_usage_unknown = true;
                    continue;
                }
                account.usage = usage;
                refreshed.accounts.push(account);
            }
            Err(error) => {
                if account.id != request.failed_account_id
                    && !request.exhausted_account_ids.contains(&account.id)
                {
                    refreshed.backup_usage_unknown = true;
                }
                log_proxy_error!(
                    "failed to refresh usage for {} during automatic switch: {error}",
                    account.id
                );
            }
        }
    }
    retain_untried_auto_switch_accounts(&mut refreshed.accounts, request.exhausted_account_ids);
    Ok(Some(refreshed))
}

fn try_auto_switch_official_account<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: &AutoSwitchRequest<'_>,
) -> Result<AutoSwitchAttempt, String> {
    let paths = resolve_paths(app)?;
    let state = try_read_state(&paths)?;
    if automatic_switch_is_blocked(&state) || !request.requirements.selection_is_current() {
        return Ok(AutoSwitchAttempt::Unchanged);
    }
    if state.active_account_id.as_deref() != Some(request.failed_account_id) {
        return Ok(if state.active_account_id.is_some() {
            AutoSwitchAttempt::AlreadyChanged
        } else {
            AutoSwitchAttempt::Unchanged
        });
    }
    let Some(mut refreshed) = refresh_auto_switch_accounts(app, request)? else {
        return Ok(AutoSwitchAttempt::Unchanged);
    };
    choose_auto_switch_destination(app, &paths, request, &mut refreshed)
}

fn choose_auto_switch_destination<R: Runtime>(
    app: &tauri::AppHandle<R>,
    paths: &Paths,
    request: &AutoSwitchRequest<'_>,
    refreshed: &mut RefreshedAccounts,
) -> Result<AutoSwitchAttempt, String> {
    let state = try_read_state(paths)?;
    if !auto_switch_request_is_current(&state, request) {
        return Ok(AutoSwitchAttempt::Unchanged);
    }

    reset_priority::reload(paths, &mut refreshed.accounts, &state);
    let candidates = ranked_backup_accounts(
        &refreshed.accounts,
        request.failed_account_id,
        state.custom_auto_switch_priority_enabled,
        state.custom_auto_switch_threshold_enabled,
        state.global_auto_switch_threshold,
    );
    if let Some(target) = candidates
        .iter()
        .find(|candidate| request.requirements.account_matches(app, &candidate.id))
    {
        return commit_auto_switch(app, paths, request, &target.id);
    }
    if request.requirements.official_only
        || !candidates.is_empty()
        || refreshed.backup_usage_unknown
        || !all_backup_accounts_have_exhausted_quota(
            &refreshed.accounts,
            request.failed_account_id,
            state.custom_auto_switch_threshold_enabled,
            state.global_auto_switch_threshold,
        )
    {
        return Ok(AutoSwitchAttempt::Unchanged);
    }
    try_existing_fallback(app, paths, request)
}

fn auto_switch_request_is_current(
    state: &ManagerStateFile,
    request: &AutoSwitchRequest<'_>,
) -> bool {
    request.requirements.selection_is_current()
        && !automatic_switch_is_blocked(state)
        && state.active_account_id.as_deref() == Some(request.failed_account_id)
}

fn commit_auto_switch<R: Runtime>(
    app: &tauri::AppHandle<R>,
    paths: &Paths,
    request: &AutoSwitchRequest<'_>,
    target_id: &str,
) -> Result<AutoSwitchAttempt, String> {
    let result =
        crate::commands::switch_account_automatically_blocking(app.clone(), target_id, |state| {
            auto_switch_request_is_current(state, request)
                && !state.disabled_account_ids.iter().any(|id| id == target_id)
        });
    match result {
        Ok(false) => Ok(AutoSwitchAttempt::Unchanged),
        Ok(true) => Ok(AutoSwitchAttempt::Switched),
        Err(error) => {
            // Post-switch events can fail after selection is committed.
            let state = read_state(paths);
            if state.active_provider_id.is_some()
                || state.active_account_id.as_deref() != Some(target_id)
            {
                return Err(error);
            }
            log_proxy_error!("automatic account switch to {target_id} completed with a post-switch error: {error}");
            Ok(AutoSwitchAttempt::Switched)
        }
    }
}

fn try_existing_fallback<R: Runtime>(
    app: &tauri::AppHandle<R>,
    paths: &Paths,
    request: &AutoSwitchRequest<'_>,
) -> Result<AutoSwitchAttempt, String> {
    if !auto_switch_request_is_current(&try_read_state(paths)?, request) {
        return Ok(AutoSwitchAttempt::Unchanged);
    }
    // Reset cards restore quota, not login credentials.
    let restored = if request.allow_quota_reset {
        auto_reset::restore(app)
    } else {
        Ok(Vec::new())
    };
    match restored {
        Ok(restored) if !restored.is_empty() => {
            if !auto_switch_request_is_current(&try_read_state(paths)?, request) {
                return Ok(AutoSwitchAttempt::Unchanged);
            }
            let Some(target) = restored.iter().find(|id| {
                id.as_str() == request.failed_account_id
                    || request.requirements.account_matches(app, id)
            }) else {
                return Ok(AutoSwitchAttempt::Unchanged);
            };
            if target != request.failed_account_id {
                return commit_auto_switch(app, paths, request, target);
            }
            return Ok(AutoSwitchAttempt::Switched);
        }
        Err(error) => log_proxy_error!("automatic quota reset failed: {error}"),
        _ => {}
    }
    let state = try_read_state(paths)?;
    if !auto_switch_request_is_current(&state, request) {
        return Ok(AutoSwitchAttempt::Unchanged);
    }
    let Some(provider_id) = state.auto_switch_provider_id else {
        return Ok(AutoSwitchAttempt::Unchanged);
    };
    let provider = providers::read_provider(paths, &provider_id)?;
    if provider.kind != ProviderKind::Custom {
        return Ok(AutoSwitchAttempt::Unchanged);
    }
    let result = providers::switch_provider_automatically_blocking(app, &provider_id, |state| {
        auto_switch_request_is_current(state, request)
            && state.auto_switch_provider_id.as_ref() == Some(&provider_id)
    });
    if let Err(error) = result {
        let state = read_state(paths);
        if state.active_provider_id.as_deref() == Some(&provider_id) {
            log_proxy_error!(
                "automatic fallback to Provider {provider_id} completed with a post-switch error: {error}"
            );
            return Ok(AutoSwitchAttempt::Switched);
        }
        return Err(error);
    }
    Ok(if result? {
        AutoSwitchAttempt::Switched
    } else {
        AutoSwitchAttempt::Unchanged
    })
}
