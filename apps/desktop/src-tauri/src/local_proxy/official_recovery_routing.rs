//! Model requirements and catalog observations belong to one Responses request.
use super::{
    concurrent_quota, fetch_candidate_official_model_catalog, gui_routing, header_value,
    is_response_create_endpoint, model_catalog_deadline, request_path, responses_lite,
    ActiveTarget, TokenUsageAccount,
};
use serde_json::Value;
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    time::Instant,
};
use tauri::{AppHandle, Runtime};
use tiny_http::Method;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Model {
    slug: String,
    effort: Option<String>,
}

impl Model {
    fn from_request(
        method: &Method,
        path: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Option<Self> {
        if *method != Method::Post || !is_response_create_endpoint(path) {
            return None;
        }
        let encoding = header_value(headers, "content-encoding").unwrap_or("identity");
        let body = responses_lite::decode(body, encoding).ok()?;
        let input: RequestOptions = serde_json::from_slice(&body).ok()?;
        let slug = input
            .model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(crate::providers::official_model);
        let effort = input.reasoning.and_then(|reasoning| reasoning.effort);
        Some(Self { slug, effort })
    }

    fn supported_by(&self, catalog: &Value) -> bool {
        catalog["models"].as_array().is_some_and(|models| {
            models.iter().any(|entry| {
                let slug = entry["slug"].as_str().or_else(|| entry["id"].as_str());
                slug == Some(self.slug.as_str())
                    && entry["visibility"].as_str() != Some("hide")
                    && self.effort.as_ref().is_none_or(|effort| {
                        entry["supported_reasoning_levels"]
                            .as_array()
                            .is_some_and(|levels| {
                                levels
                                    .iter()
                                    .any(|level| level["effort"].as_str() == Some(effort.as_str()))
                            })
                    })
            })
        })
    }
}

#[derive(serde::Deserialize)]
struct RequestOptions {
    model: Option<String>,
    reasoning: Option<Reasoning>,
}

#[derive(serde::Deserialize)]
struct Reasoning {
    effort: Option<String>,
}

struct Request {
    model: Model,
    candidates: HashMap<String, bool>,
    catalog_deadline: Option<tokio::time::Instant>,
    concurrent_retry: Option<ConcurrentRetry>,
    started_at: Instant,
    manual_selection: Option<u64>,
    approved_destination: Option<Destination>,
}

struct ConcurrentRetry {
    allow_reset: bool,
    failed: HashSet<String>,
}

#[derive(Clone)]
pub(super) enum Destination {
    Account(String),
    Provider(String),
}

pub(super) fn route_changed() -> String {
    super::request_error::RequestError::http(super::request_error::Stage::Responses, 409).wire()
}

pub(super) fn is_route_changed(error: &str) -> bool {
    super::request_error::RequestError::decode(error)
        == Some(super::request_error::RequestError::http(
            super::request_error::Stage::Responses,
            409,
        ))
}

impl Destination {
    pub(super) fn permits(&self, target: &ActiveTarget) -> bool {
        match (self, target) {
            (Self::Account(_), ActiveTarget::Official { .. }) => true,
            (Self::Provider(id), ActiveTarget::Provider(provider)) => id == &provider.id,
            _ => false,
        }
    }
}

thread_local! {
    static REQUEST: RefCell<Option<Request>> = const { RefCell::new(None) };
}

pub(super) struct Scope(Option<Request>);

impl Scope {
    pub(super) fn enter(
        method: &Method,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Self {
        let gui_url = gui_routing::upstream_path(url);
        let path = request_path(gui_url.unwrap_or(url));
        let request = Model::from_request(method, path, headers, body).map(|model| Request {
            model,
            candidates: HashMap::new(),
            catalog_deadline: None,
            concurrent_retry: None,
            started_at: Instant::now(),
            manual_selection: gui_url
                .is_none()
                .then(crate::commands::manual_account_selection),
            approved_destination: None,
        });
        Self(REQUEST.replace(request))
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        REQUEST.replace(self.0.take());
    }
}

pub(super) fn model() -> Option<Model> {
    REQUEST.with_borrow(|request| request.as_ref().map(|request| request.model.clone()))
}

pub(super) fn observation() -> Option<(Instant, u64)> {
    REQUEST.with_borrow(|request| {
        let request = request.as_ref()?;
        Some((request.started_at, request.manual_selection?))
    })
}

pub(super) fn manual_selection_is_current() -> bool {
    observation().is_none_or(|(_, version)| version == crate::commands::manual_account_selection())
}

pub(super) fn approve_account(id: String) {
    approve(Destination::Account(id));
}

pub(super) fn approve_provider(id: String) {
    approve(Destination::Provider(id));
}

fn approve(destination: Destination) {
    REQUEST.with_borrow_mut(|request| {
        if let Some(request) = request {
            request.approved_destination = Some(destination);
        }
    });
}

pub(super) fn approved_destination() -> Option<Destination> {
    REQUEST.with_borrow(|request| {
        request
            .as_ref()
            .and_then(|request| request.approved_destination.clone())
    })
}

pub(super) fn attempt_can_change_route_on_quota() -> bool {
    super::official_websocket::attempt_can_change_route_on_quota()
}

pub(super) fn release_pin_for_route_change(pinned_account: &mut Option<TokenUsageAccount>) {
    *pinned_account = None;
    super::official_websocket::clear_retry_account();
}

pub(super) fn observe_shared_exhaustion(account: &TokenUsageAccount, observation: (Instant, u64)) {
    let result = with_current_selection(observation.1, || {
        let may_switch =
            account.auto_switch_eligible || account.concurrent_request_started_at.is_some();
        if !may_switch {
            return Ok(());
        }
        let started_at = account
            .concurrent_request_started_at
            .unwrap_or(observation.0);
        concurrent_quota::record_confirmed_exhaustion(&account.account_id, started_at)
    });
    if let Err(error) = result {
        log_proxy_error!("could not record official quota exhaustion: {error}");
    }
}

pub(super) fn exclude_quota_response(
    response: &super::UpstreamPayload,
) -> Result<Option<bool>, String> {
    let Some((started_at, version)) = observation() else {
        return concurrent_quota::exclude_response(response).map(Some);
    };
    with_current_selection(version, || {
        let excluded = concurrent_quota::exclude_response(response)?;
        if let Some(account) = response
            .token_usage_account
            .as_ref()
            .filter(|account| !excluded && account.auto_switch_eligible)
        {
            concurrent_quota::record_confirmed_exhaustion(&account.account_id, started_at)?;
        }
        Ok(excluded)
    })
}

fn with_current_selection<T>(
    version: u64,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<Option<T>, String> {
    let _guard = crate::commands::account_switch_lock()
        .lock()
        .map_err(|_| "Account switch lock is poisoned".to_string())?;
    if version != crate::commands::manual_account_selection() {
        return Ok(None);
    }
    action().map(Some)
}

pub(super) fn account_matches<R: Runtime>(app: &AppHandle<R>, account_id: &str) -> bool {
    let info = REQUEST.with_borrow_mut(|request| {
        let request = request.as_mut()?;
        let deadline = *request
            .catalog_deadline
            .get_or_insert_with(model_catalog_deadline::official_deadline);
        Some((
            request.model.clone(),
            request.candidates.get(account_id).copied(),
            deadline,
        ))
    });
    let Some((model, cached, deadline)) = info else {
        return true;
    };
    if let Some(matches) = cached {
        return matches;
    }
    let matches = tokio::time::Instant::now() < deadline
        && fetch_candidate_official_model_catalog(app, account_id, deadline)
            .is_ok_and(|catalog| model.supported_by(&catalog));
    REQUEST.with_borrow_mut(|request| {
        if let Some(request) = request {
            request.candidates.insert(account_id.to_owned(), matches);
        }
    });
    matches
}

pub(super) fn record_concurrent_rejection(account_id: &str, allow_reset: bool) -> bool {
    REQUEST.with_borrow_mut(|request| {
        let Some(request) = request else { return false };
        let retry = request
            .concurrent_retry
            .get_or_insert_with(|| ConcurrentRetry {
                allow_reset,
                failed: HashSet::new(),
            });
        retry.allow_reset &= allow_reset;
        retry.failed.insert(account_id.to_owned());
        true
    })
}

pub(super) fn is_concurrent_retry() -> bool {
    with_concurrent_retry(|_| ()).is_some()
}

pub(super) fn allows_concurrent_reset() -> bool {
    with_concurrent_retry(|retry| retry.allow_reset).unwrap_or(true)
}

pub(super) fn concurrent_account_untried(account_id: &str) -> bool {
    with_concurrent_retry(|retry| !retry.failed.contains(account_id)).unwrap_or(true)
}

pub(super) fn record_concurrent_restoration(accounts: &[String]) {
    REQUEST.with_borrow_mut(|request| {
        if let Some(retry) = request
            .as_mut()
            .and_then(|request| request.concurrent_retry.as_mut())
        {
            retry.allow_reset = false;
            retry.failed.retain(|id| !accounts.contains(id));
        }
    });
}

fn with_concurrent_retry<T>(read: impl FnOnce(&ConcurrentRetry) -> T) -> Option<T> {
    REQUEST.with_borrow(|request| request.as_ref()?.concurrent_retry.as_ref().map(read))
}
