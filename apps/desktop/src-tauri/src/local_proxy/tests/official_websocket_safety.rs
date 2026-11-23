use super::*;

#[test]
fn quota_backup_uses_http_if_its_websocket_upgrade_is_rejected() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let (fixture, accounts) = OfficialResponsesFixture::concurrent(&url, 2);
    let history = portable_tool_history();
    let expected = history.clone();
    let worker = thread::spawn(move || verify_quota_http_fallback(upstream, &accounts, &expected));
    fixture.send(turn(json!([history[0]])));
    let reply = fixture.send(turn(json!(history)));
    assert_eq!(
        sse_event(&reply, "response.completed")["response"]["id"],
        "resp_backup_http"
    );
    worker.join().unwrap();
    fixture.join();
}

fn verify_quota_http_fallback(upstream: TcpListener, accounts: &[String; 2], expected: &[Value]) {
    let mut a = accept_official_socket(&upstream, &accounts[0]);
    receive_turn(&mut a);
    finish_turn(&mut a, "resp_primary", json!([expected[1]]));
    assert_eq!(
        receive_turn(&mut a).0["previous_response_id"],
        "resp_primary"
    );
    send_quota(&mut a);
    let server = Server::from_listener(upstream, None).unwrap();
    let upgrade = server.recv_timeout(TIMEOUT).unwrap().unwrap();
    assert_eq!(upgrade.method(), &Method::Get);
    assert_account_header(&upgrade, &accounts[1]);
    upgrade.respond(Response::empty(426)).unwrap();
    let mut request = server.recv_timeout(TIMEOUT).unwrap().unwrap();
    assert_eq!(request.method(), &Method::Post);
    assert_account_header(&request, &accounts[1]);
    assert!(!request
        .headers()
        .iter()
        .any(|header| header.field.equiv("x-codex-routing-hint")));
    let body: Value = serde_json::from_reader(request.as_reader()).unwrap();
    assert_eq!(body["input"], json!(expected));
    assert!(body.get("previous_response_id").is_none());
    assert!(body.get("type").is_none());
    let value = turn_events("resp_backup_http", json!([])).pop().unwrap();
    request
        .respond(
            Response::from_string(format!("data: {value}\n\n"))
                .with_header(Header::from_bytes("Content-Type", "text/event-stream").unwrap()),
        )
        .unwrap();
}

fn assert_account_header(request: &Request, email: &str) {
    let auth = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("authorization"))
        .unwrap();
    assert_eq!(auth.value.as_str(), format!("Bearer test-token-{email}"));
}

#[test]
fn committed_output_and_uncertain_delivery_do_not_replay() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    for committed in [false, true] {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", upstream.local_addr().unwrap());
        let (fixture, accounts) = OfficialResponsesFixture::concurrent(&url, 1);
        let worker = thread::spawn(move || {
            let mut socket = accept_official_socket(&upstream, &accounts[0]);
            receive_turn(&mut socket);
            if committed {
                socket
                    .send(Message::text(
                        json!({
                            "type": "response.output_text.delta", "delta": "already sent"
                        })
                        .to_string(),
                    ))
                    .unwrap();
                send_quota(&mut socket);
            }
            drop(socket);
            assert_no_connection(upstream);
        });
        let reply = fixture
            .request(
                "ambiguous-delivery",
                "responses",
                turn(json!([portable_tool_history()[0]])),
            )
            .send()
            .unwrap();
        if committed {
            assert_eq!(reply.status().as_u16(), 200);
            let text = reply.text().unwrap();
            assert_eq!(text.matches("already sent").count(), 1);
            assert_eq!(
                sse_event(&text, "response.failed")["response"]["error"]["type"],
                "usage_limit_reached"
            );
        } else {
            assert_eq!(reply.status().as_u16(), 502);
        }
        worker.join().unwrap();
        fixture.join();
    }
}

#[test]
fn account_state_and_incomplete_tool_history_do_not_cross_accounts() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let inputs = [
        json!([{"type":"message","role":"user","content":[{"type":"input_file","file_id":"file-a"}]}]),
        json!([{"type":"reasoning","id":"rs_fixture","summary":[],"encrypted_content":"account-a"}]),
        json!([{"type":"function_call_output","call_id":"missing-call","output":"partial"}]),
    ];
    for (index, input) in inputs.into_iter().enumerate() {
        // Each branch has a distinct session and account IDs so successful quota exclusion
        // cannot affect the opening account in the next fixture.
        run_nonportable_quota_case(input, index);
    }
}

fn run_nonportable_quota_case(input: Value, index: usize) {
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let accounts = [
        format!("a{index}@example.test"),
        format!("b{index}@example.test"),
    ];
    let (fixture, accounts) = OfficialResponsesFixture::concurrent_for(&url, 1, accounts);
    let worker = thread::spawn(move || {
        let mut socket = accept_official_socket(&upstream, &accounts[0]);
        receive_turn(&mut socket);
        send_quota(&mut socket);
        assert_no_connection(upstream);
    });
    let response = fixture
        .request(&format!("nonportable-{index}"), "responses", turn(input))
        .send()
        .unwrap();
    assert_eq!(response.status().as_u16(), 429);
    let failure: Value = response.json().unwrap();
    assert_eq!(failure["error"]["type"], "usage_limit_reached");
    worker.join().unwrap();
    fixture.join();
}

#[test]
fn gui_responses_use_the_selected_official_account_and_unchanged_http_ingress() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::gui(&url, 2);
    let history = portable_tool_history();
    let expected = history.clone();
    let worker = thread::spawn(move || {
        let mut socket = accept_official_socket(&upstream, "a@example.test");
        assert_eq!(receive_turn(&mut socket).0["input"], json!([expected[0]]));
        finish_turn(&mut socket, "resp_gui", json!([expected[1]]));
        let next = receive_turn(&mut socket).0;
        assert_eq!(next["previous_response_id"], "resp_gui");
        assert_eq!(next["input"], json!([expected[2]]));
        finish_turn(&mut socket, "resp_gui_next", json!([]));
    });
    fixture.send(turn(json!([history[0]])));
    let after = fixture.send(turn(json!(history)));
    assert_eq!(
        sse_event(&after, "response.completed")["response"]["id"],
        "resp_gui_next"
    );
    worker.join().unwrap();
    fixture.join();
}

#[test]
fn cancelling_a_client_stream_closes_its_websocket() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, 1, true);
    let worker = thread::spawn(move || {
        let mut socket = accept_official_socket(&upstream, "a@example.test");
        receive_turn(&mut socket);
        socket
            .send(Message::text(
                json!({
                    "type": "response.output_text.delta", "delta": "after first output"
                })
                .to_string(),
            ))
            .unwrap();
        assert!(
            matches!(
                socket.read(),
                Ok(Message::Close(_))
                    | Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::Protocol(_))
            ),
            "the unfinished upstream socket should close when the HTTP client drops the stream"
        );
        assert_no_connection(upstream);
    });
    let mut response = fixture
        .request(
            "cancel",
            "responses",
            turn(json!([portable_tool_history()[0]])),
        )
        .send()
        .unwrap();
    let mut prefix = String::new();
    BufReader::new(&mut response)
        .read_line(&mut prefix)
        .unwrap();
    assert!(prefix.starts_with("event: response.output_text.delta"));
    drop(response);
    worker.join().unwrap();
    fixture.join();
}

fn assert_no_connection(upstream: TcpListener) {
    upstream.set_nonblocking(true).unwrap();
    thread::sleep(Duration::from_millis(200));
    let Err(error) = upstream.accept() else {
        panic!("request was replayed")
    };
    assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
}

#[test]
fn an_explicit_account_change_cannot_forward_a_known_accounts_state() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, 2, true);
    let paths = resolve_paths(fixture.app.handle()).unwrap();
    let backup = create_account(&paths, "b@example.test");
    let input = message("initial");
    let reasoning =
        json!({"type":"reasoning","id":"rs_fixture","summary":[],"encrypted_content":"account-a"});
    let expected = reasoning.clone();
    let worker = thread::spawn(move || {
        let mut socket = accept_official_socket(&upstream, "a@example.test");
        receive_turn(&mut socket);
        finish_turn(&mut socket, "resp_primary", json!([expected]));
        assert!(matches!(
            socket.read(),
            Err(tungstenite::Error::Protocol(_))
        ));
        assert_no_connection(upstream);
    });
    fixture.send(turn(json!([input])));
    write_state(
        &paths,
        &ManagerStateFile {
            active_account_id: Some(backup),
            ..Default::default()
        },
    )
    .unwrap();
    let request = fixture.request(
        "websocket-conversation",
        "responses",
        turn(json!([input, reasoning, message("continue")])),
    );
    let response = request.send().unwrap();
    assert_eq!(response.status().as_u16(), 409);
    assert_eq!(
        response.json::<Value>().unwrap()["error"]["code"],
        "permission_denied"
    );
    worker.join().unwrap();
    fixture.join();
}

#[test]
fn two_active_conversations_keep_independent_upstream_continuations() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, 4, true);
    let worker = thread::spawn(move || {
        let mut first = accept_official_socket(&upstream, "a@example.test");
        let mut second = accept_official_socket(&upstream, "a@example.test");
        let first_id = conversation_id(&receive_turn(&mut first).0);
        let second_id = conversation_id(&receive_turn(&mut second).0);
        assert_ne!(first_id, second_id);
        finish_turn(&mut first, &first_id, json!([]));
        finish_turn(&mut second, &second_id, json!([]));
        verify_conversation_continuation(first, &first_id);
        verify_conversation_continuation(second, &second_id);
    });
    send_parallel(&fixture, false);
    send_parallel(&fixture, true);
    worker.join().unwrap();
    fixture.join();
}

fn message(text: &str) -> Value {
    json!({"type":"message","role":"user","content":[{"type":"input_text","text":text}]})
}

fn conversation_id(request: &Value) -> String {
    let name = request["input"][0]["content"][0]["text"].as_str().unwrap();
    format!("resp_{name}")
}

fn send_parallel(fixture: &OfficialResponsesFixture, next: bool) {
    thread::scope(|scope| {
        for session in ["first", "second"] {
            let mut input = vec![message(session)];
            if next {
                input.push(message(&format!("next-{session}")));
            }
            let request = fixture.request(session, "responses", turn(json!(input)));
            scope.spawn(move || {
                let response = request
                    .send()
                    .unwrap()
                    .error_for_status()
                    .unwrap()
                    .text()
                    .unwrap();
                let prefix = if next { "resp_next_" } else { "resp_" };
                assert_eq!(
                    sse_event(&response, "response.completed")["response"]["id"],
                    format!("{prefix}{session}")
                );
            });
        }
    });
}

fn verify_conversation_continuation(mut socket: MockSocket, id: &str) {
    let next = receive_turn(&mut socket).0;
    assert_eq!(next["previous_response_id"], id);
    let session = id.strip_prefix("resp_").unwrap();
    assert_eq!(next["input"], json!([message(&format!("next-{session}"))]));
    finish_turn(&mut socket, &format!("resp_next_{session}"), json!([]));
}

#[test]
fn changed_history_model_and_compaction_each_begin_with_full_input() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, 5, true);
    let worker = thread::spawn(move || verify_full_input_after_changes(upstream));
    fixture.send(turn(json!([message("initial")])));
    fixture.send(turn(json!([message("rewritten")])));
    let mut changed_model = turn(json!([message("rewritten"), message("same history")]));
    changed_model["model"] = "gpt-5.6-pro".into();
    fixture.send(changed_model.clone());
    let response = fixture
        .request(
            "websocket-conversation",
            "responses/compact",
            changed_model.clone(),
        )
        .send()
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.json::<Value>().unwrap()["id"], "compact_fixture");
    changed_model["input"]
        .as_array_mut()
        .unwrap()
        .push(message("new turn"));
    fixture.send(changed_model);
    worker.join().unwrap();
    fixture.join();
}

fn verify_full_input_after_changes(upstream: TcpListener) {
    for (id, expected) in [
        ("resp_initial", json!([message("initial")])),
        ("resp_rewrite", json!([message("rewritten")])),
        (
            "resp_model",
            json!([message("rewritten"), message("same history")]),
        ),
    ] {
        let mut socket = accept_official_socket(&upstream, "a@example.test");
        let body = receive_turn(&mut socket).0;
        assert!(body.get("previous_response_id").is_none());
        assert_eq!(body["input"], expected);
        if id == "resp_model" {
            assert_eq!(body["model"], "gpt-5.6-pro");
        }
        finish_turn(&mut socket, id, json!([]));
        // Keep each socket until the next request. The expected new connection
        // must come from incompatible input or options, independent of transport health.
        assert!(matches!(
            socket.read(),
            Err(tungstenite::Error::Protocol(_))
        ));
    }
    serve_compaction_http(&upstream);
    let mut socket = accept_official_socket(&upstream, "a@example.test");
    let after = receive_turn(&mut socket).0;
    assert!(after.get("previous_response_id").is_none());
    assert_eq!(
        after["input"],
        json!([
            message("rewritten"),
            message("same history"),
            message("new turn")
        ])
    );
    finish_turn(&mut socket, "resp_compacted", json!([]));
}

fn serve_compaction_http(upstream: &TcpListener) {
    let (stream, _) = upstream.accept().unwrap();
    stream.set_read_timeout(Some(TIMEOUT)).unwrap();
    let mut stream = BufReader::new(stream);
    let mut line = String::new();
    stream.read_line(&mut line).unwrap();
    assert!(line.starts_with("POST /responses/compact HTTP/1.1"));
    let mut length = None;
    while line != "\r\n" {
        line.clear();
        assert_ne!(stream.read_line(&mut line).unwrap(), 0);
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = Some(value.trim().parse::<usize>().unwrap());
        }
    }
    stream.read_exact(&mut vec![0; length.unwrap()]).unwrap();
    let body = br#"{"id":"compact_fixture","output":[]}"#;
    write!(
        stream.get_mut(),
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .unwrap();
    stream.get_mut().write_all(body).unwrap();
}
