use super::super::{
    response_header_timeout, UPSTREAM_CONNECT_TIMEOUT, UPSTREAM_UPLOAD_IDLE_TIMEOUT,
};
use super::metadata::{self, Affinity};
use super::outcome::Reason;
use futures_util::FutureExt;
use reqwest::{header, StatusCode, Upgraded, Url};
use std::{
    io::{self, Read, Write},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tungstenite::{
    handshake::{client::generate_key, derive_accept_key},
    protocol::Role,
    Error, Message, WebSocket,
};

const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const READ_INTERVAL: Duration = Duration::from_secs(1);
const CODEX_WEBSOCKET_BETA: &str = "responses_websockets=2026-02-06";

pub(super) struct Socket {
    socket: WebSocket<BlockingUpgrade>,
    affinity: Option<Affinity>,
}

impl Socket {
    pub(super) fn connect(
        url: &Url,
        headers: header::HeaderMap,
        turn_id: Option<String>,
    ) -> Result<Self, Reason> {
        tauri::async_runtime::block_on(async {
            let (stream, token) = tokio::time::timeout(
                response_header_timeout::current().min(DIAL_TIMEOUT),
                upgrade(url, headers),
            )
            .await
            .map_err(|_| Reason::UpgradeTimeout)??;
            Ok(Self {
                socket: WebSocket::from_raw_socket(
                    BlockingUpgrade {
                        stream,
                        wait: READ_INTERVAL,
                        write_wait: READ_INTERVAL,
                    },
                    Role::Client,
                    None,
                ),
                affinity: Affinity::new(turn_id, token),
            })
        })
    }

    pub(super) fn advance_turn(&mut self, turn_id: Option<String>) {
        Affinity::advance(&mut self.affinity, turn_id);
    }

    pub(super) fn turn_state(&self) -> Option<&str> {
        self.affinity.as_ref().and_then(Affinity::token)
    }

    pub(super) fn observe_turn_state(&mut self, state: String) {
        if let Some(affinity) = self.affinity.as_mut() {
            affinity.set_token(state);
        }
    }

    /// Detect a peer close that arrived while idle, before any generation bytes can be written.
    pub(super) fn available(&mut self) -> bool {
        self.socket.get_mut().wait = Duration::ZERO;
        let available = self.check_pending();
        self.socket.get_mut().wait = READ_INTERVAL;
        available
    }

    fn check_pending(&mut self) -> bool {
        const MAX_IDLE_FRAMES: usize = 8;
        for _ in 0..MAX_IDLE_FRAMES {
            match self.socket.read() {
                Ok(Message::Ping(_) | Message::Pong(_)) => {}
                Ok(Message::Text(text)) if is_rate_limit_event(&text) => {}
                Err(Error::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
                    return self.socket.can_write();
                }
                _ => return false,
            }
        }
        false
    }

    pub(super) fn send(&mut self, request: String) -> tungstenite::Result<()> {
        self.socket.get_mut().write_wait = UPSTREAM_UPLOAD_IDLE_TIMEOUT;
        let result = self.socket.send(Message::text(request));
        self.socket.get_mut().write_wait = READ_INTERVAL;
        result
    }

    pub(super) fn read(&mut self, wait: Duration) -> tungstenite::Result<Message> {
        self.socket.get_mut().wait = wait;
        self.socket.read()
    }
}

fn is_rate_limit_event(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|event| event.get("type").cloned())
        .is_some_and(|kind| kind == "codex.rate_limits")
}

async fn upgrade(
    url: &Url,
    mut headers: header::HeaderMap,
) -> Result<(Upgraded, Option<String>), Reason> {
    // Resolve the same PAC, HTTP CONNECT and SOCKS proxy configuration as HTTP forwarding.
    let client = crate::system_proxy::apply_async(
        reqwest::Client::builder()
            .http1_only()
            .connect_timeout(UPSTREAM_CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none()),
        url,
    )
    .await
    .map_err(|_| Reason::ProxyResolution)?
    .build()
    .map_err(|_| Reason::UpgradeClient)?;
    let key = generate_key();
    headers.insert(
        header::CONNECTION,
        header::HeaderValue::from_static("Upgrade"),
    );
    headers.insert(
        header::UPGRADE,
        header::HeaderValue::from_static("websocket"),
    );
    headers.insert(
        header::SEC_WEBSOCKET_VERSION,
        header::HeaderValue::from_static("13"),
    );
    headers.insert(
        "openai-beta",
        header::HeaderValue::from_static(CODEX_WEBSOCKET_BETA),
    );
    let response = client
        .get(url.clone())
        .headers(headers)
        .header(header::SEC_WEBSOCKET_KEY, &key)
        .send()
        .await
        .map_err(|_| Reason::UpgradeConnect)?;
    if !valid_upgrade(&response, &key) {
        return Err(Reason::UpgradeRejected);
    }
    let token = metadata::upgrade_turn_state(response.headers());
    let stream = response
        .upgrade()
        .await
        .map_err(|_| Reason::UpgradeStream)?;
    Ok((stream, token))
}

fn valid_upgrade(response: &reqwest::Response, key: &str) -> bool {
    let headers = response.headers();
    let expected = derive_accept_key(key.as_bytes());
    response.status() == StatusCode::SWITCHING_PROTOCOLS
        && token_header(headers, header::CONNECTION, "upgrade")
        && token_header(headers, header::UPGRADE, "websocket")
        && headers
            .get(header::SEC_WEBSOCKET_ACCEPT)
            .is_some_and(|value| value == expected.as_str())
        && !headers.contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
        && !headers.contains_key(header::SEC_WEBSOCKET_PROTOCOL)
}

fn token_header(headers: &header::HeaderMap, name: header::HeaderName, token: &str) -> bool {
    headers.get_all(name).iter().any(|value| {
        value.to_str().is_ok_and(|value| {
            value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case(token))
        })
    })
}

struct BlockingUpgrade {
    stream: Upgraded,
    wait: Duration,
    write_wait: Duration,
}

impl Read for BlockingUpgrade {
    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
        let operation = self.stream.read(target);
        if self.wait.is_zero() {
            return tauri::async_runtime::block_on(async {
                operation
                    .now_or_never()
                    .unwrap_or_else(|| Err(io::ErrorKind::WouldBlock.into()))
            });
        }
        tauri::async_runtime::block_on(async { tokio::time::timeout(self.wait, operation).await? })
    }
}

impl Write for BlockingUpgrade {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(self.write_wait, self.stream.write(bytes)).await?
        })
    }

    fn flush(&mut self) -> io::Result<()> {
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(self.write_wait, self.stream.flush()).await?
        })
    }
}
