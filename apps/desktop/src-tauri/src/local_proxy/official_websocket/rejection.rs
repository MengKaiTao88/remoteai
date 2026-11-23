use super::super::{
    forwarded_response_headers, is_official_quota_exhaustion, json_payload, quota_sse,
    UpstreamPayload,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Map, Value};

pub(super) fn opening_rejection(value: &Value) -> Option<UpstreamPayload> {
    let wrapped = value.get("type").and_then(Value::as_str) == Some("error");
    if !wrapped || quota_sse::response_contains_output(value) {
        return None;
    }
    let status = value
        .get("status")
        .or_else(|| value.get("status_code"))
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok());
    let mut error = value.get("error").cloned().unwrap_or_else(|| json!({}));
    if let Some(error) = error.as_object_mut() {
        error.remove("headers");
    }
    let mut rejection = json_payload(status.unwrap_or(429), json!({"error": error}));
    rejection.response_headers = forwarded_response_headers(&rejection_headers(value));
    match status {
        Some(400..=599) => Some(rejection),
        None if is_official_quota_exhaustion(&rejection) => Some(rejection),
        _ => None,
    }
}

fn rejection_headers(value: &Value) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(raw) = value.get("headers").and_then(Value::as_object) {
        copy_headers(raw, &mut headers);
    }
    if let Some(raw) = value.pointer("/error/headers").and_then(Value::as_object) {
        // Native Codex gives valid nested Retry-After advice precedence.
        if let Some(advice) = raw
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("retry-after"))
            .filter_map(|(_, value)| json_header_value(value))
            .next_back()
        {
            let mut candidate = HeaderMap::new();
            candidate.insert(reqwest::header::RETRY_AFTER, advice.clone());
            let forwarded = forwarded_response_headers(&candidate);
            if super::super::failover_transport::retry_after(
                &forwarded,
                std::time::SystemTime::now(),
            )
            .is_some()
            {
                headers.insert(reqwest::header::RETRY_AFTER, advice);
            }
        }
    }
    headers
}

fn copy_headers(raw: &Map<String, Value>, headers: &mut HeaderMap) {
    for (name, value) in raw {
        if let (Ok(name), Some(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            json_header_value(value),
        ) {
            headers.insert(name, value);
        }
    }
}

fn json_header_value(value: &Value) -> Option<HeaderValue> {
    match value {
        Value::String(text) => HeaderValue::from_str(text).ok(),
        Value::Number(number) => HeaderValue::from_str(&number.to_string()).ok(),
        _ => None,
    }
}
