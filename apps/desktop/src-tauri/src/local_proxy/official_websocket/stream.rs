use super::super::{
    diagnostic_event, failover_transport, json_payload, quota_sse, request_error,
    response_header_timeout, sse_idle_timeout, UpstreamBody, UpstreamPayload,
};
use super::{
    cache::{Connection, Lease, Owner},
    context_store::ContextStore,
    metadata::{self, TURN_STATE},
    outcome::{Reason, UploadMode},
    rejection::opening_rejection,
    request::{output_fingerprint, ConfirmedHistory, HistoryItem, SentHistory},
    socket::{Socket, READ_INTERVAL},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{self, Cursor, Read},
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
    pub(super) context: Option<ContextStore>,
}

pub(super) fn send(
    mut turn: SentTurn,
    request: String,
    mode: UploadMode,
    reason: Reason,
) -> Result<UpstreamPayload, String> {
    diagnostic_event(json!({
        "event": "official_upstream_upload", "transport": "websocket",
        "mode": mode, "reason": reason, "bodyBytes": request.len()
    }));
    // An interrupted write may still have delivered the generation frame.
    turn.socket
        .send(request)
        .map_err(|_| ambiguous_delivery(Reason::SendFailed))?;
    Reader::new(turn)
        .open()
        .map_err(|_| ambiguous_delivery(Reason::OpeningFailed))
}

fn ambiguous_delivery(reason: Reason) -> String {
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
}

impl Reader {
    fn new(turn: SentTurn) -> Self {
        Self {
            turn: Some(turn),
            terminal: None,
            bytes: Cursor::default(),
            items: OutputItems::default(),
            finished: false,
            begun: Instant::now(),
            last_received: Instant::now(),
            header_timeout: response_header_timeout::current(),
            idle_timeout: sse_idle_timeout::current(),
        }
    }

    fn open(mut self) -> io::Result<UpstreamPayload> {
        let mut prefix = Vec::new();
        for _ in 0..quota_sse::MAX_OPENING_EVENTS {
            let event = self
                .next_event(false)?
                .ok_or(io::ErrorKind::UnexpectedEof)?;
            if let Some(rejection) = opening_rejection(&event.value) {
                return Ok(rejection);
            }
            let opening = match quota_sse::classify_event(&event.value, None) {
                quota_sse::EventOutcome::Opening => true,
                quota_sse::EventOutcome::Forward => false,
                quota_sse::EventOutcome::Quota(error) => {
                    return Ok(json_payload(429, json!({"error":error})))
                }
            };
            prefix.extend(self.encode_event(event));
            if !opening || prefix.len() >= quota_sse::MAX_OPENING_BYTES {
                break;
            }
        }
        self.bytes = Cursor::new(prefix);
        Ok(self.into_payload())
    }

    fn into_payload(self) -> UpstreamPayload {
        UpstreamPayload {
            status: 200,
            content_type: Some("text/event-stream".into()),
            response_headers: Vec::new(),
            body: UpstreamBody::Streaming(Box::new(self)),
            token_usage_account: None,
            token_usage_service_tier: None,
        }
    }

    fn next_event(&mut self, streaming: bool) -> io::Result<Option<Event>> {
        loop {
            let wait = self.next_wait(streaming)?;
            let turn = self.turn.as_mut().ok_or(io::ErrorKind::ConnectionAborted)?;
            match turn.socket.read(wait) {
                Ok(Message::Text(text)) => {
                    self.last_received = Instant::now();
                    let mut event = Event::parse(text.to_string())?;
                    if let Some(state) = event.take_private_turn_state() {
                        turn.socket.observe_turn_state(state);
                    }
                    return Ok(Some(event));
                }
                Ok(Message::Ping(_) | Message::Pong(_)) => {}
                Err(Error::Io(error)) if error.kind() == io::ErrorKind::TimedOut => {
                    if streaming && wait == READ_INTERVAL {
                        return Ok(None);
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

    fn encode_event(&mut self, event: Event) -> Vec<u8> {
        let kind = event.kind();
        if let Some(context) = self.turn.as_ref().and_then(|turn| turn.context.as_ref()) {
            context.record(&event.value);
        }
        self.items.observe(kind, &event.value);
        match kind {
            "response.completed" => self.complete(&event.value),
            "response.failed" | "response.incomplete" | "response.cancelled" | "error" => {
                self.finished = true;
                if kind == "error" {
                    return error_event(&event.value);
                }
            }
            _ => {}
        }
        let payload = event.payload();
        format!("event: {kind}\ndata: {payload}\n\n").into_bytes()
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

struct Event {
    value: Value,
    raw: String,
    redacted: bool,
}

impl Event {
    fn parse(raw: String) -> io::Result<Self> {
        let value: Value = serde_json::from_str(&raw).map_err(|_| io::ErrorKind::InvalidData)?;
        value
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
        Ok(Self {
            value,
            raw,
            redacted: false,
        })
    }

    fn kind(&self) -> &str {
        self.value["type"].as_str().unwrap_or_default()
    }

    fn take_private_turn_state(&mut self) -> Option<String> {
        let capture = self.kind() == "response.metadata";
        let mut token = None;
        for path in ["/headers", "/response/headers", "/error/headers"] {
            let Some(headers) = self.value.pointer_mut(path).and_then(Value::as_object_mut) else {
                continue;
            };
            headers.retain(|name, state| {
                let private = name.eq_ignore_ascii_case(TURN_STATE);
                if private {
                    self.redacted = true;
                    if capture && path == "/headers" {
                        token = metadata::event_turn_state(state);
                    }
                }
                !private
            });
        }
        token
    }

    fn payload(&self) -> std::borrow::Cow<'_, str> {
        if self.redacted || self.raw.contains(['\r', '\n']) {
            self.value.to_string().into()
        } else {
            self.raw.as_str().into()
        }
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
        let bytes = match self.next_event(true)? {
            Some(event) => self.encode_event(event),
            None => HEARTBEAT.to_vec(),
        };
        self.bytes = Cursor::new(bytes);
        self.bytes.read(target)
    }
}

#[derive(Default)]
struct OutputItems {
    observed: BTreeMap<usize, Option<HistoryItem>>,
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
                .insert(index, event.get("item").and_then(output_fingerprint));
        }
    }

    fn confirm(&self, output: Option<&Value>) -> Option<Vec<HistoryItem>> {
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
                .map(output_fingerprint)
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
