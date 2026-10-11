use super::*;
use crate::{jobs::JobControl, proxy::ModelProxy};

#[test]
fn history_preserves_images_calls_outputs_and_system_instructions() {
    let messages = [
        json!({"role":"system","content":"Use the documents"}),
        json!({"role":"user","content":[{"type":"text","text":"Read"},
            {"type":"image_url","image_url":{"url":"data:image/png;base64,YQ=="}}]}),
        json!({"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function",
            "function":{"name":"lookup","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"call_1","content":"found"}),
    ];
    let tools =
        [json!({"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}})];
    let body = request_body(&CompletionRequest {
        model: "gpt-6-astra",
        messages: &messages,
        temperature: 0.7,
        tools: &tools,
    })
    .unwrap();
    assert_eq!(body["instructions"], "Use the documents");
    assert_eq!(body["store"], false);
    assert!(body.get("temperature").is_none());
    assert_eq!(body["input"][0]["content"][1]["type"], "input_image");
    assert_eq!(body["input"][1]["call_id"], "call_1");
    assert_eq!(body["input"][2]["type"], "function_call_output");
    assert_eq!(body["tools"][0]["name"], "lookup");
    assert_eq!(body["tools"][0]["strict"], false);
}

#[test]
fn native_gui_retains_streamed_tools_when_completed_output_is_empty() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}/codex-gui/v1", server.server_addr());
    let worker = std::thread::spawn(move || {
        let mut request = server.recv().unwrap();
        assert_eq!(request.url(), "/codex-gui/v1/responses");
        let body: Value = serde_json::from_reader(request.as_reader()).unwrap();
        assert_eq!(body["input"][0]["content"], "Find it");
        assert_eq!(body["stream"], true);
        let item = json!({"type":"function_call","call_id":"c1","name":"lookup","arguments":""});
        let events = [
            json!({"type":"response.output_text.delta","delta":"找到"}),
            json!({"type":"response.output_item.added","output_index":1,"item":item}),
            json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"{"}),
            json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"}"}),
            json!({"type":"response.function_call_arguments.done","output_index":1,"arguments":"{}"}),
            json!({"type":"response.output_item.done","output_index":1,"item":{
                "type":"function_call","call_id":"c1","name":"lookup","arguments":"{}"}}),
            json!({"type":"response.completed","response":{"status":"completed","output":[]}}),
        ].iter().map(|event| format!("data: {event}\n\n")).collect::<String>();
        request
            .respond(tiny_http::Response::from_string(events).with_header(
                tiny_http::Header::from_bytes("Content-Type", "text/event-stream").unwrap(),
            ))
            .unwrap();
    });
    let proxy = ModelProxy::new(&base, "local".into()).unwrap();
    let completion = proxy
        .complete(
            CompletionRequest {
                model: "gpt-6-astra",
                temperature: 0.7,
                messages: &[json!({"role":"user","content":"Find it"})],
                tools: &[],
            },
            &JobControl::detached(),
        )
        .unwrap();
    assert_eq!(completion.content, "找到");
    assert_eq!(completion.tool_calls[0].id, "c1");
    assert_eq!(completion.tool_calls[0].function.arguments, "{}");
    worker.join().unwrap();
}

#[test]
fn failed_incomplete_and_invalid_tool_results_are_rejected() {
    for status in ["failed", "incomplete", "in_progress"] {
        assert!(completion(&json!({"status":status,"output":[]})).is_err());
    }
    assert!(completion(
        &json!({"status":"completed","output":[{"type":"function_call",
        "call_id":"","name":"lookup","arguments":"{}"}]})
    )
    .is_err());
}
