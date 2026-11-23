use serde::{Serialize, Serializer};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io};

const MAX_HISTORY_ITEMS: usize = 16_384;

pub(super) type Fingerprint = [u8; 32];

pub(super) struct Turn {
    options: Map<String, Value>,
    input: Vec<Value>,
    option_fingerprint: Fingerprint,
    input_fingerprints: Vec<Fingerprint>,
}

pub(super) struct ConfirmedHistory {
    pub(super) response_id: String,
    options: Fingerprint,
    prefix: Vec<Fingerprint>,
}

pub(super) struct SentHistory {
    options: Fingerprint,
    input: Vec<Fingerprint>,
}

impl Turn {
    pub(super) fn from_body(mut options: Map<String, Value>) -> Option<Self> {
        if options.get("stream") != Some(&Value::Bool(true)) || has_server_state(&options) {
            return None;
        }
        let input = match options.remove("input")? {
            Value::Array(items) if items.len() <= MAX_HISTORY_ITEMS => items,
            _ => return None,
        };
        let option_fingerprint = fingerprint_options(&options)?;
        let input_fingerprints = input
            .iter()
            .map(item_fingerprint)
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            options,
            input,
            option_fingerprint,
            input_fingerprints,
        })
    }

    pub(super) fn extension(&self, history: &ConfirmedHistory) -> Result<usize, &'static str> {
        if self.option_fingerprint != history.options {
            return Err("request_options_changed");
        }
        let input = self
            .input_fingerprints
            .strip_prefix(history.prefix.as_slice())
            .ok_or("input_prefix_changed")?;
        let offset = self.input_fingerprints.len() - input.len();
        if self.input[offset..].iter().any(contains_account_state) {
            return Err("account_state_in_delta");
        }
        Ok(offset)
    }

    pub(super) fn encode(
        mut self,
        continuation: Option<(&ConfirmedHistory, usize)>,
    ) -> (String, SentHistory) {
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
        output: Vec<Fingerprint>,
    ) -> Option<ConfirmedHistory> {
        if response_id.is_empty()
            || response_id.len() > 512
            || self.input.len() + output.len() > MAX_HISTORY_ITEMS
        {
            return None;
        }
        self.input.extend(output);
        Some(ConfirmedHistory {
            response_id: response_id.into(),
            options: self.options,
            prefix: std::mem::take(&mut self.input),
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

pub(super) fn item_fingerprint(item: &Value) -> Option<Fingerprint> {
    let Some(fields) = item.as_object() else {
        return fingerprint(item);
    };
    let reasoning = item.get("type").and_then(Value::as_str) == Some("reasoning");
    // Codex's typed history omits empty optionals and does not serialize a status on reasoning.
    // Keep all non-null attributes which could affect server-side context, including item IDs.
    let canonical = fields
        .iter()
        .filter(|(key, value)| !value.is_null() && !(reasoning && key.as_str() == "status"));
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
        Some("function_call" | "custom_tool_call" | "tool_search_call" | "local_shell_call") => {
            let Some(id) = call_id(item) else {
                return false;
            };
            call_context_complete(item, kind.unwrap()) && calls.insert(id, kind).is_none()
        }
        Some(
            kind @ ("function_call_output"
            | "custom_tool_call_output"
            | "tool_search_output"
            | "local_shell_call_output"),
        ) => {
            let Some(called) = call_id(item).and_then(|id| calls.get_mut(id)) else {
                return false;
            };
            let expected = if kind == "tool_search_output" {
                Some("tool_search_call")
            } else {
                kind.strip_suffix("_output")
            };
            let output_key = if kind == "tool_search_output" {
                "tools"
            } else {
                "output"
            };
            if expected == *called
                && called.is_some()
                && item.get(output_key).is_some_and(|value| !value.is_null())
            {
                *called = None;
                return true;
            }
            false
        }
        _ => false,
    }
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
