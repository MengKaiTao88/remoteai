use super::*;

const CONTINUATIONS: usize = 24;
const PRIOR_ITEMS: usize = 710;
const SAMPLE_CHUNK_BYTES: usize = 3400;
const TURN_METADATA: &str = "x-codex-turn-metadata";

#[derive(Clone)]
struct HistoryStep {
    upstream: Value,
    replayed: Vec<Value>,
    next: Value,
    starts_user_turn: bool,
}

#[test]
fn long_responses_history_uses_one_full_request_and_keeps_sending_deltas() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let steps = (0..CONTINUATIONS).map(history_step).collect::<Vec<_>>();
    let websocket = websocket_upload(&steps);
    let http = http_upload(&steps);
    eprintln!(
        "{} successful requests: HTTP={http} bytes, WebSocket={websocket} bytes (1 full, {CONTINUATIONS} delta)",
        CONTINUATIONS + 1,
    );
    assert!(websocket < http / 10, "{websocket} vs {http}");
}

fn websocket_upload(steps: &[HistoryStep]) -> usize {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, steps.len() + 1, true);
    let upstream_steps = steps.to_vec();
    let worker = thread::spawn(move || receive_websocket_sequence(&listener, &upstream_steps));
    send_sequence(&fixture, steps);
    fixture.join();
    worker.join().unwrap()
}

fn receive_websocket_sequence(listener: &TcpListener, steps: &[HistoryStep]) -> usize {
    let mut socket = accept_official_socket(listener, "a@example.test");
    let (first, mut bytes) = receive_turn(&mut socket);
    assert!(first.get("previous_response_id").is_none());
    assert_eq!(first["input"].as_array().unwrap().len(), PRIOR_ITEMS);
    finish_turn(&mut socket, &response_id(0), response_output(steps, 0));
    for (index, step) in steps.iter().enumerate() {
        let (delta, count) = receive_turn(&mut socket);
        assert_eq!(delta["previous_response_id"], response_id(index));
        assert_eq!(delta["input"], json!([step.next]));
        assert!(delta["client_metadata"][TURN_METADATA].is_string());
        finish_turn(
            &mut socket,
            &response_id(index + 1),
            response_output(steps, index + 1),
        );
        bytes += count;
    }
    bytes
}

fn http_upload(steps: &[HistoryStep]) -> usize {
    let server = Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}", server.server_addr());
    let fixture = OfficialResponsesFixture::new(&url, steps.len() + 1, false);
    thread::scope(|scope| {
        let upstream = scope.spawn(move || {
            (0..=steps.len())
                .map(|index| {
                    http_reply(&server, &response_id(index), response_output(steps, index))
                })
                .sum()
        });
        send_sequence(&fixture, steps);
        fixture.join();
        upstream.join().unwrap()
    })
}

fn send_sequence(fixture: &OfficialResponsesFixture, steps: &[HistoryStep]) {
    let mut history = (0..PRIOR_ITEMS)
        .map(|index| {
            message(
                "user",
                "input_text",
                format!("{index} {}", "x".repeat(SAMPLE_CHUNK_BYTES)),
            )
        })
        .collect::<Vec<_>>();
    let mut user_turn = 0;
    for index in 0..=steps.len() {
        if let Some(step) = index.checked_sub(1).and_then(|index| steps.get(index)) {
            history.extend(step.replayed.iter().cloned());
            history.push(step.next.clone());
            user_turn += usize::from(step.starts_user_turn);
        }
        let body = turn(json!(history));
        let response = fixture
            .request("long-conversation", "responses", body)
            .header(
                TURN_METADATA,
                json!({"turn_id":format!("user-turn-{user_turn}")}).to_string(),
            )
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .unwrap();
        assert_eq!(
            sse_event(&response, "response.completed")["response"]["id"],
            response_id(index)
        );
    }
}

fn response_id(index: usize) -> String {
    format!("resp_long_{index}")
}

fn response_output(steps: &[HistoryStep], index: usize) -> Value {
    steps
        .get(index)
        .map_or_else(|| json!([]), |step| step.upstream.clone())
}

fn history_step(index: usize) -> HistoryStep {
    let kind = index % 6;
    if kind == 5 {
        let mut answer = message("assistant", "output_text", format!("Result {index}"));
        answer["phase"] = "final_answer".into();
        return step(
            vec![answer],
            message("user", "input_text", format!("Continue with step {index}")),
            true,
        );
    }
    let mut items = Vec::new();
    if matches!(kind, 1..=4) {
        items.push(reasoning(index));
    }
    if kind == 3 {
        let mut commentary = message("assistant", "output_text", "Reading the sample".into());
        commentary["phase"] = "commentary".into();
        items.push(commentary);
    }
    let (call, result) = tool_step(index, kind < 2);
    items.push(call);
    let mut turn = step(items, result, false);
    match kind {
        1 | 3 | 4 => turn.upstream[0]["content"] = json!([]),
        2 => {
            turn.upstream[0]["content"] =
                json!([{"type":"reasoning_text","text":"Private fixture text."}])
        }
        _ => {}
    }
    if kind == 4 {
        turn.replayed[0]["content"] = json!([]);
    }
    turn
}

fn step(replayed: Vec<Value>, next: Value, starts_user_turn: bool) -> HistoryStep {
    let upstream = replayed
        .iter()
        .cloned()
        .map(|mut item| {
            item["metadata"] = json!({"source":"upstream"});
            item["internal_chat_message_metadata_passthrough"] = json!({"turn_id":"upstream"});
            item
        })
        .collect::<Vec<_>>();
    HistoryStep {
        upstream: json!(upstream),
        replayed,
        next,
        starts_user_turn,
    }
}

fn reasoning(index: usize) -> Value {
    json!({
        "type":"reasoning","id":format!("rs_fixture_{index}"),
        "summary":[{"type":"summary_text","text":format!("Read sample {index}")}],
        "encrypted_content":format!("opaque-sample-{index}")
    })
}

fn tool_step(index: usize, custom: bool) -> (Value, Value) {
    let call_id = format!("call-{index}");
    if custom {
        return (
            json!({"type":"custom_tool_call","id":format!("ctc_fixture_{index}"),"status":"completed","call_id":call_id,
                "name":"inspect","input":"read"}),
            json!({"type":"custom_tool_call_output","call_id":call_id,"output":"Sample read"}),
        );
    }
    (
        json!({"type":"function_call","id":format!("fc_fixture_{index}"),"status":"completed","call_id":call_id,
            "name":"inspect","arguments":"{}"}),
        json!({"type":"function_call_output","call_id":call_id,"output":"Sample read"}),
    )
}

fn message(role: &str, kind: &str, text: String) -> Value {
    json!({"type":"message","role":role,"content":[{"type":kind,"text":text}]})
}
