fn upstream_429_retry_timeout<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Duration, String> {
    let seconds = read_app_settings(app)?
        .upstream_429_retry_timeout_seconds
        .clamp(
            MIN_UPSTREAM_429_RETRY_TIMEOUT_SECONDS,
            MAX_UPSTREAM_429_RETRY_TIMEOUT_SECONDS,
        );
    Ok(Duration::from_secs(seconds))
}

fn retry_upstream_request<F, S>(
    timeout: Duration,
    request: F,
    handle_quota_event: S,
) -> Result<UpstreamPayload, String>
where
    F: FnMut() -> Result<UpstreamPayload, String>,
    S: FnMut(&UpstreamPayload, UpstreamQuotaEvent) -> bool,
{
    let started_at = Instant::now();
    retry_upstream_request_with(timeout, request, handle_quota_event, |delay| {
        thread::sleep(delay.min(timeout.saturating_sub(started_at.elapsed())));
        started_at.elapsed()
    })
}

/// Aggregates own their entire attempt budget; a final 429 must not start a second round.
fn retry_upstream_request_for_target<F, S>(
    aggregate: bool,
    timeout: Duration,
    mut request: F,
    handle_quota_event: S,
) -> Result<UpstreamPayload, String>
where
    F: FnMut() -> Result<UpstreamPayload, String>,
    S: FnMut(&UpstreamPayload, UpstreamQuotaEvent) -> bool,
{
    if aggregate {
        request()
    } else {
        retry_upstream_request(timeout, request, handle_quota_event)
    }
}

fn retry_upstream_request_with<F, S, W>(
    timeout: Duration,
    mut request: F,
    mut handle_quota_event: S,
    mut wait_before_retry: W,
) -> Result<UpstreamPayload, String>
where
    F: FnMut() -> Result<UpstreamPayload, String>,
    S: FnMut(&UpstreamPayload, UpstreamQuotaEvent) -> bool,
    W: FnMut(Duration) -> Duration,
{
    let mut attempt = 0_u64;
    let mut retry_number = 0_u16;
    let mut quota_retry = QuotaRetryState::default();
    let mut recovery_rejection = None;
    let mut pinned_account = None;
    loop {
        attempt = attempt.saturating_add(1);
        let started = Instant::now();
        diagnostic_event(json!({ "event": "upstream_attempt_started", "attempt": attempt }));
        official_websocket::begin_attempt();
        let result = request();
        diagnostic_attempt(&result, attempt, started);
        let mut response = match (result, recovery_rejection.take()) {
            (Err(error), Some(rejection)) if recovery_unavailable(&error) => return Ok(rejection),
            (result, _) => result?,
        };
        let confirmed_quota = is_official_quota_exhaustion(&response);
        let excluded = if confirmed_quota {
            restore_pinned_account_attribution(&mut response, pinned_account.as_ref());
            let Some(excluded) = official_recovery_routing::exclude_quota_response(&response)?
            else {
                return Ok(response);
            };
            excluded
        } else {
            concurrent_quota::exclude_response(&response)?
        };
        // A confirmed concurrent quota failure invalidates cached eligibility before
        // any backoff, including when the normal 429 retry budget is exhausted.
        let can_change_route = if confirmed_quota {
            official_recovery_routing::attempt_can_change_route_on_quota()
        } else {
            official_websocket::attempt_can_change_route()
        };
        if excluded {
            if !can_change_route {
                return Ok(response);
            }
            diagnostic_retry("concurrent_account_excluded", Duration::ZERO);
            record_retried_proxy_response(&response);
            if retain_concurrent_rejection(&response, confirmed_quota) {
                recovery_rejection = Some(response);
            }
            official_recovery_routing::release_pin_for_route_change(&mut pinned_account);
            continue;
        }
        if can_change_route
            && switch_exhausted_account(&response, &mut quota_retry, &mut handle_quota_event)
        {
            diagnostic_retry("quota_account_switch", Duration::ZERO);
            record_retried_proxy_response(&response);
            if confirmed_quota && official_recovery_routing::approved_destination().is_some() {
                recovery_rejection = Some(response);
            }
            official_recovery_routing::release_pin_for_route_change(&mut pinned_account);
            continue;
        }
        // Confirmed exhaustion cannot recover through backoff without a new target.
        if response.status != 429 || confirmed_quota {
            return Ok(response);
        }
        retry_number = retry_number.saturating_add(1);
        let delay = upstream_429_retry_delay(retry_number);
        diagnostic_retry("rate_limit", delay);
        let elapsed = wait_before_retry(delay);
        if elapsed >= timeout {
            diagnostic_event(json!({ "event": "retry_budget_exhausted", "attempt": attempt }));
            let _ = handle_quota_event(&response, UpstreamQuotaEvent::RetryTimedOut);
            return Ok(response);
        }
        if !can_change_route {
            let Some(account) = response.token_usage_account.as_ref() else {
                return Ok(response);
            };
            official_websocket::pin_retry_account(&account.account_id);
            pinned_account.get_or_insert_with(|| account.clone());
        }
        record_retried_proxy_response(&response);
    }
}

fn retain_concurrent_rejection(response: &UpstreamPayload, confirmed_quota: bool) -> bool {
    if !confirmed_quota && !official_recovery_routing::is_concurrent_retry() {
        return false;
    }
    response
        .token_usage_account
        .as_ref()
        .is_some_and(|account| {
            official_recovery_routing::record_concurrent_rejection(
                &account.account_id,
                official_websocket::attempt_can_change_route(),
            )
        })
}

fn restore_pinned_account_attribution(
    response: &mut UpstreamPayload,
    pinned: Option<&TokenUsageAccount>,
) {
    let Some(pinned) = pinned else { return };
    if let Some(account) = response.token_usage_account.as_mut() {
        if account.account_id == pinned.account_id {
            *account = pinned.clone();
        }
    }
}

fn recovery_unavailable(error: &str) -> bool {
    error == NO_AVAILABLE_CONCURRENT_ACCOUNT || official_recovery_routing::is_route_changed(error)
}

#[derive(Default)]
struct QuotaRetryState {
    exhausted_account_ids: HashSet<String>,
    switched_account_ids: HashSet<String>,
}

fn switch_exhausted_account(
    response: &UpstreamPayload,
    quota_retry: &mut QuotaRetryState,
    handle_quota_event: &mut impl FnMut(&UpstreamPayload, UpstreamQuotaEvent) -> bool,
) -> bool {
    let Some(account) = response.token_usage_account.as_ref() else {
        return false;
    };
    if !account_failure::requires_account_failover(response) {
        return false;
    }
    quota_retry
        .exhausted_account_ids
        .insert(account.account_id.clone());
    if quota_retry
        .switched_account_ids
        .contains(&account.account_id)
    {
        return false;
    }
    // Quota exhaustion and rejected credentials need a different account, even if the retry budget has
    // expired. Retry a successful switch immediately, before any backoff or auto-disable.
    let event = UpstreamQuotaEvent::Retry {
        exhausted_account_ids: quota_retry.exhausted_account_ids.clone(),
    };
    let switched = handle_quota_event(response, event);
    diagnostic_event(json!({
        "event": "quota_switch_result", "switched": switched,
        "account": diagnostic_account(account)
    }));
    if !switched {
        return false;
    }
    // Stale positive usage can send us back to an exhausted account. Bound immediate
    // failovers per request so that cycle terminates with the quota error.
    quota_retry
        .switched_account_ids
        .insert(account.account_id.clone());
    true
}
