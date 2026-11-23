//! Optional HTTP-to-WebSocket forwarding at the official Responses account boundary.
mod cache;
mod request;
mod socket;
mod stream;

use super::{
    apply_official_authentication, diagnostic_event, header_value, is_response_create_endpoint,
    json_payload, lan_keys, official_body_for_upstream, proxy_session_id, request_error,
    request_path, responses_lite, OfficialRequestAuthentication, UpstreamPayload, ORIGINATOR,
};
use cache::{Lease, Owner, Scope};
use reqwest::{blocking::Client, header, Url};
use serde_json::{json, Map, Value};
use std::cell::Cell;
use tauri::{Manager, Runtime};
use tiny_http::Method;

const MAX_SESSION_BYTES: usize = 512;
const TURN_STATE: &str = "x-codex-turn-state";

#[derive(Clone, Copy, Default)]
struct Settings {
    enabled: bool,
    gui: bool,
    replay: bool,
    websocket_send_started: bool,
}

thread_local! {
    static SETTINGS: Cell<Settings> = Cell::new(Settings::default());
}

pub(super) struct RequestScope(Settings);

impl RequestScope {
    pub(super) fn enter(enabled: bool, gui: bool) -> Self {
        Self(SETTINGS.replace(Settings {
            enabled,
            gui,
            replay: true,
            websocket_send_started: false,
        }))
    }
}

impl Drop for RequestScope {
    fn drop(&mut self) {
        SETTINGS.set(self.0);
    }
}

pub(super) fn allow_replay_for_attempt() {
    let current = SETTINGS.get();
    SETTINGS.set(Settings {
        replay: true,
        ..current
    });
}

pub(super) fn attempt_can_replay() -> bool {
    let settings = SETTINGS.get();
    !settings.enabled || settings.replay
}

fn block_replay() {
    let current = SETTINGS.get();
    SETTINGS.set(Settings {
        replay: false,
        ..current
    });
}

pub(super) fn strip_old_routing_hint() -> bool {
    SETTINGS.get().websocket_send_started
}

fn record_send_started() {
    let current = SETTINGS.get();
    SETTINGS.set(Settings {
        websocket_send_started: true,
        ..current
    });
}

pub(super) struct Request<'a, R: Runtime> {
    pub(super) app: &'a tauri::AppHandle<R>,
    pub(super) client: &'a Client,
    pub(super) method: &'a Method,
    pub(super) path: &'a str,
    pub(super) url: &'a str,
    pub(super) headers: &'a [(String, String)],
    pub(super) body: &'a [u8],
    pub(super) model: &'a str,
    pub(super) authentication: &'a OfficialRequestAuthentication,
    pub(super) account: &'a str,
}

pub(super) fn send<R: Runtime>(params: Request<'_, R>) -> Option<Result<UpstreamPayload, String>> {
    if *params.method != Method::Post {
        return None;
    }
    let scope = continuation_scope(params.app, params.headers)?;
    if !SETTINGS.get().enabled || !is_response_create_endpoint(request_path(params.path)) {
        cache::invalidate(&scope);
        return None;
    }
    let options = prepared_options(&params);
    let has_turn_state = header_value(params.headers, TURN_STATE).is_some();
    let account_bound = has_turn_state || options.as_ref().is_some_and(request::account_bound);
    if account_bound
        || options
            .as_ref()
            .is_some_and(|options| !request::replay_safe(options))
    {
        block_replay();
    }
    if !cache::account_allowed(&scope, params.account, account_bound) {
        cache::invalidate(&scope);
        let error = json!({"code":"permission_denied", "type":"invalid_request_error"});
        let message = request_error::upstream(request_error::Stage::Responses, &error).to_string();
        return Some(Ok(json_payload(
            409,
            json!({"error": {
                "code":"permission_denied", "type":"invalid_request_error", "message":message
            }}),
        )));
    }
    let Some(turn) = options.and_then(request::Turn::from_body) else {
        cache::invalidate(&scope);
        return None;
    };
    if has_turn_state {
        cache::invalidate(&scope);
        return None;
    }
    let url = Url::parse(params.url).ok()?;
    let headers = upgrade_headers(&params, &url)?;
    let owner = Owner {
        account: params.account.to_owned(),
        headers: connection_fingerprint(&url, &headers)?,
    };
    match run(scope, owner, url, headers, turn) {
        Ok(payload) => Some(payload),
        Err(reason) => {
            diagnostic_event(json!({
                "event": "official_websocket_fallback", "transport": "http", "reason": reason
            }));
            None
        }
    }
}

pub(super) fn guard_credential_replay(
    method: &Method,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
) {
    if !SETTINGS.get().enabled
        || *method != Method::Post
        || !is_response_create_endpoint(request_path(path))
    {
        return;
    }
    let encoding = header_value(headers, "content-encoding").unwrap_or("identity");
    let safe = responses_lite::decode(body, encoding)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Map<String, Value>>(&bytes).ok())
        .is_some_and(|options| request::replay_safe(&options) && !request::account_bound(&options));
    if !safe || header_value(headers, TURN_STATE).is_some() {
        block_replay();
    }
}

fn prepared_options<R: Runtime>(params: &Request<'_, R>) -> Option<Map<String, Value>> {
    let encoding = header_value(params.headers, "content-encoding").unwrap_or("identity");
    let decoded = responses_lite::decode(params.body, encoding).ok()?;
    let options = if matches!(decoded, std::borrow::Cow::Owned(_)) {
        let body = official_body_for_upstream(
            params.method,
            params.path,
            decoded.into_owned(),
            params.model,
        );
        serde_json::from_slice(&body)
    } else {
        serde_json::from_slice(&decoded)
    };
    options.ok()
}

fn run(
    scope: Scope,
    owner: Owner,
    url: Url,
    headers: header::HeaderMap,
    turn: request::Turn,
) -> Result<Result<UpstreamPayload, String>, &'static str> {
    let (lease, previous) = Lease::take(scope)?;
    let (socket, (request, history), mode, reason) = if let Some(mut previous) = previous {
        let offset = check_previous(&mut previous, &owner, &turn);
        match offset {
            Ok(index) => (
                previous.socket,
                turn.encode(Some((&previous.history, index))),
                "delta",
                "confirmed_prefix",
            ),
            Err(reason) => {
                drop(previous);
                diagnostic_event(
                    json!({"event": "official_websocket_reconnect", "reason": reason}),
                );
                (
                    socket::Socket::connect(&url, headers)?,
                    turn.encode(None),
                    "full",
                    reason,
                )
            }
        }
    } else {
        (
            socket::Socket::connect(&url, headers)?,
            turn.encode(None),
            "full",
            "initial",
        )
    };
    record_send_started();
    Ok(stream::send(
        stream::SentTurn {
            socket,
            lease,
            owner,
            history,
        },
        request,
        mode,
        reason,
    ))
}

fn check_previous(
    previous: &mut cache::Connection,
    owner: &Owner,
    turn: &request::Turn,
) -> Result<usize, &'static str> {
    if previous.owner != *owner {
        return Err("connection_owner_changed");
    }
    let index = turn.extension(&previous.history)?;
    if !previous.socket.available() {
        return Err("connection_closed");
    }
    Ok(index)
}

fn upgrade_headers<R: Runtime>(params: &Request<'_, R>, url: &Url) -> Option<header::HeaderMap> {
    let request =
        apply_official_authentication(params.client.get(url.clone()), params.authentication)
            .header("originator", ORIGINATOR)
            .header(
                header::USER_AGENT,
                header_value(params.headers, "user-agent").unwrap_or("codex_cli_rs/0.1.0"),
            );
    let request = UPSTREAM_HEADERS.iter().fold(request, |request, name| {
        match header_value(params.headers, name) {
            Some(value) => request.header(*name, value),
            None => request,
        }
    });
    Some(request.build().ok()?.headers().clone())
}

const UPSTREAM_HEADERS: &[&str] = &[
    "thread-id",
    "session-id",
    "session_id",
    "x-codex-window-id",
    "x-codex-installation-id",
    "x-codex-parent-thread-id",
    "x-codex-beta-features",
    "x-codex-exclude",
    "x-openai-internal-codex-responses-lite",
    "x-openai-subagent",
];

fn connection_fingerprint(url: &Url, headers: &header::HeaderMap) -> Option<request::Fingerprint> {
    let mut entries = headers
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_bytes()))
        .collect::<Vec<_>>();
    entries.sort_unstable();
    request::fingerprint(&(url.as_str(), entries))
}

fn continuation_scope<R: Runtime>(
    app: &tauri::AppHandle<R>,
    headers: &[(String, String)],
) -> Option<Scope> {
    let session = proxy_session_id(headers)?;
    if session.len() > MAX_SESSION_BYTES || session.chars().any(char::is_control) {
        return None;
    }
    let client_auth = ["authorization", "api-key", "openai-api-key", "x-api-key"]
        .map(|name| header_value(headers, name));
    Some(Scope {
        workspace: app.path().app_data_dir().ok()?,
        gui: SETTINGS.get().gui,
        lan_key: lan_keys::RequestKeyScope::current(),
        client_auth: request::fingerprint(&client_auth)?,
        session,
    })
}

pub(super) fn invalidate<R: Runtime>(app: &tauri::AppHandle<R>, headers: &[(String, String)]) {
    if let Some(scope) = continuation_scope(app, headers) {
        cache::invalidate(&scope);
    }
}

pub(super) fn clear(gui: bool) {
    cache::clear(gui);
}
