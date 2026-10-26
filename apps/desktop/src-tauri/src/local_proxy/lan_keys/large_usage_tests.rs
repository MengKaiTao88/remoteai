use super::*;
use std::io::Cursor;

const LARGE_OUTPUT_BYTES: usize = 128 * 1024;
const FRAGMENT_BYTES: usize = 4093;
const QUOTA_REFRESHES: usize = 5;

fn completed_body(usage: Option<serde_json::Value>) -> Vec<u8> {
    let mut response = json!({
        "id": "resp_large", "status": "completed", "error": null,
        "output": [{"type": "message", "content": [{"type": "output_text", "text": "x".repeat(LARGE_OUTPUT_BYTES)}]}]
    });
    if let Some(usage) = usage {
        response["usage"] = usage;
    }
    format!(
        "data: {}\n\n",
        json!({"type": "response.completed", "response": response})
    )
    .into_bytes()
}

fn capture_body(fixture: &Fixture, body: Vec<u8>, streaming: bool) {
    let body = if streaming {
        proxy::UpstreamBody::Streaming(Box::new(Cursor::new(body)))
    } else {
        proxy::UpstreamBody::Buffered(body)
    };
    let payload = proxy::UpstreamPayload {
        content_type: Some("text/event-stream".into()),
        body,
        ..proxy::json_payload(200, json!({}))
    };
    let mut captured = proxy::attach_token_usage_capture(
        fixture.app.handle(),
        Some(fixture.context("/v1/responses")),
        Ok(payload),
    )
    .unwrap();
    if let proxy::UpstreamBody::Streaming(reader) = &mut captured.body {
        let mut fragment = [0; FRAGMENT_BYTES];
        while reader.read(&mut fragment).unwrap() != 0 {}
    }
}

fn assert_repeated_http_quota(fixture: &Fixture) {
    let state = storage::try_read_state(&fixture.paths).unwrap();
    let key = &state.local_proxy_lan_api_keys[0].api_key;
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1/codex-switch/quota", server.server_addr());
    let app = fixture.app.handle().clone();
    let timeout = Duration::from_secs(10);
    let worker = std::thread::spawn(move || {
        for _ in 0..QUOTA_REFRESHES {
            let request = server.recv_timeout(timeout).unwrap().unwrap();
            proxy::handle_request(app.clone(), request);
        }
    });
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .unwrap();
    for _ in 0..QUOTA_REFRESHES {
        let response = client.get(&url).bearer_auth(key).send().unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let value: serde_json::Value = response.json().unwrap();
        assert_eq!(value["usageIncomplete"], false);
        assert_eq!(value["unconfirmedRequests"], 0);
        assert_eq!(value["usedTokens"], 25);
        assert!(value["remainingUsd"].as_f64().unwrap() > 0.0);
    }
    worker.join().unwrap();
}

#[test]
fn large_completed_responses_confirm_usage_and_return_a_readable_quota() {
    for streaming in [false, true] {
        let fixture = Fixture::new();
        let body = completed_body(Some(
            json!({"input_tokens": 20, "output_tokens": 5, "total_tokens": 25}),
        ));
        capture_body(&fixture, body, streaming);
        let usage = fixture.usage();
        assert_eq!(usage.tokens, 25);
        assert!(usage.cost_usd > 0.0);
        assert_eq!(usage.unconfirmed_requests, 0);
        assert_repeated_http_quota(&fixture);
        assert_eq!(fixture.usage().tokens, 25);
        assert_eq!(fixture.usage().cost_usd, usage.cost_usd);
    }
}

#[test]
fn large_completed_responses_without_usage_still_need_review() {
    for streaming in [false, true] {
        let fixture = Fixture::new();
        capture_body(&fixture, completed_body(None), streaming);
        assert_eq!(fixture.usage().unconfirmed_requests, 1);
    }
}

#[test]
fn large_failed_responses_do_not_add_cost_or_unconfirmed_requests() {
    for streaming in [false, true] {
        let fixture = Fixture::new();
        let response = json!({
            "id": "resp_failed", "status": "failed", "output": "x".repeat(LARGE_OUTPUT_BYTES),
            "error": {"message": "upstream failed"},
            "usage": {"input_tokens": 20, "output_tokens": 5}
        });
        let body = format!(
            "data: {}\n\n",
            json!({"type": "response.completed", "response": response})
        );
        capture_body(&fixture, body.into_bytes(), streaming);
        let usage = fixture.usage();
        assert_eq!(usage.tokens, 0);
        assert_eq!(usage.cost_usd, 0.0);
        assert_eq!(usage.unconfirmed_requests, 0);
    }
}
