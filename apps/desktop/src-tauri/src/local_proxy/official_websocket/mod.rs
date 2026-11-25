//! Account ownership and optional WebSocket forwarding for official Responses.
mod account_context;
mod account_context_copy;
mod cache;
mod context_store;
mod http_context;
mod metadata;
mod outcome;
mod rejection;
mod request;
mod request_scope;
mod socket;
mod stream;

use super::{
    apply_official_authentication, diagnostic_event, header_value, is_response_create_endpoint,
    is_responses_endpoint, json_payload, lan_keys, official_body_for_upstream, proxy_session_id,
    request_error, request_path, responses_lite, OfficialRequestAuthentication, UpstreamPayload,
    ORIGINATOR,
};
use cache::{Lease, Owner, Scope};
use context_store::ContextStore;
pub(super) use outcome::{HttpHeaders, Outcome};
use outcome::{HttpRoute, Reason, UploadMode};
use reqwest::{blocking::Client, header, Url};
use serde_json::{json, Map, Value};
use tauri::{Manager, Runtime};
use tiny_http::Method;

use metadata::TURN_STATE;
pub(super) use request_scope::{
    attempt_can_change_route, attempt_can_change_route_on_quota, begin_attempt,
    clear_retry_account, pin_retry_account, record_http_started, retry_account, RequestScope,
};
use request_scope::{guard_replay, record_send_started, strip_old_routing_hint};

const MAX_SESSION_BYTES: usize = 512;

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
    let path = request_path(params.path);
    let mut route = HttpRoute {
        scope: continuation_scope(params.app, params.headers),
        headers: HttpHeaders {
            strip_routing_hint: strip_old_routing_hint(params.account),
            strip_turn_state: false,
        },
        body: None,
        context: None,
    };
    if *params.method != Method::Post {
        return Outcome::Http(route);
    }
    if !is_responses_endpoint(path) {
        invalidate_route(&route);
        return Outcome::Http(route);
    }
    let creates_response = is_response_create_endpoint(path);
    if let Some(scope) = route.scope.as_ref() {
        route.context = match ContextStore::open(scope, params.account, creates_response) {
            Ok(context) => context,
            Err(error) => return context_failure(error),
        };
    }
    if !creates_response && route.context.is_none() {
        invalidate_route(&route);
        return Outcome::Http(route);
    }
    let mut options = prepared_options(&params);
    let has_turn_state = header_value(params.headers, TURN_STATE).is_some();
    if creates_response {
        guard_replay(has_turn_state, options.as_ref(), route.context.is_some());
    }
    if let Err(error) = project_route(&mut route, &params, options.as_mut(), has_turn_state) {
        invalidate_route(&route);
        return error.into();
    }
    let websocket_enabled = creates_response && request_scope::websocket_enabled();
    if matches!(transport, Transport::Http)
        || !websocket_enabled
        || (has_turn_state && !route.headers.strip_turn_state)
    {
        invalidate_route(&route);
        return Outcome::Http(route);
    }
    send_websocket(route, options, &params)
}

enum ProjectionError {
    Context(account_context::Error),
    Encoding(request_error::RequestError),
}

impl From<ProjectionError> for Outcome {
    fn from(error: ProjectionError) -> Self {
        match error {
            ProjectionError::Context(error) => context_failure(error),
            ProjectionError::Encoding(error) => Self::Failed(error.wire()),
        }
    }
}

fn project_route<R: Runtime>(
    route: &mut HttpRoute,
    params: &Request<'_, R>,
    mut options: Option<&mut Map<String, Value>>,
    has_turn_state: bool,
) -> Result<(), ProjectionError> {
    let mut body_changed = false;
    if let Some(context) = route.context.as_mut() {
        let projected = context
            .project(options.as_deref_mut(), has_turn_state)
            .map_err(ProjectionError::Context)?;
        body_changed = projected.body_changed;
        route.headers.strip_routing_hint |= projected.strip_routing_hint;
        route.headers.strip_turn_state = projected.strip_turn_state;
    }
    if let Some(options) = options {
        body_changed |= metadata::strip_client_turn_state(options);
        if body_changed {
            route.body =
                Some(sanitized_body(options, params.headers).map_err(ProjectionError::Encoding)?);
        }
    }
    Ok(())
}

fn send_websocket<R: Runtime>(
    mut route: HttpRoute,
    options: Option<Map<String, Value>>,
    params: &Request<'_, R>,
) -> Outcome {
    let turn = options.and_then(|options| request::Turn::from_body(options, params.headers));
    let (Some(scope), Some(turn), Some(upstream)) =
        (route.scope.clone(), turn, Upstream::from_request(params))
    else {
        invalidate_route(&route);
        return Outcome::Http(route);
    };
    match prepare(scope, upstream, turn) {
        Ok(mut prepared) => {
            prepared.turn.context = route.context.take();
            Outcome::from(prepared.send())
        }
        Err(reason) => fallback(route, reason),
    }
}

fn context_failure(error: account_context::Error) -> Outcome {
    match error {
        account_context::Error::Bound => Outcome::Response(account_conflict()),
        account_context::Error::InvalidBody => {
            let message = request_error::RequestError::new(
                request_error::Stage::Request,
                request_error::Problem::ObjectRequired,
            );
            Outcome::Response(json_payload(
                400,
                json!({"error":{
                    "type":"invalid_request_error",
                    "message":message.to_string()
                }}),
            ))
        }
        account_context::Error::Storage(_) => {
            diagnostic_event(json!({"event":"official_responses_ownership_read_failed"}));
            Outcome::Failed(
                request_error::RequestError::http(request_error::Stage::Responses, 500).wire(),
            )
        }
    }
}

fn account_conflict() -> UpstreamPayload {
    json_payload(
        400,
        json!({"error": {
            "code":"account_bound_context",
            "type":"invalid_request_error",
            "message":account_context_copy::message(crate::storage::interface_language())
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

fn sanitized_body(
    options: &Map<String, Value>,
    headers: &[(String, String)],
) -> Result<Vec<u8>, request_error::RequestError> {
    let bytes = serde_json::to_vec(options).map_err(|_| {
        request_error::RequestError::new(
            request_error::Stage::Responses,
            request_error::Problem::Encode,
        )
    })?;
    let encoding = header_value(headers, "content-encoding").unwrap_or("identity");
    responses_lite::encode(&bytes, encoding)
}

pub(super) fn guard_credential_replay(
    method: &Method,
    path: &str,
    headers: &[(String, String)],
    body: &[u8],
) {
    if *method == Method::Post && is_response_create_endpoint(request_path(path)) {
        let options = decoded_body(headers, body).and_then(|bytes| parse_options(&bytes));
        guard_replay(
            header_value(headers, TURN_STATE).is_some(),
            options.as_ref(),
            false,
        );
    }
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
                        context: None,
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
            context: None,
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
        gui: request_scope::is_gui(),
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
