use super::{metadata, outcome::Reason};
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io};

const MAX_HISTORY_ITEMS: usize = 16_384;

pub(super) type Fingerprint = [u8; 32];

pub(super) struct Turn {
    options: Map<String, Value>,
    pub(super) turn_id: Option<String>,
    input: Vec<Value>,
    option_fingerprint: Fingerprint,
    input_fingerprints: Vec<Fingerprint>,
}

pub(super) struct ConfirmedHistory {
    pub(super) response_id: String,
    options: Fingerprint,
    prefix: Vec<HistoryItem>,
}

#[derive(Clone, Copy, PartialEq)]
pub(super) struct HistoryItem {
    original: Fingerprint,
    codex_input: Option<Fingerprint>,
    without_reasoning_text: Option<Fingerprint>,
}

impl HistoryItem {
    fn matches(&self, input: &Fingerprint) -> bool {
        self.original == *input
            || self.codex_input.as_ref() == Some(input)
            || self.without_reasoning_text.as_ref() == Some(input)
    }
}

pub(super) struct SentHistory {
    options: Fingerprint,
    input: Vec<Fingerprint>,
}

impl Turn {
    pub(super) fn from_body(
        mut options: Map<String, Value>,
        headers: &[(String, String)],
    ) -> Option<Self> {
        if options.get("stream") != Some(&Value::Bool(true)) || has_server_state(&options) {
            return None;
        }
        let input = match options.remove("input")? {
            Value::Array(items) if items.len() <= MAX_HISTORY_ITEMS => items,
            _ => return None,
        };
        let option_fingerprint = fingerprint_options(&options)?;
        let turn_id = metadata::prepare(&mut options, headers);
        let input_fingerprints = input
            .iter()
            .map(item_fingerprint)
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            options,
            turn_id,
            input,
            option_fingerprint,
            input_fingerprints,
        })
    }

    pub(super) fn extension(&self, history: &ConfirmedHistory) -> Result<usize, Reason> {
        if self.option_fingerprint != history.options {
            return Err(Reason::RequestOptionsChanged);
        }
        let offset = history.prefix.len();
        if self.input_fingerprints.len() < offset
            || !history
                .prefix
                .iter()
                .zip(&self.input_fingerprints)
                .all(|(confirmed, input)| confirmed.matches(input))
        {
            return Err(Reason::InputPrefixChanged);
        }
        if self.input[offset..].iter().any(contains_account_state) {
            return Err(Reason::AccountStateInDelta);
        }
        Ok(offset)
    }

    pub(super) fn encode(
        mut self,
        continuation: Option<(&ConfirmedHistory, usize)>,
        turn_state: Option<&str>,
    ) -> (String, SentHistory) {
        metadata::attach(&mut self.options, turn_state);
        self.options.insert("type".into(), "response.create".into());
        self.options.remove("previous_response_id");
        self.options.remove("conversation");
        if let Some((history, offset)) = continuation {
            self.options.insert(
                "previous_response_id".into(),
                history.response_id.clone().into(),
            );
            self.input.drain(..offset);
        }
        self.options
            .insert("input".into(), Value::Array(self.input));
        (
            Value::Object(self.options).to_string(),
            SentHistory {
                options: self.option_fingerprint,
                input: self.input_fingerprints,
            },
        )
    }
}

impl SentHistory {
    pub(super) fn confirm(
        &mut self,
        response_id: &str,
        output: Vec<HistoryItem>,
    ) -> Option<ConfirmedHistory> {
        if response_id.is_empty()
            || response_id.len() > 512
            || self.input.len() + output.len() > MAX_HISTORY_ITEMS
        {
            return None;
        }

        Some(ConfirmedHistory {
            response_id: response_id.into(),
            options: self.options,
            prefix: self
                .input
                .drain(..)
                .map(|original| HistoryItem {
                    original,
                    codex_input: None,
                    without_reasoning_text: None,
                })
                .chain(output)
                .collect(),
        })
    }
}

fn fingerprint_options(options: &Map<String, Value>) -> Option<Fingerprint> {
    // Stream options and client metadata apply to this frame, independent of conversation input.
    let stable = options
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "client_metadata" | "stream_options"));
    let mut hash = HashWriter(Sha256::new());
    let mut serializer = serde_json::Serializer::new(&mut hash);
    serializer.collect_map(stable).ok()?;
    Some(hash.0.finalize().into())
}

pub(super) fn fingerprint(value: &impl Serialize) -> Option<Fingerprint> {
    let mut hash = HashWriter(Sha256::new());
    serde_json::to_writer(&mut hash, value).ok()?;
    Some(hash.0.finalize().into())
}

pub(super) fn output_fingerprint(item: &Value) -> Option<HistoryItem> {
    let kind = item.get("type").and_then(Value::as_str);
    let reasoning_text = kind == Some("reasoning")
        && item
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|content| {
                content
                    .iter()
                    .any(|part| part.get("type").and_then(Value::as_str) == Some("reasoning_text"))
            });
    // Codex may omit these output annotations when serializing its history for the next turn.
    // Only an alternative for confirmed output drops them. Client input is still compared as sent.
    let output_metadata = matches!(
        kind,
        Some("message" | "reasoning" | "function_call" | "custom_tool_call")
    ) && item.as_object().is_some_and(|fields| {
        fields
            .iter()
            .any(|(key, value)| output_metadata_field(key, value))
    });
    Some(HistoryItem {
        original: item_fingerprint(item)?,
        codex_input: output_metadata
            .then(|| fingerprint_item(item, reasoning_text, true))
            .flatten(),
        without_reasoning_text: reasoning_text
            .then(|| fingerprint_item(item, true, false))
            .flatten(),
    })
}

fn output_metadata_field(key: &str, value: &Value) -> bool {
    matches!(
        key,
        "metadata" | "internal_chat_message_metadata_passthrough"
    ) && value.is_object()
}

fn item_fingerprint(item: &Value) -> Option<Fingerprint> {
    fingerprint_item(item, false, false)
}

fn fingerprint_item(
    item: &Value,
    omit_reasoning_text: bool,
    omit_output_metadata: bool,
) -> Option<Fingerprint> {
    let Some(fields) = item.as_object() else {
        return fingerprint(item);
    };
    let reasoning = item.get("type").and_then(Value::as_str) == Some("reasoning");
    // Codex's typed history omits empty optionals and does not serialize a status on reasoning.
    let canonical = fields.iter().filter(|(key, value)| match key.as_str() {
        _ if value.is_null() => false,
        "status" if reasoning => false,
        "content" if omit_reasoning_text => false,
        _ => !(omit_output_metadata && output_metadata_field(key, value)),
    });
    let mut hash = HashWriter(Sha256::new());
    let mut serializer = serde_json::Serializer::new(&mut hash);
    serializer.collect_map(canonical).ok()?;
    Some(hash.0.finalize().into())
}

struct HashWriter(Sha256);

impl io::Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) fn replay_safe(options: &Map<String, Value>) -> bool {
    if has_server_state(options) {
        return false;
    }
    match options.get("input") {
        Some(Value::String(_)) => true,
        Some(Value::Array(items)) => portable_history(items),
        _ => false,
    }
}

pub(super) fn account_bound(options: &Map<String, Value>) -> bool {
    ["previous_response_id", "conversation"]
        .into_iter()
        .any(|key| options.get(key).is_some_and(|value| !value.is_null()))
        || options
            .iter()
            .any(|(key, value)| is_account_state_field(key, value) || contains_account_state(value))
}

fn has_server_state(options: &Map<String, Value>) -> bool {
    ["previous_response_id", "conversation", "type", "generate"]
        .into_iter()
        .any(|key| options.get(key).is_some_and(|value| !value.is_null()))
        || options
            .get("background")
            .is_some_and(|value| !value.is_null() && value != false)
}

fn portable_history(items: &[Value]) -> bool {
    let mut calls = HashMap::new();
    for item in items {
        if !portable_item(item, &mut calls) {
            return false;
        }
    }
    calls.values().all(Option::is_none)
}

fn portable_item<'a>(item: &'a Value, calls: &mut HashMap<&'a str, Option<&'a str>>) -> bool {
    let kind = item.get("type").and_then(Value::as_str);
    match kind {
        Some("message") | None => {
            item.get("role").and_then(Value::as_str).is_some()
                && matches!(
                    item.get("content"),
                    Some(Value::String(_) | Value::Array(_))
                )
        }
        Some("reasoning") => item.get("summary").is_some_and(Value::is_array),
        Some("additional_tools") => {
            item.get("role").and_then(Value::as_str) == Some("developer")
                && item
                    .get("tools")
                    .and_then(Value::as_array)
                    .is_some_and(|tools| tools.iter().all(Value::is_object))
        }
        Some(
            kind @ ("function_call" | "custom_tool_call" | "tool_search_call" | "local_shell_call"),
        ) => call_id(item).is_some_and(|id| {
            call_context_complete(item, kind) && calls.insert(id, Some(kind)).is_none()
        }),
        Some("function_call_output") => match_call(item, calls, "function_call", "output"),
        Some("custom_tool_call_output") => match_call(item, calls, "custom_tool_call", "output"),
        Some("tool_search_output") => match_call(item, calls, "tool_search_call", "tools"),
        Some("local_shell_call_output") => match_call(item, calls, "local_shell_call", "output"),
        _ => false,
    }
}

fn match_call<'a>(
    item: &'a Value,
    calls: &mut HashMap<&'a str, Option<&'a str>>,
    expected: &str,
    output_key: &str,
) -> bool {
    let Some(called) = call_id(item).and_then(|id| calls.get_mut(id)) else {
        return false;
    };
    if *called != Some(expected) || !item.get(output_key).is_some_and(|value| !value.is_null()) {
        return false;
    }
    *called = None;
    true
}

fn call_context_complete(item: &Value, kind: &str) -> bool {
    match kind {
        "function_call" => {
            item.get("name").is_some_and(Value::is_string)
                && item.get("arguments").is_some_and(Value::is_string)
        }
        "custom_tool_call" => {
            item.get("name").is_some_and(Value::is_string)
                && item.get("input").is_some_and(Value::is_string)
        }
        "tool_search_call" => item.get("arguments").is_some_and(|value| !value.is_null()),
        "local_shell_call" => item.get("action").is_some_and(Value::is_object),
        _ => false,
    }
}

fn call_id(item: &Value) -> Option<&str> {
    item.get("call_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn contains_account_state(item: &Value) -> bool {
    match item {
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            is_account_state_field(key, value)
                || (key == "type" && value.as_str() == Some("item_reference"))
                || contains_account_state(value)
        }),
        Value::Array(items) => items.iter().any(contains_account_state),
        _ => false,
    }
}

fn is_account_state_field(key: &str, value: &Value) -> bool {
    matches!(
        key,
        "file_id"
            | "file_ids"
            | "image_id"
            | "vector_store_id"
            | "vector_store_ids"
            | "container_id"
            | "encrypted_content"
            | "encrypted_function_args"
    ) && !value.is_null()
}
