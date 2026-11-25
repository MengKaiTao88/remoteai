use super::*;

#[test]
fn quota_rejection_recovers_the_same_conversation_with_portable_context() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let (fixture, accounts) = OfficialResponsesFixture::concurrent(&url, 2);
    let mut portable = portable_tool_history();
    portable[0]["content"].as_array_mut().unwrap().extend([
        json!({"type":"input_file", "filename":"note.txt", "file_data":"data:text/plain;base64,bm90ZQ=="}),
        json!({"type":"input_image", "image_url":"data:image/png;base64,AA=="}),
    ]);
    let reasoning =
        json!({"type":"reasoning", "id":"rs_a", "summary":[], "encrypted_content":"sealed-a"});
    let summary = json!({"type":"reasoning", "id":"rs_a_summary", "encrypted_content":"sealed-a-summary",
        "summary":[{"type":"summary_text", "text":"The sample uses UTF-8."}]});
    let mut named_output = named_tool_result();
    named_output["id"] = "fco_account_a".into();
    let mut first = turn(json!([portable[0]]));
    let mut second = turn(json!([
        portable[0],
        reasoning,
        summary,
        named_output,
        portable[1],
        portable[2]
    ]));
    let tools = json!([{
        "type":"function","name":"inspect","parameters":{
            "type":"object","properties":{"file_id":{"type":"string"}}
        }
    }]);
    first["tools"] = tools.clone();
    second["tools"] = tools;
    first["reasoning"] = json!({"effort":"high"});
    second["reasoning"] = json!({"effort":"high"});
    let output = json!([reasoning, summary, named_output, portable[1]]);
    let worker =
        thread::spawn(move || verify_portable_recovery(upstream, accounts, portable, output));
    fixture.send(first);
    let after = fixture.send(second);
    assert_eq!(
        sse_event(&after, "response.completed")["response"]["id"],
        "resp_b"
    );
    worker.join().unwrap();
    fixture.join();
}

fn verify_portable_recovery(
    upstream: TcpListener,
    accounts: [String; 2],
    portable: Vec<Value>,
    output: Value,
) {
    let mut a = accept_official_socket(&upstream, &accounts[0]);
    assert_eq!(receive_turn(&mut a).0["input"], json!([portable[0]]));
    finish_turn(&mut a, "resp_a", output);
    let rejected = receive_turn(&mut a).0;
    assert_eq!(rejected["previous_response_id"], "resp_a");
    assert_eq!(rejected["input"], json!([portable[2]]));
    send_quota(&mut a);

    serve_recovery_catalog(&upstream, &accounts[1]);
    let mut b = accept_official_socket(&upstream, &accounts[1]);
    let resumed = receive_turn(&mut b).0;
    assert_eq!(
        resumed["input"],
        json!([
            portable[0],
            {"type":"message", "role":"assistant", "content":[{"type":"output_text", "text":"The sample uses UTF-8."}]},
            named_tool_result(),
            portable[1], portable[2]
        ])
    );
    assert!(resumed.get("previous_response_id").is_none());
    for key in [
        "model",
        "reasoning",
        "instructions",
        "tools",
        "service_tier",
    ] {
        assert_eq!(resumed[key], rejected[key]);
    }
    finish_turn(&mut b, "resp_b", json!([]));
}

fn named_tool_result() -> Value {
    json!({
        "type":"function_call_output", "name":"workspace_context", "namespace":"fixture",
        "output":"Previously gathered context."
    })
}

#[test]
fn mixed_account_history_survives_connection_clear_and_http_forwarding() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, 3, true);
    let paths = resolve_paths(fixture.app.handle()).unwrap();
    let backup = create_account(&paths, "b@example.test");
    let user = recovery_message("Original message");
    let a = recovery_reasoning("rs_a", "old-account-state");
    let b = recovery_reasoning("rs_b", "backup-account-state");
    let worker_a = a.clone();
    let worker_b = b.clone();
    let worker_user = user.clone();
    let worker =
        thread::spawn(move || verify_mixed_history(upstream, worker_user, worker_a, worker_b));
    fixture.send(turn(json!([user])));
    crate::local_proxy::official_websocket::clear(false);
    write_state(
        &paths,
        &ManagerStateFile {
            active_account_id: Some(backup),
            ..Default::default()
        },
    )
    .unwrap();
    crate::storage::write_json_atomic(
        &crate::storage::app_settings_path(fixture.app.handle()).unwrap(),
        &json!({"officialCodexWebsocketEnabled": false}),
    )
    .unwrap();

    fixture.send(turn(json!([user, a, recovery_message("Continue")])));
    fixture.send(turn(json!([
        user,
        a,
        recovery_message("Continue"),
        b,
        recovery_message("Next")
    ])));
    worker.join().unwrap();
    fixture.join();
}

fn verify_mixed_history(upstream: TcpListener, user: Value, old: Value, backup: Value) {
    let mut socket = accept_official_socket(&upstream, "a@example.test");
    receive_turn(&mut socket);
    finish_turn(&mut socket, "resp_a", json!([old]));
    drop(socket);

    let http = Server::from_listener(upstream, None).unwrap();
    let second = recovery_message("Continue");
    let third = recovery_message("Next");
    for (input, output) in [
        (json!([user, second]), json!([backup])),
        (json!([user, second, backup, third]), json!([])),
    ] {
        let mut request = http.recv_timeout(TIMEOUT).unwrap().unwrap();
        assert_eq!(request.method(), &Method::Post);
        safety::assert_account_header(&request, "b@example.test");
        assert!(request.headers().iter().any(|header| {
            header.field.equiv("thread-id") && header.value.as_str() == "websocket-conversation"
        }));
        assert!(!request
            .headers()
            .iter()
            .any(|header| header.field.equiv("x-codex-routing-hint")));
        let body: Value = serde_json::from_reader(request.as_reader()).unwrap();
        assert_eq!(body["input"], input);
        let event = turn_events("resp_http", output).pop().unwrap();
        request
            .respond(
                Response::from_string(format!("data: {event}\n\n"))
                    .with_header(Header::from_bytes("Content-Type", "text/event-stream").unwrap()),
            )
            .unwrap();
    }
}

#[test]
fn existing_conversation_can_recover_without_an_ownership_record() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, 1, true);
    let user = recovery_message("Existing conversation");
    let expected = user.clone();
    let worker = thread::spawn(move || {
        let mut socket = accept_official_socket(&upstream, "a@example.test");
        let actual = receive_turn(&mut socket).0;
        assert_eq!(actual["input"], json!([expected]));
        assert!(actual.get("previous_response_id").is_none());
        finish_turn(&mut socket, "resp_existing", json!([]));
    });
    fixture.send(turn(json!([
        user,
        recovery_reasoning("rs_existing", "unproven-state")
    ])));
    worker.join().unwrap();
    fixture.join();
}

fn recovery_message(text: &str) -> Value {
    json!({"type":"message","role":"user","content":[{"type":"input_text","text":text}]})
}

fn recovery_reasoning(id: &str, encrypted: &str) -> Value {
    json!({"type":"reasoning","id":id,"summary":[],"encrypted_content":encrypted})
}

#[test]
fn a_first_seen_conversation_with_unknown_required_state_stops_before_upload() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.server_addr());
    let fixture = OfficialResponsesFixture::new(&url, 2, false);
    let mut previous = turn(json!([recovery_message("Existing chat")]));
    previous["previous_response_id"] = "resp_unknown".into();
    let file = turn(json!([{
        "type":"message","role":"user","content":[{"type":"input_file","file_id":"file-unknown"}]
    }]));
    let worker = thread::spawn(move || {
        assert!(upstream
            .recv_timeout(Duration::from_millis(800))
            .unwrap()
            .is_none());
    });
    for body in [previous, file] {
        let response = fixture
            .request("pre-existing", "responses", body)
            .send()
            .unwrap();
        assert_eq!(response.status().as_u16(), 400);
        assert_eq!(
            response.json::<Value>().unwrap()["error"]["code"],
            "account_bound_context"
        );
    }
    worker.join().unwrap();
    fixture.join();
}
