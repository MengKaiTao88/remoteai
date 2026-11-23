use super::super::{header_value, responses_lite};
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{Map, Value};

pub(super) const TURN_STATE: &str = "x-codex-turn-state";
const TURN_METADATA: &str = "x-codex-turn-metadata";
const LITE_METADATA: &str = "ws_request_header_x_openai_internal_codex_responses_lite";
const MAX_METADATA_ID_BYTES: usize = 512;
const MAX_TURN_STATE_BYTES: usize = 8192;

pub(super) fn prepare(
    options: &mut Map<String, Value>,
    headers: &[(String, String)],
) -> Option<String> {
    let direct = header_value(headers, TURN_METADATA);
    let existing = options
        .get_mut("client_metadata")
        .and_then(Value::as_object_mut);
    let metadata = match existing {
        Some(metadata) => metadata,
        None if direct.is_none() && !responses_lite::enabled(headers) => return None,
        None => metadata_object(options)?,
    };
    if let Some(value) = direct {
        metadata
            .entry(TURN_METADATA)
            .or_insert_with(|| value.into());
    }
    if responses_lite::enabled(headers) {
        metadata.insert(LITE_METADATA.into(), "true".into());
    }
    turn_id(metadata)
}

pub(super) fn strip_client_turn_state(options: &mut Map<String, Value>) -> bool {
    let Some(metadata) = options
        .get_mut("client_metadata")
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let before = metadata.len();
    metadata.retain(|name, _| !name.eq_ignore_ascii_case(TURN_STATE));
    metadata.len() != before
}

pub(super) fn attach(options: &mut Map<String, Value>, token: Option<&str>) {
    if let Some(token) = token {
        if let Some(metadata) = metadata_object(options) {
            metadata.insert(TURN_STATE.into(), token.into());
        }
    }
}

fn metadata_object(options: &mut Map<String, Value>) -> Option<&mut Map<String, Value>> {
    let metadata = options.entry("client_metadata").or_insert(Value::Null);
    if metadata.is_null() {
        *metadata = Value::Object(Map::new());
    }
    metadata.as_object_mut()
}

fn turn_id(metadata: &Map<String, Value>) -> Option<String> {
    let direct = metadata.get("turn_id").and_then(Value::as_str);
    let nested = metadata
        .get(TURN_METADATA)
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    let nested = nested
        .as_ref()
        .and_then(|value| value.get("turn_id"))
        .and_then(Value::as_str);
    if direct
        .zip(nested)
        .is_some_and(|(direct, nested)| direct != nested)
    {
        return None;
    }
    direct
        .or(nested)
        .filter(|id| {
            !id.is_empty() && id.len() <= MAX_METADATA_ID_BYTES && !id.chars().any(char::is_control)
        })
        .map(str::to_owned)
}

pub(super) fn upgrade_turn_state(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(TURN_STATE)?.to_str().ok()?;
    valid_token(value)
}

pub(super) fn event_turn_state(value: &Value) -> Option<String> {
    let mut first = value;
    while let Some(items) = first.as_array() {
        first = items.first()?;
    }
    valid_token(first.as_str()?)
}

fn valid_token(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= MAX_TURN_STATE_BYTES
        && HeaderValue::from_str(value).is_ok())
    .then(|| value.to_owned())
}

/// Affinity belongs to the authenticated socket and to a single proven turn.
pub(super) struct Affinity {
    turn_id: String,
    token: Option<String>,
}

impl Affinity {
    pub(super) fn new(turn_id: Option<String>, token: Option<String>) -> Option<Self> {
        Some(Self {
            turn_id: turn_id?,
            token,
        })
    }

    pub(super) fn advance(affinity: &mut Option<Self>, turn_id: Option<String>) {
        if affinity.as_ref().map(|state| &state.turn_id) != turn_id.as_ref() {
            *affinity = Self::new(turn_id, None);
        }
    }

    pub(super) fn set_token(&mut self, token: String) {
        self.token.get_or_insert(token);
    }

    pub(super) fn token(&self) -> Option<&str> {
        self.token.as_deref()
    }
}
