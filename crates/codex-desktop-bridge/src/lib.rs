//! Adapts Codex Mobile Bridge's authenticated loopback API to Remote AI's chat protocol.
//! The desktop owner remains responsible for execution, authentication and permissions.
mod http;
mod images;
mod input;
mod projection;
mod requests;
mod watch;

use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{broadcast, Mutex};
use zeroize::Zeroizing;

pub const INHERIT_MODEL: &str = "codex-desktop-inherit";
const MAX_WATCHES: usize = 16;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("client.errorsCodexGui.invalidChatRequestRefreshAndTryAgain")]
    Invalid,
    #[error("client.errorsCodexGui.codexDisconnectedReconnectToContinue")]
    Disconnected,
    #[error("client.remoteHostMessages.thisApprovalRequestHasExpiredRefreshTheChat")]
    Stale,
    #[error("client.errors.thisOperationIsNotSupportedByThisClient")]
    Unsupported,
    #[error("client.desktopGuiErrors.couldNotConfirmWhetherTheLastMessageWasSentCheck")]
    UnknownWrite,
    #[error("client.errorsCodexGui.invalidChatRequestRefreshAndTryAgain")]
    Input,
    #[error("client.errors.yourSessionExpiredSignInAgainToConnectToYour")]
    Authentication,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Credentials never cross the GUI/remote protocol boundary or appear in Debug output.
pub struct Config {
    url: reqwest::Url,
    username: String,
    password: Zeroizing<String>,
}

impl Config {
    pub fn new(url: &str, username: String, password: String) -> Result<Self> {
        let url = reqwest::Url::parse(url).map_err(|_| Error::Invalid)?;
        // Do not let a remote request or a redirect turn this into a credential-forwarding proxy.
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            url,
            username,
            password: Zeroizing::new(password),
        })
    }

    pub fn from_env() -> Result<Option<Self>> {
        let Some(url) = std::env::var_os("REMOTEAI_CODEX_BRIDGE_URL") else {
            return Ok(None);
        };
        Self::new(
            &url.to_string_lossy(),
            std::env::var("REMOTEAI_CODEX_BRIDGE_USERNAME").unwrap_or_default(),
            std::env::var("REMOTEAI_CODEX_BRIDGE_PASSWORD").unwrap_or_default(),
        )
        .map(Some)
    }
}

struct Watched {
    touched: std::time::Instant,
    task: tokio::task::JoinHandle<()>,
}

pub struct Client {
    http: http::Transport,
    events: broadcast::Sender<Value>,
    watches: Mutex<HashMap<String, Watched>>,
    snapshots: Mutex<HashMap<String, Value>>,
    metadata: Mutex<HashMap<String, Value>>,
    approvals: Mutex<HashMap<String, projection::Approval>>,
    writes: Mutex<()>,
    updates: Mutex<()>,
}

impl Client {
    pub async fn connect(config: Config) -> Result<Arc<Self>> {
        let http = http::Transport::new(config)?;
        http.authenticate().await?;
        let (events, _) = broadcast::channel(256);
        Ok(Arc::new(Self {
            http,
            events,
            watches: Mutex::default(),
            snapshots: Mutex::default(),
            metadata: Mutex::default(),
            approvals: Mutex::default(),
            writes: Mutex::default(),
            updates: Mutex::default(),
        }))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub async fn pending(&self) -> Vec<Value> {
        self.approvals
            .lock()
            .await
            .values()
            .map(|request| request.event.clone())
            .collect()
    }

    pub async fn close(&self) {
        for (_, watch) in self.watches.lock().await.drain() {
            watch.task.abort();
        }
        self.snapshots.lock().await.clear();
        self.approvals.lock().await.clear();
    }

    fn emit(&self, event: Value) {
        // No listeners is normal before the desktop/phone opens its first conversation.
        let _ = self.events.send(event);
    }
}

pub fn models() -> Value {
    // A single explicit inherited choice prevents the GUI's defaults from changing the native thread.
    json!({"data": [{"id": INHERIT_MODEL, "model": INHERIT_MODEL,
        "displayName": "Codex Desktop", "isDefault": true, "defaultReasoningEffort": "medium",
        "supportedReasoningEfforts": [{"reasoningEffort": "medium", "description": "Codex Desktop"}]}],
        "nextCursor": null})
}

fn thread_id(request: &Value) -> Result<&str> {
    let id = request["threadId"].as_str().ok_or(Error::Invalid)?;
    uuid::Uuid::parse_str(id).map_err(|_| Error::Invalid)?;
    Ok(id)
}

#[cfg(test)]
mod tests;
