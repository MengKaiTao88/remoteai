use super::{tests::NoEmbedding, *};
use crate::{
    api::Services,
    database::Database,
    jobs::JobControl,
    model::{ResourceInput, ResourceKind},
    proxy::{ModelProxy, ToolCall},
    resources,
};
use serde_json::json;
use std::sync::Arc;

fn services(db: Database, base: &str) -> Services {
    Services::new(
        db,
        Arc::new(NoEmbedding),
        ModelProxy::new(base, "local".into()).unwrap(),
    )
}

#[test]
fn table_mutation_requires_explicit_agent_permission() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let table = resources::save(
        &db,
        ResourceInput {
            id: None,
            kind: ResourceKind::Table,
            name: "Inventory".into(),
            description: String::new(),
            draft: json!({}),
            revision: None,
        },
    )
    .unwrap();
    resources::publish(&db, &table.id, table.revision, true).unwrap();
    let service = services(db, "http://127.0.0.1:1/v1");
    let mut agent: Agent =
        serde_json::from_value(json!({"model":"test","toolIds":[table.id]})).unwrap();
    let name = format!("coze_{}_write", table.id.replace('-', ""));
    let call: ToolCall = serde_json::from_value(json!({"id":"write_one","type":"function",
        "function":{"name":name,"arguments":"{\"value\":{\"name\":\"New item\"}}"}}))
    .unwrap();
    let selected = tools::prepare(&service, &agent).unwrap();
    assert_eq!(selected.len(), 1);
    assert!(tools::invoke(&service, &selected, &call, &JobControl::detached()).is_err());
    assert_eq!(
        crate::tables::query(&service.db, &table.id, &json!({})).unwrap(),
        json!([])
    );
    agent.writable_table_ids.push(table.id.clone());
    let selected = tools::prepare(&service, &agent).unwrap();
    assert_eq!(selected.len(), 3);
    tools::invoke(&service, &selected, &call, &JobControl::detached()).unwrap();
    assert_eq!(
        crate::tables::query(&service.db, &table.id, &json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn unknown_tool_error_is_returned_to_model_and_final_round_disables_tools() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let resource = resources::save(
        &db,
        ResourceInput {
            id: None,
            kind: ResourceKind::Agent,
            name: "Helper".into(),
            description: String::new(),
            draft: json!({"model":"test","maxSteps":1}),
            revision: None,
        },
    )
    .unwrap();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", server.server_addr());
    let worker = std::thread::spawn(move || {
        let mut first = server.recv().unwrap();
        let _: Value = serde_json::from_reader(first.as_reader()).unwrap();
        let tool = json!({"choices":[{"message":{"content":null,"tool_calls":[{"id":"unknown",
            "type":"function","function":{"name":"not_authorized","arguments":"{}"}}]}}]});
        first
            .respond(
                tiny_http::Response::from_string(tool.to_string()).with_header(
                    tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
                ),
            )
            .unwrap();
        let mut second = server.recv().unwrap();
        let body: Value = serde_json::from_reader(second.as_reader()).unwrap();
        let output = json!({"choices":[{"message":{"content":"I cannot use that tool."}}]});
        second
            .respond(
                tiny_http::Response::from_string(output.to_string()).with_header(
                    tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
                ),
            )
            .unwrap();
        body
    });
    let service = services(db, &base);
    let response = chat(
        &service,
        ChatRequest {
            agent_id: resource.id,
            conversation_id: None,
            message: "Try a tool".into(),
            published: false,
        },
    )
    .unwrap();
    assert_eq!(response["message"]["content"], "I cannot use that tool.");
    let second = worker.join().unwrap();
    assert!(second.get("tools").is_none());
    let output = second["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap();
    let feedback: Value = serde_json::from_str(output["content"].as_str().unwrap()).unwrap();
    assert!(feedback["error"].is_string());
}
