use super::super::UpstreamPayload;
use super::cache::Scope;
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
    pub(in crate::local_proxy) strip_routing_hint: bool,
    pub(in crate::local_proxy) body: Option<Vec<u8>>,
}

impl HttpRoute {
    pub(in crate::local_proxy) fn record(&self, account: &str, status: u16) {
        if !super::super::status_ok(status) {
            return;
        }
        if let Some(scope) = self.scope.as_ref() {
            super::cache::record_account(scope, account);
        }
    }
}
