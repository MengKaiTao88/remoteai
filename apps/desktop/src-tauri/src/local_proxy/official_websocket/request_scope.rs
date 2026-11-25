use super::{account_context, request, Transport};
use serde_json::{Map, Value};
use std::cell::RefCell;

#[derive(Default)]
struct Settings {
    websocket_enabled: bool,
    gui: bool,
    route_change_blocked: bool,
    quota_replay_blocked: bool,
    retry_account: Option<String>,
    sent: Option<SentRequest>,
}

thread_local! {
    static SETTINGS: RefCell<Settings> = RefCell::new(Settings::default());
}

pub(in crate::local_proxy) struct RequestScope(Settings);

impl RequestScope {
    pub(in crate::local_proxy) fn enter(websocket_enabled: bool, gui: bool) -> Self {
        Self(SETTINGS.replace(Settings {
            websocket_enabled,
            gui,
            ..Settings::default()
        }))
    }
}

impl Drop for RequestScope {
    fn drop(&mut self) {
        SETTINGS.replace(std::mem::take(&mut self.0));
    }
}

pub(in crate::local_proxy) fn begin_attempt() {
    SETTINGS.with_borrow_mut(|settings| {
        settings.route_change_blocked = false;
        settings.quota_replay_blocked = false;
    });
}

pub(in crate::local_proxy) fn attempt_can_change_route() -> bool {
    SETTINGS.with_borrow(|settings| !settings.route_change_blocked)
}

pub(in crate::local_proxy) fn attempt_can_change_route_on_quota() -> bool {
    SETTINGS.with_borrow(|settings| !settings.quota_replay_blocked)
}

pub(in crate::local_proxy) fn pin_retry_account(account: &str) {
    SETTINGS.with_borrow_mut(|settings| settings.retry_account = Some(account.into()));
}

pub(in crate::local_proxy) fn clear_retry_account() {
    SETTINGS.with_borrow_mut(|settings| settings.retry_account = None);
}

pub(in crate::local_proxy) fn retry_account() -> Option<String> {
    SETTINGS.with_borrow(|settings| settings.retry_account.clone())
}

struct SentRequest {
    account: String,
    transport: Transport,
}

pub(super) fn strip_old_routing_hint(account: &str) -> bool {
    SETTINGS.with_borrow(|settings| {
        settings.sent.as_ref().is_some_and(|sent| {
            sent.account != account || matches!(sent.transport, Transport::WebSocket)
        })
    })
}

pub(in crate::local_proxy) fn record_http_started(account: &str) {
    record_send_started(account, Transport::Http);
}

pub(super) fn record_send_started(account: &str, transport: Transport) {
    SETTINGS.with_borrow_mut(|settings| {
        settings.sent.get_or_insert_with(|| SentRequest {
            account: account.into(),
            transport,
        });
    });
}

pub(super) fn websocket_enabled() -> bool {
    SETTINGS.with_borrow(|settings| settings.websocket_enabled)
}

pub(super) fn is_gui() -> bool {
    SETTINGS.with_borrow(|settings| settings.gui)
}

pub(super) fn guard_replay(
    has_turn_state: bool,
    options: Option<&Map<String, Value>>,
    scoped: bool,
) {
    let account_bound = has_turn_state || options.is_some_and(request::account_bound);
    let replay_safe = options.is_some_and(request::replay_safe);
    SETTINGS.with_borrow_mut(|settings| {
        settings.route_change_blocked = account_bound || !replay_safe;
        settings.quota_replay_blocked = if scoped {
            !options.is_some_and(account_context::can_replay)
        } else {
            settings.route_change_blocked
        };
    });
}
