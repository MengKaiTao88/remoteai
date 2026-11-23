//! Optional HTTP-to-WebSocket forwarding at the official Responses account boundary.
mod cache;
mod metadata;
mod outcome;
mod rejection;
mod request;
mod socket;
mod stream;

use super::{
    apply_official_authentication, diagnostic_event, header_value, is_response_create_endpoint,
    json_payload, lan_keys, official_body_for_upstream, proxy_session_id, request_error,
    request_path, responses_lite, OfficialRequestAuthentication, UpstreamPayload, ORIGINATOR,
};
use cache::{AccountRoute, Lease, Owner, Scope};
pub(super) use outcome::Outcome;
use outcome::{HttpRoute, Reason, UploadMode};
use reqwest::{blocking::Client, header, Url};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use tauri::{Manager, Runtime};
use tiny_http::Method;

use metadata::TURN_STATE;

const MAX_SESSION_BYTES: usize = 512;

#[derive(Default)]
struct Settings {
    enabled: bool,
    gui: bool,
    change_route: bool,
    retry_account: Option<String>,
    sent: Option<SentRequest>,
}

thread_local! {
    static SETTINGS: RefCell<Settings> = RefCell::new(Settings::default());
}

pub(super) struct RequestScope(Settings);

impl RequestScope {
    pub(super) fn enter(enabled: bool, gui: bool) -> Self {
        Self(SETTINGS.replace(Settings {
            enabled,
            gui,
            change_route: true,
            retry_account: None,
            sent: None,
        }))
    }
}

impl Drop for RequestScope {
    fn drop(&mut self) {
        SETTINGS.replace(std::mem::take(&mut self.0));
    }
}

pub(super) fn begin_attempt() {
    SETTINGS.with_borrow_mut(|settings| settings.change_route = true);
}

pub(super) fn attempt_can_change_route() -> bool {
    SETTINGS.with_borrow(|settings| !settings.enabled || settings.change_route)
}

fn block_route_change() {
    SETTINGS.with_borrow_mut(|settings| settings.change_route = false);
}

pub(super) fn pin_retry_account(account: &str) {
    SETTINGS.with_borrow_mut(|settings| settings.retry_account = Some(account.into()));
}

pub(super) fn retry_account() -> Option<String> {
    SETTINGS.with_borrow(|settings| settings.retry_account.clone())
}

struct SentRequest {
    account: String,
    transport: Transport,
}

fn strip_old_routing_hint(account: &str) -> bool {
    SETTINGS.with_borrow(|settings| {
        settings.sent.as_ref().is_some_and(|sent| {
            sent.account != account || matches!(sent.transport, Transport::WebSocket)
        })
    })
}

pub(super) fn record_http_started(account: &str) {
    record_send_started(account, Transport::Http);
}

fn record_send_started(account: &str, transport: Transport) {
    SETTINGS.with_borrow_mut(|settings| {
        if settings.enabled {
            settings.sent.get_or_insert_with(|| SentRequest {
                account: account.into(),
                transport,
            });
        }
    });
}

pub(super) enum Transport {
    WebSocket,
    Http,
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

pub(super) fn send<R: Runtime>(params: Request<'_, R>, transport: Transport) -> Outcome {
    let scope = continuation_scope(params.app, params.headers);
    let mut route = HttpRoute {
        scope,
        strip_routing_hint: strip_old_routing_hint(params.account),
        body: None,
    };
    if *params.method != Method::Post {
        route.scope = None;
        return Outcome::Http(route);
    }
    if !enabled_for(params.method, params.path) {
        invalidate_route(&route);
        route.scope = None;
        return Outcome::Http(route);
    }
    let mut options = prepared_options(&params);
    let account_bound = guard_replay(params.headers, options.as_ref());
    if !check_account(&mut route, params.account, account_bound) {
        return Outcome::Response(account_conflict());
    }
    route.body = match sanitize_inbound(&mut options, params.headers) {
        Ok(body) => body,
        Err(error) => return Outcome::Failed(error),
    };
    if matches!(transport, Transport::Http) {
        invalidate_route(&route);
        return Outcome::Http(route);
    }
    let turn = options.and_then(|options| request::Turn::from_body(options, params.headers));
    match (route.scope.clone(), turn, Upstream::from_request(&params)) {
        (Some(scope), Some(turn), Some(upstream))
            if header_value(params.headers, TURN_STATE).is_none() =>
        {
            match prepare(scope, upstream, turn) {
                Ok(prepared) => Outcome::from(prepared.send()),
                Err(reason) => fallback(route, reason),
            }
        }
        _ => {
            invalidate_route(&route);
            Outcome::Http(route)
        }
    }
}

fn check_account(route: &mut HttpRoute, account: &str, account_bound: bool) -> bool {
    let Some(scope) = route.scope.as_ref() else {
        return true;
    };
    match cache::account_route(scope, account) {
        AccountRoute::ChangedAccount | AccountRoute::Unavailable if account_bound => {
            cache::invalidate(scope);
            false
        }
        AccountRoute::ChangedAccount => {
            route.strip_routing_hint = true;
            true
        }
        _ => true,
    }
}

fn account_conflict() -> UpstreamPayload {
    let error = json!({"code":"permission_denied", "type":"invalid_request_error"});
    let message = request_error::upstream(request_error::Stage::Responses, &error).to_string();
    json_payload(
        409,
        json!({"error": {
            "code":"permission_denied", "type":"invalid_request_error", "message":message
        }}),
    )
}

fn fallback(route: HttpRoute, reason: Reason) -> Outcome {
    diagnostic_event(json!({
        "event": "official_websocket_fallback", "transport": "http", "reason": reason
    }));
    invalidate_route(&route);
    Outcome::Http(route)
}

fn invalidate_route(route: &HttpRoute) {
    if let Some(scope) = route.scope.as_ref() {
        cache::invalidate(scope);
    }
}

fn sanitize_inbound(
    options: &mut Option<Map<String, Value>>,
    headers: &[(String, String)],
) -> Result<Option<Vec<u8>>, String> {
    let Some(options) = options.as_mut() else {
        return Ok(None);
    };
    if metadata::strip_client_turn_state(options) {
        return sanitized_body(options, headers).map(Some);
    }
    Ok(None)
}

fn sanitized_body(
    options: &Map<String, Value>,
    headers: &[(String, String)],
) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(options).map_err(|_| {
        request_error::RequestError::new(
            request_error::Stage::Responses,
            request_error::Problem::Encode,
        )
        .wire()
    })?;
    let encoding = header_value(headers, "content-encoding").unwrap_or("identity");
    responses_lite::encode(&bytes, encoding).map_err(|error| error.wire())
}

pub(super) fn guard_credential_replay(
    method: &Method,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
) {
    if enabled_for(method, path) {
        let options = decoded_body(headers, body).and_then(|bytes| parse_options(&bytes));
        guard_replay(headers, options.as_ref());
    }
}

fn enabled_for(method: &Method, path: &str) -> bool {
    SETTINGS.with_borrow(|settings| settings.enabled)
        && *method == Method::Post
        && is_response_create_endpoint(request_path(path))
}

fn guard_replay(headers: &[(String, String)], options: Option<&Map<String, Value>>) -> bool {
    let account_bound =
        header_value(headers, TURN_STATE).is_some() || options.is_some_and(request::account_bound);
    if account_bound || !options.is_some_and(request::replay_safe) {
        block_route_change();
    }
    account_bound
}

fn decoded_body<'a>(
    headers: &[(String, String)],
    body: &'a [u8],
) -> Option<std::borrow::Cow<'a, [u8]>> {
    let encoding = header_value(headers, "content-encoding").unwrap_or("identity");
    responses_lite::decode(body, encoding).ok()
}

fn prepared_options<R: Runtime>(params: &Request<'_, R>) -> Option<Map<String, Value>> {
    let decoded = decoded_body(params.headers, params.body)?;
    if matches!(decoded, std::borrow::Cow::Owned(_)) {
        let body = official_body_for_upstream(
            params.method,
            params.path,
            decoded.into_owned(),
            params.model,
        );
        return parse_options(&body);
    }
    parse_options(&decoded)
}

fn parse_options(body: &[u8]) -> Option<Map<String, Value>> {
    serde_json::from_slice(body).ok()
}

struct Upstream {
    owner: Owner,
    url: Url,
    headers: header::HeaderMap,
}

impl Upstream {
    fn from_request<R: Runtime>(params: &Request<'_, R>) -> Option<Self> {
        let url = Url::parse(params.url).ok()?;
        let headers = upgrade_headers(params, &url)?;
        let owner = Owner {
            account: params.account.to_owned(),
            headers: connection_fingerprint(&url, &headers)?,
        };
        Some(Self {
            owner,
            url,
            headers,
        })
    }
}

struct Prepared {
    turn: stream::SentTurn,
    request: String,
    mode: UploadMode,
    reason: Reason,
}

impl Prepared {
    fn send(self) -> Result<UpstreamPayload, String> {
        record_send_started(&self.turn.owner.account, Transport::WebSocket);
        stream::send(self.turn, self.request, self.mode, self.reason)
    }
}

fn prepare(scope: Scope, upstream: Upstream, mut turn: request::Turn) -> Result<Prepared, Reason> {
    let (lease, previous) = Lease::take(scope)?;
    let mut reason = Reason::Initial;
    if let Some(mut previous) = previous {
        match check_previous(&mut previous, &upstream.owner, &turn) {
            Ok(offset) => {
                previous.socket.advance_turn(turn.turn_id.take());
                let (request, history) = turn.encode(
                    Some((&previous.history, offset)),
                    previous.socket.turn_state(),
                );
                return Ok(Prepared {
                    turn: stream::SentTurn {
                        socket: previous.socket,
                        lease,
                        owner: upstream.owner,
                        history,
                    },
                    request,
                    mode: UploadMode::Delta,
                    reason: Reason::ConfirmedPrefix,
                });
            }
            Err(reconnect) => {
                diagnostic_event(
                    json!({"event": "official_websocket_reconnect", "reason": reconnect}),
                );
                reason = reconnect;
            }
        }
    }
    let socket = socket::Socket::connect(&upstream.url, upstream.headers, turn.turn_id.take())?;
    let (request, history) = turn.encode(None, socket.turn_state());
    Ok(Prepared {
        turn: stream::SentTurn {
            socket,
            lease,
            owner: upstream.owner,
            history,
        },
        request,
        mode: UploadMode::Full,
        reason,
    })
}

fn check_previous(
    previous: &mut cache::Connection,
    owner: &Owner,
    turn: &request::Turn,
) -> Result<usize, Reason> {
    if previous.owner != *owner {
        return Err(Reason::ConnectionOwnerChanged);
    }
    let index = turn.extension(&previous.history)?;
    if !previous.socket.available() {
        return Err(Reason::ConnectionClosed);
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
        gui: SETTINGS.with_borrow(|settings| settings.gui),
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
