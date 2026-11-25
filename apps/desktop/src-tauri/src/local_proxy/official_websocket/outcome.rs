use super::super::UpstreamPayload;
use super::{cache::Scope, context_store::ContextStore, http_context, metadata::TURN_STATE};
use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Reason {
    AccountStateInDelta,
    CacheFull,
    CacheUnavailable,
    ConfirmedPrefix,
    ConnectionClosed,
    ConnectionOwnerChanged,
    ConversationBusy,
    Initial,
    InputPrefixChanged,
    OpeningFailed,
    ProxyResolution,
    RequestOptionsChanged,
    SendFailed,
    UpgradeClient,
    UpgradeConnect,
    UpgradeRejected,
    UpgradeStream,
    UpgradeTimeout,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum UploadMode {
    Full,
    Delta,
}

pub(in crate::local_proxy) enum Outcome {
    Http(HttpRoute),
    Response(UpstreamPayload),
    Failed(String),
}

impl From<Result<UpstreamPayload, String>> for Outcome {
    fn from(result: Result<UpstreamPayload, String>) -> Self {
        match result {
            Ok(payload) => Self::Response(payload),
            Err(error) => Self::Failed(error),
        }
    }
}

pub(in crate::local_proxy) struct HttpRoute {
    pub(super) scope: Option<Scope>,
    pub(in crate::local_proxy) headers: HttpHeaders,
    pub(in crate::local_proxy) body: Option<Vec<u8>>,
    pub(super) context: Option<ContextStore>,
}

impl HttpRoute {
    pub(in crate::local_proxy) fn watch(self, payload: UpstreamPayload) -> UpstreamPayload {
        match self.context {
            Some(context) => http_context::watch(context, payload),
            None => payload,
        }
    }
}

#[derive(Clone, Copy, Default)]
pub(in crate::local_proxy) struct HttpHeaders {
    pub(super) strip_routing_hint: bool,
    pub(super) strip_turn_state: bool,
}

impl HttpHeaders {
    pub(in crate::local_proxy) fn is_unchanged(self) -> bool {
        !self.strip_routing_hint && !self.strip_turn_state
    }

    pub(in crate::local_proxy) fn keep(self, name: &str) -> bool {
        !((self.strip_routing_hint && name.eq_ignore_ascii_case("x-codex-routing-hint"))
            || (self.strip_turn_state && name.eq_ignore_ascii_case(TURN_STATE)))
    }
}
