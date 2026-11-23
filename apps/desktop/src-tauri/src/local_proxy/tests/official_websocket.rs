use super::*;
use std::net::TcpListener;
use tungstenite::Message;

#[path = "official_websocket_safety.rs"]
mod safety;

#[path = "official_websocket_protocol.rs"]
mod protocol;

const TIMEOUT: Duration = Duration::from_secs(10);

#[test]
fn official_responses_reuses_confirmed_history_over_websocket() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream_url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&upstream_url, 2, true);
    let user = json!({"type":"message","role":"user","content":[{
        "type":"input_text", "text":"background ".repeat(10_000)
    }]});
    let message = json!({
        "type": "message", "role": "assistant", "status": "completed", "phase": "commentary",
        "content": [{"type":"output_text", "text":"I will inspect the sample.", "annotations":[]}]
    });
    let call = json!({"type":"function_call","name":"inspect","arguments":"{}","call_id":"call_1",
        "id":"fc_fixture","status":"completed"});
    let reasoning = json!({"type":"reasoning","id":"rs_fixture","summary":[],"content":null,
        "encrypted_content":"synthetic-opaque-reasoning"});
    let output = json!({"type":"function_call_output","call_id":"call_1","output":"done"});
    let expected = TurnHistory {
        user,
        message,
        reasoning,
        call,
        output,
    };
    let first_body = turn(json!([expected.user]));
    let second_body = turn(json!([
        expected.user,
        expected.message,
        expected.reasoning,
        expected.call,
        expected.output
    ]));
    let output_items = wire_output(&expected);
    let worker = thread::spawn(move || verify_two_websocket_turns(upstream, expected));
    let first = fixture.send(first_body.clone());
    assert_eq!(
        sse_event(&first, "response.completed")["response"]["output"],
        output_items
    );
    let second = fixture.send(second_body.clone());
    assert_eq!(
        sse_event(&second, "response.completed")["response"]["id"],
        "resp_2"
    );
    let websocket_bytes = worker.join().unwrap();
    fixture.join();
    let (http, first_http, second_http) = http_baseline([first_body, second_body], output_items);
    assert_eq!((first, second), (first_http, second_http));
    eprintln!("Official Responses request payload bytes: HTTP={http}; WebSocket={websocket_bytes}");
    assert!(
        websocket_bytes < http * 3 / 4,
        "{websocket_bytes} vs {http}"
    );
}

#[test]
fn official_responses_switches_to_a_full_websocket_turn_then_continues_on_the_backup() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let (fixture, accounts) = OfficialResponsesFixture::concurrent(&url, 3);
    let history = portable_tool_history();
    let worker_history = history.clone();
    let worker =
        thread::spawn(move || verify_switched_websocket_turns(upstream, accounts, worker_history));
    fixture.send(turn(Value::Array(history[..1].to_vec())));
    let second = fixture.send(turn(json!(history)));
    assert_eq!(
        sse_event(&second, "response.completed")["response"]["id"],
        "resp_backup"
    );
    assert!(!second.contains("usage_limit_reached"));
    let third = fixture.send(turn(third_input(&history)));
    assert_eq!(
        sse_event(&third, "response.completed")["response"]["id"],
        "resp_backup_next"
    );
    worker.join().unwrap();
    let usage = load_token_usage_summary_entries(fixture.app.handle(), 0).unwrap();
    assert_eq!(usage.len(), 3);
    let mut owners = usage
        .into_iter()
        .map(|record| record.account_email.unwrap())
        .collect::<Vec<_>>();
    owners.sort();
    assert_eq!(
        owners,
        ["a@example.test", "b@example.test", "b@example.test"]
    );
    fixture.join();
}

fn portable_tool_history() -> Vec<Value> {
    vec![
        json!({"type":"message","role":"user","content":[{"type":"input_text","text":"inspect this"}]}),
        json!({"type":"function_call","name":"inspect","arguments":"{}","call_id":"call_1"}),
        json!({"type":"function_call_output","call_id":"call_1","output":"done"}),
    ]
}

fn third_input(history: &[Value]) -> Value {
    let mut input = history.to_vec();
    input.push(
        json!({"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}),
    );
    Value::Array(input)
}

fn verify_switched_websocket_turns(
    upstream: TcpListener,
    accounts: [String; 2],
    history: Vec<Value>,
) {
    let mut a = accept_official_socket(&upstream, &accounts[0]);
    assert_eq!(receive_turn(&mut a).0["input"], json!([history[0]]));
    finish_turn(&mut a, "resp_primary", json!([history[1]]));
    let delta = receive_turn(&mut a).0;
    assert_eq!(delta["input"], json!([history[2]]));
    assert_eq!(delta["previous_response_id"], "resp_primary");
    send_quota(&mut a);
    let mut b = accept_official_socket(&upstream, &accounts[1]);
    let full = receive_turn(&mut b).0;
    assert_eq!(full["input"], json!(history));
    assert!(full.get("previous_response_id").is_none());
    finish_turn(&mut b, "resp_backup", json!([]));
    let next = receive_turn(&mut b).0;
    assert_eq!(next["previous_response_id"], "resp_backup");
    assert_eq!(next["input"], json!([third_input(&history)[3]]));
    finish_turn(&mut b, "resp_backup_next", json!([]));
}

fn send_quota(socket: &mut MockSocket) {
    for event in [
        json!({"type":"response.created","response":{"id":"resp_failed","output":[]}}),
        json!({"type":"codex.rate_limits"}),
        json!({"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"exhausted"}}),
    ] {
        socket.send(Message::text(event.to_string())).unwrap();
    }
}

struct TurnHistory {
    user: Value,
    message: Value,
    reasoning: Value,
    call: Value,
    output: Value,
}

fn wire_output(turn: &TurnHistory) -> Value {
    let mut reasoning = turn.reasoning.clone();
    reasoning["status"] = "completed".into();
    reasoning["content"] = json!([{"type":"reasoning_text","text":"upstream-only reasoning"}]);
    let mut call = turn.call.clone();
    call["namespace"] = Value::Null;
    call["encrypted_function_args"] = Value::Null;
    let mut items = [turn.message.clone(), reasoning, call];
    // In real Codex requests these non-null fields are absent from replayed output items.
    for item in &mut items {
        item["metadata"] = json!({"source": "fixture"});
        item["internal_chat_message_metadata_passthrough"] = json!({"turn_id": "fixture-turn"});
    }
    json!(items)
}

fn verify_two_websocket_turns(upstream: TcpListener, history: TurnHistory) -> usize {
    let mut socket = accept_official_socket(&upstream, "a@example.test");
    let (first, first_len) = receive_turn(&mut socket);
    assert_eq!(first["type"], "response.create");
    assert_eq!(first["input"], json!([history.user]));
    assert!(first.get("previous_response_id").is_none());
    finish_turn(&mut socket, "resp_1", wire_output(&history));
    let (second, second_len) = receive_turn(&mut socket);
    assert_eq!(second["previous_response_id"], "resp_1");
    assert_eq!(second["input"], json!([history.output]));
    for key in ["model", "instructions", "tools", "service_tier"] {
        assert_eq!(second[key], first[key]);
    }
    finish_turn(&mut socket, "resp_2", json!([]));
    first_len + second_len
}

fn http_baseline(bodies: [Value; 2], first_items: Value) -> (usize, String, String) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let fixture =
        OfficialResponsesFixture::new(&format!("http://{}", server.server_addr()), 2, false);
    let worker = thread::spawn(move || {
        let turns = [("resp_1", first_items), ("resp_2", json!([]))];
        turns
            .into_iter()
            .map(|(response_id, items)| http_reply(&server, response_id, items))
            .sum()
    });
    let [first, second] = bodies.map(|body| fixture.send(body));
    let bytes = worker.join().unwrap();
    fixture.join();
    (bytes, first, second)
}

fn http_reply(server: &Server, id: &str, items: Value) -> usize {
    let mut request = server.recv_timeout(TIMEOUT).unwrap().unwrap();
    assert_eq!(request.method(), &Method::Post);
    let mut body = Vec::new();
    request.as_reader().read_to_end(&mut body).unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert!(value.get("previous_response_id").is_none());
    let mut events = String::new();
    for value in turn_events(id, items) {
        let kind = value["type"].as_str().unwrap();
        events.push_str(&format!("event: {kind}\ndata: {value}\n\n"));
    }
    request
        .respond(
            Response::from_string(events)
                .with_header(Header::from_bytes("Content-Type", "text/event-stream").unwrap()),
        )
        .unwrap();
    body.len()
}

fn turn(input: Value) -> Value {
    json!({
        "model": "gpt-5.6-sol", "stream": true, "store": false, "input": input,
        "instructions": "Inspect the supplied context.", "service_tier": "priority",
        "tools": [{"type":"function", "name":"inspect", "parameters":{"type":"object"}}]
    })
}

type MockSocket = tungstenite::WebSocket<TcpStream>;

fn accept_official_socket(listener: &TcpListener, email: &str) -> MockSocket {
    let (stream, _) = listener.accept().unwrap();
    accept_socket_with_turn_state(stream, email, None)
}

fn accept_socket_with_turn_state(
    stream: TcpStream,
    email: &str,
    state: Option<&str>,
) -> MockSocket {
    stream.set_read_timeout(Some(TIMEOUT)).unwrap();
    stream.set_write_timeout(Some(TIMEOUT)).unwrap();
    let validate = |request: &tungstenite::handshake::server::Request,
                    mut response: tungstenite::handshake::server::Response| {
        assert_eq!(request.uri().path(), "/responses");
        assert_eq!(
            request.headers()["authorization"],
            format!("Bearer test-token-{email}")
        );
        assert_eq!(request.headers()["chatgpt-account-id"], "test-workspace");
        if let Some(state) = state {
            response
                .headers_mut()
                .insert("x-codex-turn-state", state.parse().unwrap());
        }
        Ok(response)
    };
    tungstenite::accept_hdr(stream, validate)
        .expect("official upstream must receive a WebSocket handshake")
}

fn receive_turn(socket: &mut MockSocket) -> (Value, usize) {
    let message = socket.read().unwrap();
    let raw = message.to_text().unwrap();
    (serde_json::from_str(raw).unwrap(), raw.len())
}

fn finish_turn(socket: &mut MockSocket, id: &str, output: Value) {
    for value in turn_events(id, output) {
        socket.send(Message::text(value.to_string())).unwrap();
    }
}

fn turn_events(id: &str, output: Value) -> Vec<Value> {
    let mut events = output.as_array().unwrap().iter().enumerate().map(|(index, item)| {
        json!({"type":"response.output_item.done", "output_index":index, "item":item})
    }).collect::<Vec<_>>();
    events.push(json!({"type": "response.completed", "response": {
        "id": id, "status": "completed", "output": output,
        "usage": {"input_tokens": 8, "output_tokens": 2, "total_tokens": 10}
    }}));
    events
}

struct OfficialResponsesFixture {
    base_url: String,
    worker: thread::JoinHandle<()>,
    app: tauri::App<tauri::test::MockRuntime>,
}

struct FixtureRoute {
    enabled: bool,
    origin: RequestOrigin,
}

impl OfficialResponsesFixture {
    fn new(upstream: &str, turns: usize, enabled: bool) -> Self {
        let app = gui_runtime_test_app();
        let paths = resolve_paths(app.handle()).unwrap();
        let account_id = create_account(&paths, "a@example.test");
        write_state(
            &paths,
            &ManagerStateFile {
                active_account_id: Some(account_id),
                ..Default::default()
            },
        )
        .unwrap();
        Self::start(
            app,
            upstream,
            turns,
            FixtureRoute {
                enabled,
                origin: RequestOrigin::External,
            },
        )
    }

    fn concurrent(upstream: &str, turns: usize) -> (Self, [String; 2]) {
        Self::concurrent_for(
            upstream,
            turns,
            ["a@example.test".into(), "b@example.test".into()],
        )
    }

    fn concurrent_for(upstream: &str, turns: usize, accounts: [String; 2]) -> (Self, [String; 2]) {
        let app = gui_runtime_test_app();
        let paths = resolve_paths(app.handle()).unwrap();
        let first = create_account(&paths, &accounts[0]);
        let second = create_account(&paths, &accounts[1]);
        for (index, id) in [&first, &second].into_iter().enumerate() {
            let usage = account_with_usage(id, if index == 0 { 70.0 } else { 80.0 }, 90.0).usage;
            crate::storage::save_usage(&usage_path(&paths, id), &usage).unwrap();
        }
        crate::storage::save_auto_switch_priority(&auto_switch_priority_path(&paths, &first), -1)
            .unwrap();
        write_state(
            &paths,
            &ManagerStateFile {
                active_account_id: Some(first),
                auto_switch_on_quota_exhaustion: true,
                concurrent_account_routing_enabled: true,
                custom_auto_switch_priority_enabled: true,
                ..Default::default()
            },
        )
        .unwrap();
        (
            Self::start(
                app,
                upstream,
                turns,
                FixtureRoute {
                    enabled: true,
                    origin: RequestOrigin::External,
                },
            ),
            accounts,
        )
    }

    fn gui(upstream: &str, turns: usize) -> Self {
        let app = gui_runtime_test_app();
        app.manage(crate::codex_gui::GuiState::default());
        app.manage(crate::codex_gui::web::WebEventState::default());
        let paths = resolve_paths(app.handle()).unwrap();
        let account = create_account(&paths, "a@example.test");
        crate::storage::write_json_atomic(
            &app.path()
                .app_data_dir()
                .unwrap()
                .join("codex-gui-account.json"),
            &json!({"kind":"account","id":account}),
        )
        .unwrap();
        Self::start(
            app,
            upstream,
            turns,
            FixtureRoute {
                enabled: true,
                origin: RequestOrigin::Gui,
            },
        )
    }

    fn start(
        app: tauri::App<tauri::test::MockRuntime>,
        upstream: &str,
        turns: usize,
        route: FixtureRoute,
    ) -> Self {
        let FixtureRoute { enabled, origin } = route;
        crate::storage::write_json_atomic(
            &crate::storage::app_settings_path(app.handle()).unwrap(),
            &json!({"officialCodexWebsocketEnabled": enabled}),
        )
        .unwrap();
        let server = Server::http("127.0.0.1:0").unwrap();
        let prefix = if matches!(origin, RequestOrigin::Gui) {
            "/codex-gui"
        } else {
            ""
        };
        let base_url = format!("http://{}{prefix}", server.server_addr());
        let handle = app.handle().clone();
        let upstream = upstream.to_owned();
        let worker = thread::spawn(move || {
            thread::scope(|scope| {
                for _ in 0..turns {
                    let request = server.recv_timeout(TIMEOUT).unwrap().unwrap();
                    let app = handle.clone();
                    let upstream = upstream.as_str();
                    scope.spawn(move || {
                        let _upstream = AggregateOfficialUpstream::set(upstream);
                        serve_request(app, request, origin);
                    });
                }
            });
        });
        Self {
            base_url,
            worker,
            app,
        }
    }

    fn send(&self, body: Value) -> String {
        let response = self
            .request("websocket-conversation", "responses", body)
            .send()
            .unwrap();
        let status = response.status();
        let text = response.text().unwrap();
        assert_eq!(status.as_u16(), 200, "{text}");
        text
    }

    fn request(&self, session: &str, endpoint: &str, body: Value) -> RequestBuilder {
        gui_runtime_client()
            .post(format!("{}/v1/{endpoint}", self.base_url))
            .bearer_auth(crate::codex_config::LOCAL_PROXY_TOKEN)
            .header("thread-id", session)
            .header("x-codex-routing-hint", "fixture-original-route")
            .json(&body)
    }

    fn join(self) {
        self.worker.join().unwrap();
    }
}

fn create_account(paths: &Paths, email: &str) -> String {
    let member = aggregate_official_account(paths, email);
    aggregate_api::member_account_id(&member).unwrap().into()
}
