use super::*;

const TURN_HEADER: &str = "x-codex-turn-metadata";
const TURN_STATE: &str = "x-codex-turn-state";
const LITE_HEADER: &str = "x-openai-internal-codex-responses-lite";
const LITE_METADATA: &str = "ws_request_header_x_openai_internal_codex_responses_lite";

#[test]
fn codex_websocket_preserves_frame_metadata_and_keeps_turn_state_private() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, 4, true);
    let worker = thread::spawn(move || verify_metadata_frames(upstream));
    let history = portable_tool_history();
    send_metadata_request(&fixture, turn(json!([history[0]])), "first");
    let mut second = turn(json!(history));
    second["client_metadata"] =
        json!({"turn_id":"first", (TURN_HEADER):"body-value", (TURN_STATE):"stale-input"});
    send_metadata_request(&fixture, second, "first");
    send_metadata_request(&fixture, turn(third_input(&history)), "next");
    let mut fourth = third_input(&history);
    fourth.as_array_mut().unwrap().push(history[0].clone());
    send_metadata_request(&fixture, turn(fourth), "next");
    worker.join().unwrap();
    fixture.join();
}

fn send_metadata_request(fixture: &OfficialResponsesFixture, body: Value, turn_id: &str) {
    let response = fixture
        .request("metadata", "responses", body)
        .header(TURN_HEADER, json!({"turn_id":turn_id}).to_string())
        .header(LITE_HEADER, "true")
        .send()
        .unwrap()
        .error_for_status()
        .unwrap();
    assert!(!response.headers().contains_key(TURN_STATE));
    let text = response.text().unwrap();
    assert!(!text.contains("private-affinity"));
    assert!(text.contains("response.completed"));
}

fn verify_metadata_frames(upstream: TcpListener) {
    let (stream, _) = upstream.accept().unwrap();
    let mut socket =
        accept_socket_with_turn_state(stream, "a@example.test", Some("private-affinity-first"));
    let history = portable_tool_history();
    let first = receive_turn(&mut socket).0;
    assert_eq!(
        first["client_metadata"][TURN_HEADER],
        r#"{"turn_id":"first"}"#
    );
    assert_eq!(first["client_metadata"][LITE_METADATA], "true");
    // The upgrade headers are available before the opening frame.
    assert_eq!(
        first["client_metadata"][TURN_STATE],
        "private-affinity-first"
    );
    finish_turn(&mut socket, "resp_metadata", json!([history[1]]));
    let second = receive_turn(&mut socket).0;
    assert_eq!(second["previous_response_id"], "resp_metadata");
    assert_eq!(second["client_metadata"][TURN_HEADER], "body-value");
    assert_eq!(
        second["client_metadata"][TURN_STATE],
        "private-affinity-first"
    );
    finish_turn(&mut socket, "resp_metadata_second", json!([]));
    let next = receive_turn(&mut socket).0;
    assert_eq!(next["previous_response_id"], "resp_metadata_second");
    assert!(next["client_metadata"].get(TURN_STATE).is_none());
    socket
        .send(Message::text(
            json!({
                "type":"response.metadata",
                "headers":{(TURN_STATE):["private-affinity-next"]},
            })
            .to_string(),
        ))
        .unwrap();
    finish_turn(&mut socket, "resp_metadata_next", json!([]));
    let last = receive_turn(&mut socket).0;
    assert_eq!(last["previous_response_id"], "resp_metadata_next");
    assert_eq!(last["client_metadata"][TURN_STATE], "private-affinity-next");
    finish_turn(&mut socket, "resp_metadata_last", json!([]));
}

#[test]
fn wrapped_websocket_errors_preserve_opening_http_status_and_safe_headers() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, 1, true);
    let worker = thread::spawn(move || {
        let mut socket = accept_official_socket(&upstream, "a@example.test");
        receive_turn(&mut socket);
        let rejection = json!({
            "type":"error", "status_code":403,
            "error":{"type":"invalid_request_error","message":"account rejected","headers":{"retry-after":8}},
            "headers":{"Retry-After":12,(TURN_STATE):"private-affinity-error"},
        });
        socket.send(Message::text(rejection.to_string())).unwrap();
    });
    let response = fixture
        .request(
            "error",
            "responses",
            turn(json!([portable_tool_history()[0]])),
        )
        .send()
        .unwrap();
    assert_eq!(response.status().as_u16(), 403);
    assert_eq!(response.headers()["retry-after"], "8");
    assert!(!response.headers().contains_key(TURN_STATE));
    let text = response.text().unwrap();
    assert!(text.contains("account rejected"));
    assert!(!text.contains("private-affinity"));
    worker.join().unwrap();
    fixture.join();
}

#[test]
fn wrapped_header_quota_can_replay_self_contained_lite_tools_on_a_backup() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let (fixture, accounts) = OfficialResponsesFixture::concurrent_for(
        &url,
        1,
        ["lite-a@example.test".into(), "lite-b@example.test".into()],
    );
    let input = json!([
        {"type":"additional_tools","role":"developer","tools":[{"type":"function","name":"inspect"}]},
        portable_tool_history()[0]
    ]);
    let expected = input.clone();
    let worker = thread::spawn(move || {
        let (stream, _) = upstream.accept().unwrap();
        let mut first =
            accept_socket_with_turn_state(stream, &accounts[0], Some("private-affinity-primary"));
        let initial = receive_turn(&mut first).0;
        assert_eq!(initial["input"], expected);
        assert_eq!(
            initial["client_metadata"][TURN_STATE],
            "private-affinity-primary"
        );
        let rejection = json!({
            "type":"error", "status":429, "error":{"type":"rate_limit_exceeded"},
            "headers":{"x-codex-rate-limit-reached-type":"workspace_member_usage_limit_reached","Retry-After":"120"}
        });
        first.send(Message::text(rejection.to_string())).unwrap();
        let mut backup = accept_official_socket(&upstream, &accounts[1]);
        let replay = receive_turn(&mut backup).0;
        assert_eq!(replay["input"], expected);
        assert_eq!(replay["client_metadata"][LITE_METADATA], "true");
        assert!(replay["client_metadata"].get(TURN_STATE).is_none());
        finish_turn(&mut backup, "resp_lite_backup", json!([]));
    });
    let mut body = turn(input);
    body["client_metadata"] = json!({(TURN_STATE):"untrusted-state"});
    let response = fixture
        .request("lite", "responses", body)
        .header(TURN_HEADER, r#"{"turn_id":"lite"}"#)
        .header(LITE_HEADER, "true")
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .text()
        .unwrap();
    assert_eq!(
        sse_event(&response, "response.completed")["response"]["id"],
        "resp_lite_backup"
    );
    worker.join().unwrap();
    fixture.join();
}

#[test]
fn an_account_specific_http_retry_keeps_the_account_that_received_the_first_attempt() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = Server::http("127.0.0.1:0").unwrap();
    let fixture =
        OfficialResponsesFixture::new(&format!("http://{}", upstream.server_addr()), 1, true);
    let paths = resolve_paths(fixture.app.handle()).unwrap();
    let backup = create_account(&paths, "b@example.test");
    let worker = thread::spawn(move || verify_transient_http_retry(upstream, paths, backup));
    let response = gui_runtime_client()
        .post(format!("{}/v1/responses", fixture.base_url))
        .bearer_auth(crate::codex_config::LOCAL_PROXY_TOKEN)
        .json(&turn(owned_file_input()))
        .send()
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    worker.join().unwrap();
    fixture.join();
}

fn verify_transient_http_retry(upstream: Server, paths: Paths, backup: String) {
    let first = upstream.recv_timeout(TIMEOUT).unwrap().unwrap();
    super::safety::assert_account_header(&first, "a@example.test");
    select_account(&paths, backup);
    first
        .respond(
            Response::from_string(
                r#"{"error":{"type":"rate_limit_exceeded","message":"transient limit"}}"#,
            )
            .with_status_code(429),
        )
        .unwrap();
    let next = upstream.recv_timeout(TIMEOUT).unwrap().unwrap();
    super::safety::assert_account_header(&next, "a@example.test");
    next.respond(Response::from_string("{}")).unwrap();
}

fn owned_file_input() -> Value {
    json!([{"type":"message","role":"user","content":[{"type":"input_file","file_id":"file-fixture"}]}])
}

fn select_account(paths: &Paths, account: String) {
    write_state(
        paths,
        &ManagerStateFile {
            active_account_id: Some(account),
            ..Default::default()
        },
    )
    .unwrap();
}

#[test]
fn a_failed_new_account_does_not_replace_the_confirmed_owner() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, 3, true);
    let paths = resolve_paths(fixture.app.handle()).unwrap();
    let primary = read_state(&paths).active_account_id.unwrap();
    let backup = create_account(&paths, "b@example.test");
    let worker = thread::spawn(move || verify_failed_owner_change(upstream));
    let portable = turn(json!([portable_tool_history()[0]]));
    fixture.send(portable.clone());
    select_account(&paths, backup);
    let rejected = fixture
        .request("websocket-conversation", "responses", portable)
        .send()
        .unwrap();
    assert_eq!(rejected.status().as_u16(), 400);
    select_account(&paths, primary);
    fixture.send(turn(owned_file_input()));
    worker.join().unwrap();
    fixture.join();
}

fn verify_failed_owner_change(upstream: TcpListener) {
    let mut first = accept_official_socket(&upstream, "a@example.test");
    receive_turn(&mut first);
    finish_turn(&mut first, "resp_owner", json!([]));
    let mut backup = accept_official_socket(&upstream, "b@example.test");
    receive_turn(&mut backup);
    backup.send(Message::text(json!({
        "type":"error","status":400,"error":{"type":"invalid_request_error","message":"rejected"}
    }).to_string())).unwrap();
    let mut primary = accept_official_socket(&upstream, "a@example.test");
    assert_eq!(receive_turn(&mut primary).0["input"], owned_file_input());
    finish_turn(&mut primary, "resp_original_owner", json!([]));
}

#[test]
fn an_unanswered_opening_websocket_is_closed_at_the_response_deadline() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let fixture = OfficialResponsesFixture::new(
        &format!("http://{}", upstream.local_addr().unwrap()),
        1,
        true,
    );
    crate::storage::write_json_atomic(
        &crate::storage::app_settings_path(fixture.app.handle()).unwrap(),
        &json!({"officialCodexWebsocketEnabled":true,"responseHeaderTimeout":{"timeoutSeconds":1}}),
    )
    .unwrap();
    let (received, sent) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        let mut socket = accept_official_socket(&upstream, "a@example.test");
        receive_turn(&mut socket);
        received.send(()).unwrap();
        assert!(matches!(
            socket.read(),
            Err(tungstenite::Error::Protocol(
                tungstenite::error::ProtocolError::ResetWithoutClosingHandshake
            )) | Ok(Message::Close(_))
        ));
    });
    let client = start_silent_request(&fixture);
    sent.recv_timeout(TIMEOUT).unwrap();
    client.shutdown(std::net::Shutdown::Both).unwrap();
    drop(client);
    worker.join().unwrap();
    fixture.join();
}

fn start_silent_request(fixture: &OfficialResponsesFixture) -> TcpStream {
    let address = fixture.base_url.strip_prefix("http://").unwrap();
    let body = turn(json!([portable_tool_history()[0]])).to_string();
    let mut stream = TcpStream::connect(address).unwrap();
    write!(stream,
        "POST /v1/responses HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nthread-id: deadline\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        crate::codex_config::LOCAL_PROXY_TOKEN, body.len(),
    ).unwrap();
    stream
}
