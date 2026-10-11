use super::*;
use crate::{
    api::Services,
    database::Database,
    embedding::Embedder,
    error::{Error, Result},
    mcp,
    model::{ResourceInput, ResourceKind},
    proxy::ModelProxy,
    resources,
};
use serde_json::{json, Value};
use std::sync::Arc;

struct NoEmbedding;
impl Embedder for NoEmbedding {
    fn encode(&self, _text: &str, _query: bool) -> Result<Vec<f32>> {
        Err(Error::Embedding)
    }
    fn model_id(&self) -> &str {
        "none"
    }
}

pub(super) fn fixture() -> (tempfile::TempDir, Services) {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let services = Services::new(
        db,
        Arc::new(NoEmbedding),
        ModelProxy::new("http://127.0.0.1:1/v1", "fixture".into()).unwrap(),
    );
    (directory, services)
}

fn graph() -> Value {
    json!({"nodes":[
        {"id":"start","name":"开始","type":"start"},
        {"id":"text","name":"格式化","type":"template","template":"你好，{{input.name}}"},
        {"id":"end","name":"完成","type":"end","value":"{{text.output}}"}],
        "edges":[{"source":"start","target":"text"},{"source":"text","target":"end"}]})
}

fn save(services: &Services) -> crate::model::Resource {
    resources::save(
        &services.db,
        ResourceInput {
            id: None,
            kind: ResourceKind::Workflow,
            name: "欢迎".into(),
            description: "向用户问好".into(),
            draft: graph(),
            revision: None,
        },
    )
    .unwrap()
}

#[test]
fn typed_bindings_keep_objects_and_missing_values_fail() {
    let context = json!({"input":{"name":"世界","data":{"number":1}}});
    assert_eq!(
        super::bindings::resolve(&json!("{{input.data}}"), &context).unwrap(),
        json!({"number":1})
    );
    assert!(super::bindings::render("{{missing.output}}", &context).is_err());
}

#[test]
fn publication_is_immutable_and_mcp_rejects_disabled_resources() {
    let (_directory, services) = fixture();
    let draft = save(&services);
    resources::publish(&services.db, &draft.id, 1, true).unwrap();
    let mut changed = graph();
    changed["nodes"][1]["template"] = json!("changed {{input.name}}");
    resources::save(
        &services.db,
        ResourceInput {
            id: Some(draft.id.clone()),
            kind: draft.kind,
            name: draft.name,
            description: draft.description,
            draft: changed,
            revision: Some(1),
        },
    )
    .unwrap();
    let request = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
        "name":"coze_call","arguments":{"resource_id":draft.id,"input":{"name":"世界"}}}});
    let result = mcp::dispatch(&services, &request).unwrap();
    let text: Value =
        serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text["output"], "你好，世界");
    resources::publish(&services.db, &draft.id, 2, false).unwrap();
    assert_eq!(
        resources::get(&services.db, &draft.id)
            .unwrap()
            .published_revision,
        Some(1)
    );
    assert_eq!(
        mcp::dispatch(&services, &request).unwrap()["result"]["isError"],
        true
    );
}

#[test]
fn cycles_missing_endpoints_and_stale_revisions_are_rejected() {
    let (_directory, services) = fixture();
    let mut cyclic = graph();
    cyclic["edges"]
        .as_array_mut()
        .unwrap()
        .push(json!({"source":"text","target":"text"}));
    assert!(validate_value(&cyclic).is_err());
    let mut missing = graph();
    missing["edges"][0]["target"] = json!("missing");
    assert!(validate_value(&missing).is_err());
    let draft = save(&services);
    assert!(matches!(
        resources::delete(&services.db, &draft.id, 2),
        Err(Error::Conflict)
    ));
}

#[test]
fn branches_skip_unselected_effects_and_record_failed_node() {
    let (_directory, services) = fixture();
    let graph: Graph = serde_json::from_value(json!({"nodes":[
        {"id":"start","name":"开始","type":"start"},
        {"id":"if","name":"判断","type":"condition","left":"{{input.name}}","right":"世界"},
        {"id":"good","name":"正确","type":"end","value":"matched"},
        {"id":"bad","name":"错误","type":"llm","model":"test","prompt":"unreachable"},
        {"id":"end","name":"完成","type":"end","value":"{{bad.output}}"}],
        "edges":[{"source":"start","target":"if"},{"source":"if","target":"good","port":true},
            {"source":"if","target":"bad","port":false},{"source":"bad","target":"end"}]}))
    .unwrap();
    let mut trace = Vec::new();
    let result = execute(
        &RuntimeContext::new(&services, false),
        &graph,
        json!({"name":"世界"}),
        &mut trace,
    )
    .unwrap();
    assert_eq!(result, "matched");
    assert_eq!(trace.len(), 3);
    let resource = save(&services);
    let result = run(
        &services,
        RunRequest {
            resource_id: resource.id.clone(),
            input: json!({}),
            published: false,
        },
    )
    .unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["trace"][1]["status"], "failed");
    assert_eq!(
        list_runs(&services.db, &resource.id).unwrap()[0]["status"],
        "failed"
    );
}
