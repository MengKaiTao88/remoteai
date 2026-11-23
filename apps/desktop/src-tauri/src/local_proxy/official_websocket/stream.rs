use super::super::{
    diagnostic_event, failover_transport, quota_sse, request_error, response_header_timeout,
    sse_idle_timeout, UpstreamBody, UpstreamPayload,
};
use super::{
    cache::{Connection, Lease, Owner},
    request::{item_fingerprint, ConfirmedHistory, Fingerprint, SentHistory},
    socket::{Socket, READ_INTERVAL},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{self, Cursor, Read},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tungstenite::{Error, Message};

const MAX_OUTPUT_ITEMS: usize = 16_384;
const HEARTBEAT: &[u8] = b": keep-alive\n\n";

pub(super) struct SentTurn {
    pub(super) socket: Socket,
    pub(super) lease: Lease,
    pub(super) owner: Owner,
    pub(super) history: SentHistory,
}

pub(super) fn send(
    mut turn: SentTurn,
    request: String,
    mode: &'static str,
    reason: &'static str,
) -> Result<UpstreamPayload, String> {
    diagnostic_event(json!({
        "event": "official_upstream_upload", "transport": "websocket",
        "mode": mode, "reason": reason, "bodyBytes": request.len()
    }));
    // A write error may occur after the server has received all or part of the frame.
    // It cannot use HTTP fallback or another account's socket.
    turn.socket
        .send(request)
        .map_err(|_| ambiguous_delivery("send_failed"))?;
    let streaming = Arc::new(AtomicBool::new(false));
    let reader = Reader {
        turn: Some(turn),
        terminal: None,
        bytes: Cursor::default(),
        items: OutputItems::default(),
        finished: false,
        begun: Instant::now(),
        last_received: Instant::now(),
        header_timeout: response_header_timeout::current(),
        idle_timeout: sse_idle_timeout::current(),
        streaming: Arc::clone(&streaming),
    };
    let payload = quota_sse::inspect_initial_official_sse(UpstreamPayload {
        status: 200,
        content_type: Some("text/event-stream".into()),
        response_headers: Vec::new(),
        body: UpstreamBody::Streaming(Box::new(reader)),
        token_usage_account: None,
        token_usage_service_tier: None,
    });
    streaming.store(true, Ordering::Relaxed);
    if payload.is_err() {
        return Err(ambiguous_delivery("opening_failed"));
    }
    payload
}

fn ambiguous_delivery(reason: &'static str) -> String {
    diagnostic_event(json!({
        "event": "official_websocket_interrupted", "reason": reason, "delivery": "unknown"
    }));
    failover_transport::record_ambiguous_send();
    request_error::RequestError::io(
        request_error::Stage::Read,
        &io::Error::from(io::ErrorKind::ConnectionAborted),
    )
    .wire()
}

struct Reader {
    turn: Option<SentTurn>,
    terminal: Option<ConfirmedHistory>,
    bytes: Cursor<Vec<u8>>,
    items: OutputItems,
    finished: bool,
    begun: Instant,
    last_received: Instant,
    header_timeout: Duration,
    idle_timeout: Option<Duration>,
    streaming: Arc<AtomicBool>,
}

impl Reader {
    fn next_frame(&mut self) -> io::Result<Vec<u8>> {
        loop {
            let streaming = self.streaming.load(Ordering::Relaxed);
            let wait = self.next_wait(streaming)?;
            let turn = self
                .turn
                .as_mut()
                .expect("in-progress stream must have a socket");
            match turn.socket.read(wait) {
                Ok(Message::Text(text)) => {
                    self.last_received = Instant::now();
                    return self.encode_event(&text);
                }
                Ok(Message::Ping(_) | Message::Pong(_)) => {}
                Err(Error::Io(error)) if error.kind() == io::ErrorKind::TimedOut => {
                    if streaming && wait == READ_INTERVAL {
                        return Ok(HEARTBEAT.to_vec());
                    }
                }
                _ => return Err(io::ErrorKind::ConnectionAborted.into()),
            }
        }
    }

    fn next_wait(&self, streaming: bool) -> io::Result<Duration> {
        let limit = if streaming {
            self.idle_timeout
                .map(|timeout| timeout.saturating_sub(self.last_received.elapsed()))
        } else {
            Some(self.header_timeout.saturating_sub(self.begun.elapsed()))
        };
        match limit {
            Some(remaining) if remaining.is_zero() => Err(io::ErrorKind::TimedOut.into()),
            Some(remaining) => Ok(remaining.min(READ_INTERVAL)),
            None => Ok(READ_INTERVAL),
        }
    }

    fn encode_event(&mut self, text: &str) -> io::Result<Vec<u8>> {
        let value: Value = serde_json::from_str(text).map_err(|_| io::ErrorKind::InvalidData)?;
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .filter(|kind| {
                !kind.is_empty()
                    && kind.bytes().all(|c| {
                        c.is_ascii_lowercase()
                            || c.is_ascii_digit()
                            || matches!(c, b'.' | b'_' | b'-')
                    })
            })
            .ok_or(io::ErrorKind::InvalidData)?;
        self.items.observe(kind, &value);
        match kind {
            "response.completed" => self.complete(&value),
            "response.failed" | "response.incomplete" | "response.cancelled" | "error" => {
                self.finished = true;
                if kind == "error" {
                    return Ok(error_event(&value));
                }
            }
            _ => {}
        }
        let payload = if text.contains(['\r', '\n']) {
            value.to_string()
        } else {
            text.to_string()
        };
        Ok(format!("event: {kind}\ndata: {payload}\n\n").into_bytes())
    }

    fn complete(&mut self, value: &Value) {
        self.finished = true;
        let Some(response) = value.get("response") else {
            return;
        };
        if response
            .get("status")
            .is_some_and(|status| status != "completed")
            || response.get("error").is_some_and(|error| !error.is_null())
        {
            return;
        }
        let Some(id) = response.get("id").and_then(Value::as_str) else {
            return;
        };
        let Some(output) = self.items.confirm(response.get("output")) else {
            return;
        };
        // Only the final downstream read may keep the socket. If the request is
        // cancelled while sending the terminal frame, Drop closes the connection.
        self.terminal = self
            .turn
            .as_mut()
            .and_then(|turn| turn.history.confirm(id, output));
    }

    fn retain(&mut self) {
        let Some(history) = self.terminal.take() else {
            return;
        };
        let Some(turn) = self.turn.take() else { return };
        turn.lease.retain(Connection {
            socket: turn.socket,
            owner: turn.owner,
            history,
        });
    }
}

fn error_event(value: &Value) -> Vec<u8> {
    let error = value.get("error").unwrap_or(value);
    let output = value
        .get("output")
        .or_else(|| value.pointer("/response/output"));
    let data = json!({"type": "response.failed", "response": {
        "status": "failed", "error": error, "output": output
    }});
    format!("event: response.failed\ndata: {data}\n\n").into_bytes()
}

impl Read for Reader {
    fn read(&mut self, target: &mut [u8]) -> io::Result<usize> {
        if target.is_empty() {
            return Ok(0);
        }
        let count = self.bytes.read(target)?;
        if count > 0 {
            return Ok(count);
        }
        if self.finished {
            self.retain();
            return Ok(0);
        }
        self.bytes = Cursor::new(self.next_frame()?);
        self.bytes.read(target)
    }
}

#[derive(Default)]
struct OutputItems {
    observed: BTreeMap<usize, Option<Fingerprint>>,
    uncertain: bool,
}

impl OutputItems {
    fn observe(&mut self, kind: &str, event: &Value) {
        if !matches!(
            kind,
            "response.output_item.added" | "response.output_item.done"
        ) {
            return;
        }
        let Some(index) = event
            .get("output_index")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .filter(|index| *index < MAX_OUTPUT_ITEMS)
        else {
            self.uncertain = true;
            return;
        };
        if kind == "response.output_item.added" {
            self.observed.entry(index).or_insert(None);
        } else {
            self.observed
                .insert(index, event.get("item").and_then(item_fingerprint));
        }
    }

    fn confirm(&self, output: Option<&Value>) -> Option<Vec<Fingerprint>> {
        if self.uncertain {
            return None;
        }
        if let Some(items) = output
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty())
        {
            if items.len() > MAX_OUTPUT_ITEMS {
                return None;
            }
            let full = items
                .iter()
                .map(item_fingerprint)
                .collect::<Option<Vec<_>>>()?;
            let inconsistent = self.observed.iter().any(|(index, observed)| {
                *index >= full.len() || observed.is_some_and(|item| full[*index] != item)
            });
            return (!inconsistent).then_some(full);
        }
        if self.observed.is_empty() {
            return output
                .and_then(Value::as_array)
                .filter(|items| items.is_empty())
                .map(|_| Vec::new());
        }
        self.observed
            .iter()
            .enumerate()
            .map(|(expected, (index, value))| (expected == *index).then_some(*value).flatten())
            .collect()
    }
}
