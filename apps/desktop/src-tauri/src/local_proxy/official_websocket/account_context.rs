//! Project a Responses request onto the official account that will receive it.
use super::request::{self, Fingerprint};
use serde_json::{json, Map, Value};

#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error("the request contains account-bound context")]
    Bound,
    #[error("could not read the request for a changed official account")]
    InvalidBody,
    #[error("could not verify official Responses context ownership")]
    Storage(#[from] rusqlite::Error),
}

type Result<T> = std::result::Result<T, Error>;
type Owns<'a> = dyn Fn(&Fingerprint) -> rusqlite::Result<bool> + 'a;

/// Immediate quota recovery requires history that can stand on its own on any
/// eligible destination. A current account may use additional state it owns.
pub(super) fn can_replay(options: &Map<String, Value>) -> bool {
    request::replay_safe(options)
        && options.iter().all(|(key, value)| {
            if key == "input" {
                return value.as_array().is_none_or(|items| {
                    items.iter().all(portable_item) && items.iter().any(has_portable_content)
                });
            }
            !has_bound_field(key, value) && portable_child(key, value)
        })
}

fn has_portable_content(item: &Value) -> bool {
    item.as_object().is_none_or(|fields| {
        !optional_reasoning(fields)
            || fields["summary"]
                .as_array()
                .is_some_and(|parts| !parts.is_empty())
    })
}

fn portable_item(item: &Value) -> bool {
    item.as_object().is_none_or(|fields| {
        optional_reasoning(fields)
            || ((!has_item_id(fields) || complete_item_id_is_optional(item))
                && portable_fields(item))
    })
}

fn portable_fields(value: &Value) -> bool {
    match value {
        Value::Object(fields) => {
            !has_reference(fields)
                && fields.iter().all(|(key, value)| {
                    (!has_bound_field(key, value) || has_inline_attachment(fields, key))
                        && portable_child(key, value)
                })
        }
        Value::Array(items) => items.iter().all(portable_fields),
        _ => true,
    }
}

fn portable_child(key: &str, value: &Value) -> bool {
    !is_protocol_child(key, value) || portable_fields(value)
}

/// Mutate the outbound copy only. Previously seen artifacts retain their owner
/// even when the entire request history is sent on a different transport.
pub(super) fn project(options: &mut Map<String, Value>, owns: &Owns<'_>) -> Result<bool> {
    let mut changed = false;
    if let Some(items) = options.get_mut("input").and_then(Value::as_array_mut) {
        let mut projected = Vec::with_capacity(items.len());
        for mut item in items.drain(..) {
            match project_item(&mut item, owns)? {
                ItemProjection::Omit => {
                    changed = true;
                    continue;
                }
                ItemProjection::Changed => changed = true,
                ItemProjection::Original => {}
            }
            projected.push(item);
        }
        if changed && projected.is_empty() {
            return Err(Error::Bound);
        }
        *items = projected;
    }
    changed |= project_fields(options, owns)?;
    if changed && !request::replay_safe(options) {
        return Err(Error::Bound);
    }
    Ok(changed)
}

enum ItemProjection {
    Original,
    Changed,
    Omit,
}

fn project_item(item: &mut Value, owns: &Owns<'_>) -> Result<ItemProjection> {
    let Some(fields) = item.as_object() else {
        return Ok(ItemProjection::Original);
    };
    if optional_reasoning(fields)
        && !owns_field(owns, "encrypted_content", &fields["encrypted_content"])?
    {
        return match reasoning_summary(fields) {
            Some(summary) => {
                *item = summary;
                Ok(ItemProjection::Changed)
            }
            None => Ok(ItemProjection::Omit),
        };
    }
    if !has_item_id(fields) || owns_field(owns, "item", &fields["id"])? {
        return Ok(ItemProjection::Original);
    }
    if !complete_item_id_is_optional(item) {
        return Err(Error::Bound);
    }
    if let Some(fields) = item.as_object_mut() {
        fields.remove("id");
    }
    Ok(ItemProjection::Changed)
}

fn optional_reasoning(fields: &Map<String, Value>) -> bool {
    fields.get("type").and_then(Value::as_str) == Some("reasoning")
        && fields
            .get("encrypted_content")
            .is_some_and(Value::is_string)
        && fields.get("content").is_none_or(|content| {
            content.is_null() || content.as_array().is_some_and(Vec::is_empty)
        })
        && fields
            .get("summary")
            .and_then(Value::as_array)
            .is_some_and(|parts| {
                parts.iter().all(|part| {
                    part.get("type").and_then(Value::as_str) == Some("summary_text")
                        && part.get("text").is_some_and(Value::is_string)
                })
            })
        && fields.keys().all(|key| {
            matches!(
                key.as_str(),
                "type" | "id" | "status" | "summary" | "content" | "encrypted_content"
            )
        })
}

fn reasoning_summary(fields: &Map<String, Value>) -> Option<Value> {
    let parts = fields.get("summary")?.as_array()?;
    if parts.is_empty() {
        return None;
    }
    let content = parts
        .iter()
        .map(|part| json!({"type":"output_text", "text":part["text"]}))
        .collect::<Vec<_>>();
    // A reasoning item requires its original upstream ID. Its readable summary
    // can instead travel as the assistant's own text at the same history position.
    Some(json!({"type":"message", "role":"assistant", "content":content}))
}

fn has_item_id(fields: &Map<String, Value>) -> bool {
    fields.get("id").is_some_and(|value| !value.is_null())
}

fn complete_item_id_is_optional(item: &Value) -> bool {
    request::complete_history_item(item)
}

fn has_inline_attachment(fields: &Map<String, Value>, field: &str) -> bool {
    match (fields.get("type").and_then(Value::as_str), field) {
        (Some("input_file"), "file_id") => fields
            .get("file_data")
            .and_then(Value::as_str)
            .is_some_and(|data| !data.trim().is_empty()),
        (Some("input_image"), "file_id" | "image_id") => fields
            .get("image_url")
            .and_then(Value::as_str)
            .and_then(|url| url.strip_prefix("data:image/"))
            .and_then(|data| data.split_once(','))
            .is_some_and(|(_, bytes)| !bytes.is_empty()),
        _ => false,
    }
}

fn project_fields(fields: &mut Map<String, Value>, owns: &Owns<'_>) -> Result<bool> {
    let mut changed = false;
    if has_reference(fields) {
        let id = fields.get("id").ok_or(Error::Bound)?;
        if !owns_field(owns, "item", id)? {
            return Err(Error::Bound);
        }
    }
    for key in ["file_id", "image_id"] {
        if let Some(value) = fields
            .get(key)
            .filter(|_| has_inline_attachment(fields, key))
        {
            if !owns_field(owns, key, value)? {
                fields.remove(key);
                changed = true;
            }
        }
    }
    for (key, value) in fields {
        if has_bound_field(key, value) && !owns_field(owns, key, value)? {
            return Err(Error::Bound);
        }
        if is_protocol_child(key, value) {
            changed |= project_value(value, owns)?;
        }
    }
    Ok(changed)
}

fn project_value(value: &mut Value, owns: &Owns<'_>) -> Result<bool> {
    match value {
        Value::Object(fields) => project_fields(fields, owns),
        Value::Array(items) => {
            let mut changed = false;
            for item in items {
                changed |= project_value(item, owns)?;
            }
            Ok(changed)
        }
        _ => Ok(false),
    }
}

fn has_reference(fields: &Map<String, Value>) -> bool {
    fields.get("type").and_then(Value::as_str) == Some("item_reference")
}

pub(super) fn contains_bound_fields(value: &Value) -> bool {
    match value {
        Value::Object(fields) => has_reference(fields) || options_contain_bound_fields(fields),
        Value::Array(items) => items.iter().any(contains_bound_fields),
        _ => false,
    }
}

pub(super) fn options_contain_bound_fields(fields: &Map<String, Value>) -> bool {
    fields.iter().any(|(key, value)| {
        has_bound_field(key, value)
            || (is_protocol_child(key, value) && contains_bound_fields(value))
    })
}

fn is_protocol_child(key: &str, value: &Value) -> bool {
    match key {
        "input" | "content" | "tools" | "container" | "attachments" | "annotations" | "results"
        | "audio" => true,
        // Only typed content arrays carry protocol attachments in tool results.
        // Other output objects and tool schemas are application-defined data.
        "output" => value.as_array().is_some_and(|parts| {
            parts.iter().any(|part| {
                matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("input_text" | "input_image" | "input_file" | "input_audio")
                )
            })
        }),
        _ => false,
    }
}

pub(super) fn has_bound_field(key: &str, value: &Value) -> bool {
    bound_field(key, value).is_some()
        && !value.is_null()
        && !value.as_array().is_some_and(Vec::is_empty)
}

fn bound_field(key: &str, value: &Value) -> Option<&'static str> {
    Some(match key {
        "encrypted_content" => "encrypted_content",
        "encrypted_function_args" => "encrypted_function_args",
        "file_id" | "file_ids" => "file_id",
        "image_id" => "image_id",
        "vector_store_id" | "vector_store_ids" => "vector_store_id",
        "container_id" => "container_id",
        "container" if value.is_string() => "container_id",
        "approval_request_id" => "approval_request_id",
        "previous_response_id" => "response",
        "conversation" => "conversation",
        _ => return None,
    })
}

fn owns_field(owns: &Owns<'_>, field: &str, value: &Value) -> Result<bool> {
    if value.is_null() {
        return Ok(true);
    }
    let field = bound_field(field, value).unwrap_or(field);
    for digest in fingerprints(field, value) {
        if !owns(&digest)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn fingerprints<'a>(field: &'a str, value: &'a Value) -> impl Iterator<Item = Fingerprint> + 'a {
    let values = value
        .as_array()
        .map_or(std::slice::from_ref(value), Vec::as_slice);
    values.iter().filter_map(move |value| {
        let id = if field == "conversation" {
            value.get("id").unwrap_or(value)
        } else {
            value
        };
        request::fingerprint(&(field, id))
    })
}

pub(super) fn response_artifacts(event: &Value) -> Vec<Fingerprint> {
    let mut artifacts = Vec::new();
    match event.get("type").and_then(Value::as_str) {
        Some("response.output_item.done") => record_item(&event["item"], &mut artifacts),
        Some("response.completed" | "response.incomplete" | "response.failed") => {
            record_response(&event["response"], &mut artifacts);
        }
        _ if event.get("output").is_some_and(Value::is_array) => {
            record_response(event, &mut artifacts);
        }
        _ => {}
    }
    artifacts
}

fn record_response(response: &Value, artifacts: &mut Vec<Fingerprint>) {
    if let Some(id) = response.get("id").filter(|value| value.is_string()) {
        artifacts.extend(fingerprints("response", id));
    }
    if let Some(conversation) = response
        .get("conversation")
        .filter(|value| !value.is_null())
    {
        artifacts.extend(fingerprints("conversation", conversation));
    }
    if let Some(output) = response.get("output").and_then(Value::as_array) {
        for item in output {
            record_item(item, artifacts);
        }
    }
}

fn record_item(item: &Value, artifacts: &mut Vec<Fingerprint>) {
    if let Some(id) = item.get("id").filter(|value| value.is_string()) {
        artifacts.extend(fingerprints("item", id));
    }
    record_fields(item, artifacts);
}

fn record_fields(value: &Value, artifacts: &mut Vec<Fingerprint>) {
    match value {
        Value::Object(fields) => record_object(fields.iter(), artifacts),
        Value::Array(items) => {
            for item in items {
                record_fields(item, artifacts);
            }
        }
        _ => {}
    }
}

fn record_object<'a>(
    fields: impl Iterator<Item = (&'a String, &'a Value)>,
    artifacts: &mut Vec<Fingerprint>,
) {
    for (key, value) in fields {
        if let Some(field) = bound_field(key, value).filter(|_| !value.is_null()) {
            artifacts.extend(fingerprints(field, value));
        }
        if is_protocol_child(key, value) {
            record_fields(value, artifacts);
        }
    }
}
