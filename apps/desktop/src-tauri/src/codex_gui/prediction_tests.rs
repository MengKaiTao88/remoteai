use super::*;

fn request() -> PredictionRequest {
    PredictionRequest {
        thread_id: "thread".into(),
        source_turn_id: "turn".into(),
        model: "test-model".into(),
        effort: Effort::Low,
    }
}

fn thread() -> Value {
    json!({"id": "thread", "turns": [{"id": "turn", "status": "completed", "items": [
        {"type": "userMessage", "content": [{"type": "text", "text": "先给出深色模式的方案"},
            {"type": "image", "url": "private-image"}]},
        {"type": "reasoning", "text": "private-reasoning"},
        {"type": "commandExecution", "aggregatedOutput": "private-command-output"},
        {"type": "agentMessage", "phase": "commentary", "text": "private-progress"},
        {"type": "agentMessage", "phase": "final_answer", "text": "方案已经准备好了"}
    ]}]})
}

#[test]
fn prediction_uses_bounded_visible_history_without_tools_or_persistence() {
    let body = request_body(&thread(), &request()).unwrap();
    let encoded = body.to_string();
    assert!(!encoded.contains("private-"));
    assert_eq!(body["input"].as_array().unwrap().len(), 3);
    assert_eq!(body["tools"], json!([]));
    assert_eq!(body["store"], false);
    assert_eq!(body["max_output_tokens"], MAX_OUTPUT_TOKENS);
    assert_eq!(body["reasoning"]["effort"], "low");
}

#[test]
fn prediction_rejects_stale_running_failed_and_unanswered_turns() {
    let mut value = thread();
    value["turns"][0]["id"] = json!("different");
    assert!(request_body(&value, &request()).is_none());
    for status in ["inProgress", "failed", "interrupted"] {
        value = thread();
        value["turns"][0]["status"] = json!(status);
        assert!(request_body(&value, &request()).is_none());
    }
    value = thread();
    value["status"] = json!({"type": "active"});
    assert!(request_body(&value, &request()).is_none());
    value = thread();
    value["turns"][0]["items"] = json!([]);
    assert!(request_body(&value, &request()).is_none());
}

#[test]
fn history_is_utf8_safe_and_keeps_latest_messages_within_budget() {
    let mut value = thread();
    value["turns"][0]["items"][0]["content"][0]["text"] = json!("好".repeat(50_000));
    let body = request_body(&value, &request()).unwrap();
    assert_eq!(
        body["input"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        MAX_MESSAGE_CHARS
    );
    assert_eq!(body["input"][1]["role"], "assistant");
}

#[test]
fn prediction_input_and_output_are_validated() {
    let mut input = request();
    input.thread_id = "../other".into();
    assert!(input.validate().is_err());
    input = request();
    input.model = "\nsecret".into();
    assert!(input.validate().is_err());
    for text in ["", "两行\n建议", "需要继续吗？", "<script>", "`run`"] {
        assert_eq!(filter_suggestion(text), None);
    }
    assert_eq!(filter_suggestion(&"好".repeat(101)), None);
    assert_eq!(
        filter_suggestion(" 按这个方案实现 "),
        Some("按这个方案实现".into())
    );
}

#[test]
fn prediction_stream_requires_success_and_accepts_done_only_text() {
    use super::super::prediction_transport::parse_response;
    let stream = "data: {\"type\":\"response.output_text.done\",\"text\":\"按这个方案实现\"}\r\n\r\n\
        data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\r\n\r\n";
    assert_eq!(
        parse_response(stream.as_bytes()).unwrap(),
        Some("按这个方案实现".into())
    );
    assert!(parse_response(b"data: {\"type\":\"response.incomplete\"}\n\n").is_err());
    assert!(parse_response(
        b"data: {\"type\":\"response.output_text.done\",\"text\":\"partial\"}\n\n"
    )
    .is_err());
}

#[tokio::test]
async fn prediction_transport_uses_local_auth_and_parses_the_completed_response() {
    use crate::codex_config::{
        LOCAL_PROXY_ACTOR_AUTHORIZATION_HEADER, LOCAL_PROXY_REQUEST_PURPOSE_HEADER,
        LOCAL_PROXY_TOKEN, PREDICTION_REQUEST_PURPOSE,
    };
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = server.server_addr().to_ip().unwrap();
    let expected = request_body(&thread(), &request()).unwrap();
    let sent = expected.clone();
    let worker = std::thread::spawn(move || {
        let mut request = server
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(request.method(), &tiny_http::Method::Post);
        assert_eq!(request.url(), "/codex-gui/v1/responses");
        for (key, value) in [
            ("authorization", format!("Bearer {LOCAL_PROXY_TOKEN}")),
            (
                LOCAL_PROXY_ACTOR_AUTHORIZATION_HEADER,
                LOCAL_PROXY_TOKEN.into(),
            ),
            (
                LOCAL_PROXY_REQUEST_PURPOSE_HEADER,
                PREDICTION_REQUEST_PURPOSE.into(),
            ),
        ] {
            assert!(request.headers().iter().any(|header| header
                .field
                .as_str()
                .as_str()
                .eq_ignore_ascii_case(key)
                && header.value.as_str() == value));
        }
        let received: Value = serde_json::from_reader(request.as_reader()).unwrap();
        assert_eq!(received, expected);
        let completed = json!({"type": "response.completed", "response": {"status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "按方案实现"}]}]}});
        request
            .respond(tiny_http::Response::from_string(format!(
                "data: {completed}\n\ndata: [DONE]\n\n"
            )))
            .unwrap();
    });
    let result = super::super::prediction_transport::generate(
        &format!("http://{address}/codex-gui/v1"),
        sent,
    )
    .await;
    worker.join().unwrap();
    assert_eq!(result.unwrap(), Some("按方案实现".into()));
}
