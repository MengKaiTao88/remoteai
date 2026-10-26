use super::*;
use serde_json::json;

fn observe_chunks(capture: &mut ErrorCapture, bytes: &[u8]) -> Vec<ProxyCapturedError> {
    let mut errors = Vec::new();
    for chunk in bytes.chunks(3) {
        errors.extend(capture.observe(chunk));
    }
    errors.extend(capture.finish());
    errors
}

fn incomplete(reason: &str) -> Value {
    json!({ "type": "response.incomplete", "response": {
        "status": "incomplete", "incomplete_details": { "reason": reason }, "error": null,
    } })
}

#[test]
fn expected_incomplete_is_healthy_for_fragmented_streams_and_json() {
    for reason in ["max_output_tokens", "content_filter"] {
        let json = incomplete(reason).to_string();
        for (streaming, body) in [(true, format!("data: {json}\n\n")), (false, json)] {
            let mut capture = ErrorCapture::new_for_health(streaming, 200);
            assert!(observe_chunks(&mut capture, body.as_bytes()).is_empty());
            assert!(capture.terminal_seen());
            assert!(!capture.error_seen());
        }
        let mut capture = ErrorCapture::new_for_health(false, 200);
        let body = json!({ "status": "incomplete", "incomplete_details": { "reason": reason } });
        assert!(observe_chunks(&mut capture, body.to_string().as_bytes()).is_empty());
        assert!(capture.terminal_seen());
    }
}

#[test]
fn expected_incomplete_keeps_the_default_diagnostic_error() {
    for reason in ["max_output_tokens", "content_filter"] {
        let mut capture = ErrorCapture::new(true, 200);
        let body = format!("data: {}\n\n", incomplete(reason));
        assert_eq!(observe_chunks(&mut capture, body.as_bytes()).len(), 1);
        assert!(capture.error_seen());
    }
}

#[test]
fn normal_incomplete_does_not_hide_a_subsequent_real_error() {
    for error in [
        json!({ "type": "error", "error": { "message": "upstream failed" } }),
        json!({ "type": "response.failed", "response": { "error": { "message": "upstream failed" } } }),
        json!({ "error": "upstream failed" }),
        incomplete("server_error"),
    ] {
        let body = format!(
            "data: {}\n\ndata: {error}\n\n",
            incomplete("max_output_tokens")
        );
        let mut capture = ErrorCapture::new_for_health(true, 200);
        assert_eq!(observe_chunks(&mut capture, body.as_bytes()).len(), 1);
        assert!(capture.error_seen());
    }
}

#[test]
fn incomplete_with_an_explicit_error_or_http_failure_is_unhealthy() {
    for pointer in ["/error", "/response/error"] {
        let mut value = incomplete("max_output_tokens");
        if pointer == "/error" {
            value["error"] = json!({"message": "upstream failed"});
        } else {
            value["response"]["error"] = json!({"message": "upstream failed"});
        }
        let mut capture = ErrorCapture::new_for_health(true, 200);
        let body = format!("data: {value}\n\n");
        assert_eq!(observe_chunks(&mut capture, body.as_bytes()).len(), 1);
    }
    for streaming in [true, false] {
        let value = incomplete("content_filter").to_string();
        let body = if streaming {
            format!("data: {value}\n\n")
        } else {
            value
        };
        let mut capture = ErrorCapture::new_for_health(streaming, 503);
        assert_eq!(observe_chunks(&mut capture, body.as_bytes()).len(), 1);
    }
}

#[test]
fn incomplete_event_cannot_mask_an_explicit_failure_payload() {
    for payload_type in ["error", "response.failed"] {
        let mut value = incomplete("max_output_tokens");
        value["type"] = json!(payload_type);
        let body = format!("event: response.incomplete\ndata: {value}\n\n");
        let mut capture = ErrorCapture::new_for_health(true, 200);
        assert_eq!(observe_chunks(&mut capture, body.as_bytes()).len(), 1);
    }
    let body = format!("event: error\ndata: {}\n\n", incomplete("content_filter"));
    let mut capture = ErrorCapture::new_for_health(true, 200);
    assert_eq!(observe_chunks(&mut capture, body.as_bytes()).len(), 1);
}

#[test]
fn unknown_incomplete_and_truncated_streams_remain_failures() {
    for value in [
        incomplete("server_error"),
        incomplete("unknown"),
        json!({ "type": "response.incomplete", "response": {} }),
    ] {
        let body = format!("data: {value}\n\n");
        let mut capture = ErrorCapture::new_for_health(true, 200);
        assert_eq!(observe_chunks(&mut capture, body.as_bytes()).len(), 1);
        let mut capture = ErrorCapture::new_for_health(false, 200);
        assert_eq!(
            observe_chunks(&mut capture, value.to_string().as_bytes()).len(),
            1
        );
    }
    for body in [
        "",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
        "data: {\"type\":\"response.incomplete\",",
    ] {
        let mut capture = ErrorCapture::new_for_health(true, 200);
        assert_eq!(observe_chunks(&mut capture, body.as_bytes()).len(), 1);
        assert!(!capture.terminal_seen());
    }
}

#[test]
fn responses_require_a_parsed_completion_even_when_done_or_other_markers_arrive() {
    for ending in [
        "data: [DONE]\n\n",
        "event: response.completed\ndata: {broken\n\n",
        "event: response.completed\ndata: {}\n\n",
        "event: response.completed\ndata: {\"type\":\"response\"}\n\n",
        "data: {\"type\":\"response.completed\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n",
        "data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
    ] {
        for prefix in ["", "data: {\"type\":\"response.created\"}\n\n"] {
            let mut capture = ErrorCapture::new_for_health(true, 200).for_endpoint("/v1/responses");
            let body = format!("{prefix}{ending}");
            assert_eq!(
                observe_chunks(&mut capture, body.as_bytes()).len(),
                1,
                "{body}"
            );
            assert!(!capture.terminal_seen());
            assert!(capture.error_seen());
        }
    }
}

#[test]
fn inferred_responses_cannot_finish_with_chat_done() {
    let mut capture = ErrorCapture::new(true, 200);
    let body = b"data: {\"type\":\"response.created\"}\n\ndata: [DONE]\n\n";
    assert_eq!(observe_chunks(&mut capture, body).len(), 1);
    assert!(!capture.terminal_seen());
}

#[test]
fn fragmented_valid_response_completion_is_healthy_with_or_without_done() {
    for suffix in ["", "data: [DONE]\r\n\r\n"] {
        let mut capture =
            ErrorCapture::new_for_health(true, 200).for_endpoint("/v1/responses?stream=true");
        let body = format!(
            "event: response.completed\r\ndata: {}\r\n\r\n{suffix}",
            json!({"type": "response.completed", "response": {"id": "resp_test", "status": "completed"}})
        );
        assert!(observe_chunks(&mut capture, body.as_bytes()).is_empty());
        assert!(capture.terminal_seen());
        assert!(!capture.error_seen());
    }
}

#[test]
fn terminal_frames_above_health_limit_remain_unknown() {
    let value = json!({
        "type": "response.completed",
        "response": {"id": "resp_test", "output": "x".repeat(MAX_COMPLETION_CAPTURE_BYTES + 1)}
    });
    for prefix in ["", "event: response.completed\n"] {
        let body = format!("{prefix}data: {value}\n\ndata: [DONE]\n\n");
        let mut capture = ErrorCapture::new_for_health(true, 200).for_endpoint("/v1/responses");
        for chunk in body.as_bytes().chunks(4096) {
            assert!(capture.observe(chunk).is_empty());
        }
        assert!(capture.finish().is_empty());
        assert!(!capture.terminal_seen());
        assert!(capture.completion_unverified());
        assert!(capture.diagnostic_summary().to_string().len() < 2000);
    }
}

#[test]
fn health_validates_large_terminal_suffixes_without_expanding_diagnostic_capture() {
    let output = "x".repeat(MAX_CAPTURE_BYTES * 2);
    for (suffix, healthy) in [
        (r#"", "status":"completed", "error":null}}"#, true),
        (
            r#"", "status":"failed", "error":{"code":"server_error"}}}"#,
            false,
        ),
        (r#"", "status":"completed"}BROKEN}"#, false),
        (r#"", "status":"completed"}} trailing"#, false),
    ] {
        let body = format!(
            "data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp\",\"output\":\"{output}{suffix}\n\n"
        );
        let mut capture = ErrorCapture::new_for_health(true, 200).for_endpoint("/v1/responses");
        let errors = observe_chunks(&mut capture, body.as_bytes());
        assert_eq!(capture.terminal_seen(), healthy, "{suffix}");
        assert_eq!(errors.is_empty(), healthy, "{suffix}");
        assert!(!capture.completion_unverified());
        let mut diagnostics = ErrorCapture::new(true, 200).for_endpoint("/v1/responses");
        assert!(observe_chunks(&mut diagnostics, body.as_bytes()).is_empty());
        assert!(diagnostics.completion_unverified());
        assert!(diagnostics.buffer.capacity() <= MAX_CAPTURE_BYTES);
    }
}

#[test]
fn oversized_nonterminal_events_still_require_completion() {
    let output = "x".repeat(MAX_CAPTURE_BYTES * 2);
    for (name, data) in [
        (
            "response.output_text.delta",
            format!(r#"{{"delta":"{output}","type":"response.output_text.delta"}}"#),
        ),
        (
            "",
            format!(r#"{{"type":"response.output_text.delta","delta":"{output}"}}"#),
        ),
        (
            "response.completed",
            format!(r#"{{"type":"response.output_text.delta","delta":"{output}"}}"#),
        ),
    ] {
        let body = format!("event: {name}\ndata: {data}\n\ndata: [DONE]\n\n");
        let mut capture = ErrorCapture::new_for_health(true, 200).for_endpoint("/v1/responses");
        assert_eq!(
            observe_chunks(&mut capture, body.as_bytes()).len(),
            1,
            "{name}"
        );
        assert!(!capture.terminal_seen());
        assert!(!capture.completion_unverified());
        assert!(capture.error_seen());
    }
}
