use super::*;
use crate::{
    api::Services,
    database::Database,
    embedding::Embedder,
    error::Result,
    model::{ResourceInput, ResourceKind},
    proxy::ModelProxy,
    resources,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub(super) struct NoEmbedding;
impl Embedder for NoEmbedding {
    fn encode(&self, _text: &str, _query: bool) -> Result<Vec<f32>> {
        unreachable!()
    }
    fn model_id(&self) -> &str {
        "test"
    }
}

fn agent(db: &Database, tools: &[String]) -> String {
    resources::save(
        db,
        ResourceInput {
            id: None,
            kind: ResourceKind::Agent,
            name: "Helper".into(),
            description: String::new(),
            draft: json!({"model":"test","toolIds":tools}),
            revision: None,
        },
    )
    .unwrap()
    .id
}

fn sse(content: Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(format!("data: {content}\n\ndata: [DONE]\n\n"))
        .with_header(tiny_http::Header::from_bytes("Content-Type", "text/event-stream").unwrap())
}

#[test]
fn bounded_tool_planning_preserves_calls_and_results_in_later_turns() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    initialize(&db.connect().unwrap()).unwrap();
    let table = resources::save(
        &db,
        ResourceInput {
            id: None,
            kind: ResourceKind::Table,
            name: "People".into(),
            description: String::new(),
            draft: json!({}),
            revision: None,
        },
    )
    .unwrap();
    resources::publish(&db, &table.id, table.revision, true).unwrap();
    crate::tables::write(&db, &table.id, None, json!({"name":"Ada"})).unwrap();
    let id = agent(&db, std::slice::from_ref(&table.id));
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let base = format!("http://{}/v1", server.server_addr());
    let tool_name = format!("coze_{}", table.id.replace('-', ""));
    let worker = std::thread::spawn(move || {
        for index in 0..3 {
            let mut request = server.recv().unwrap();
            let body: Value = serde_json::from_reader(request.as_reader()).unwrap();
            captured.lock().unwrap().push(body);
            let delta = if index == 0 {
                json!({"tool_calls":[{"index":0,"id":"call_1", "type":"function",
                "function":{"name":tool_name,"arguments":"{\"filter\":{}}"}}]})
            } else {
                json!({"content":"Ada is present"})
            };
            request
                .respond(sse(json!({"choices":[{"delta":delta,"finish_reason":
                if index == 0 {"tool_calls"} else {"stop"}}]})))
                .unwrap();
        }
    });
    let services = Services::new(
        db,
        Arc::new(NoEmbedding),
        ModelProxy::new(&base, "local".into()).unwrap(),
    );
    let result = chat(
        &services,
        ChatRequest {
            agent_id: id.clone(),
            conversation_id: None,
            message: "Find Ada".into(),
            published: false,
        },
    )
    .unwrap();
    let conversation = result["conversationId"].as_str().unwrap().to_owned();
    chat(
        &services,
        ChatRequest {
            agent_id: id,
            conversation_id: Some(conversation),
            message: "What did you find?".into(),
            published: false,
        },
    )
    .unwrap();
    worker.join().unwrap();
    let requests = requests.lock().unwrap();
    assert_eq!(requests[0]["stream"], true);
    let last = requests[2]["messages"].as_array().unwrap();
    assert!(last
        .iter()
        .any(|message| message["tool_calls"][0]["id"] == "call_1"));
    assert!(last
        .iter()
        .any(|message| message["tool_call_id"] == "call_1"
            && message["content"].as_str().unwrap().contains("Ada")));
}

#[test]
fn unknown_tools_are_rejected_without_resource_access() {
    assert!(validate(&json!({"model":"test","maxSteps":0})).is_err());
    assert!(validate(&json!({"model":"test","toolIds":[],
        "writableTableIds":[uuid::Uuid::new_v4().to_string()]}))
    .is_err());
}
