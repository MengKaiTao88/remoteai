use super::*;

#[test]
fn official_responses_continues_after_codex_replays_a_custom_tool_call() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", upstream.local_addr().unwrap());
    let fixture = OfficialResponsesFixture::new(&url, 2, true);
    let user = json!({
        "type":"message", "role":"user",
        "content":[{"type":"input_text","text":"Read the sample"}]
    });
    let call = json!({
        "type": "custom_tool_call", "id": "ctc_fixture", "status": "completed",
        "call_id": "call_fixture", "name": "inspect", "input": "sample"
    });
    let output = json!({
        "type": "custom_tool_call_output", "call_id": "call_fixture", "output": "done"
    });
    let first = turn(json!([user]));
    let second = turn(json!([user, call, output]));
    let worker = thread::spawn(move || {
        let mut socket = accept_official_socket(&upstream, "a@example.test");
        let _ = receive_turn(&mut socket);
        let mut annotated = call;
        annotated["internal_chat_message_metadata_passthrough"] = json!({"fixture": true});
        finish_turn(&mut socket, "resp_custom_tool", json!([annotated]));

        let frame = match socket.read() {
            Ok(frame) => frame,
            Err(_) => {
                socket = accept_official_socket(&upstream, "a@example.test");
                socket.read().unwrap()
            }
        };
        let next: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
        finish_turn(&mut socket, "resp_after_tool", json!([]));
        next
    });
    fixture.send(first);
    let response = fixture.send(second);
    assert_eq!(
        sse_event(&response, "response.completed")["response"]["id"],
        "resp_after_tool"
    );
    let next = worker.join().unwrap();
    fixture.join();
    assert_eq!(next["previous_response_id"], "resp_custom_tool");
    assert_eq!(next["input"], json!([output]));
}
