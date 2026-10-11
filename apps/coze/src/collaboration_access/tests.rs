use super::*;
use crate::{
    api::{Command, Services},
    database::Database,
    embedding::Embedder,
    error::Result,
    model::ResourceInput,
    proxy::ModelProxy,
};
use std::sync::Arc;

struct NoEmbedding;
impl Embedder for NoEmbedding {
    fn encode(&self, _text: &str, _query: bool) -> Result<Vec<f32>> {
        unreachable!()
    }
    fn model_id(&self) -> &str {
        "test"
    }
}

fn create(db: &Database, kind: ResourceKind, body: Value) -> String {
    let value = resources::save(
        db,
        ResourceInput {
            id: None,
            kind,
            name: "Shared".into(),
            description: String::new(),
            draft: body,
            revision: None,
        },
    )
    .unwrap();
    resources::publish(db, &value.id, value.revision, true).unwrap();
    value.id
}

fn setup() -> (tempfile::TempDir, Services, String, String, String) {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    initialize(&db.connect().unwrap()).unwrap();
    let agent = create(
        &db,
        ResourceKind::Agent,
        json!({"model":"test","prompt":"public"}),
    );
    let other = create(
        &db,
        ResourceKind::Agent,
        json!({"model":"test","prompt":"private"}),
    );
    let app = create(
        &db,
        ResourceKind::App,
        json!({"entryId":agent,"resourceIds":[agent]}),
    );
    let services = Services::new(
        db,
        Arc::new(NoEmbedding),
        ModelProxy::new("http://127.0.0.1:1/v1", "test".into()).unwrap(),
    );
    (directory, services, app, agent, other)
}

fn share(services: &Services, app: &str, role: Role) -> (Services, Value) {
    let response = issue(
        &services.db,
        AccessIssue {
            app_id: app.into(),
            name: "Visitor".into(),
            role,
            expires_days: 30,
        },
    )
    .unwrap();
    let principal = authenticate(&services.db, response["token"].as_str().unwrap()).unwrap();
    (scoped(services, principal), response)
}

#[test]
fn viewer_sees_only_released_app_resources_and_cannot_run_or_publish() {
    let (_directory, owner, app, agent, other) = setup();
    resources::save(
        &owner.db,
        ResourceInput {
            id: Some(agent.clone()),
            kind: ResourceKind::Agent,
            name: "Shared".into(),
            description: String::new(),
            draft: json!({"model":"test","prompt":"unpublished secret"}),
            revision: Some(1),
        },
    )
    .unwrap();
    let (viewer, _) = share(&owner, &app, Role::Viewer);
    let permit = authorize(&viewer, &Command::ListResources).unwrap();
    let value = permit
        .finish(&viewer, json!(resources::list(&viewer.db).unwrap()))
        .unwrap();
    assert_eq!(value.as_array().unwrap().len(), 2);
    let shared = value
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == agent)
        .unwrap();
    assert_eq!(shared["draft"]["prompt"], "public");
    assert_eq!(shared["revision"], 1);
    assert!(authorize(&viewer, &Command::GetResource { id: other }).is_err());
    assert!(authorize(
        &viewer,
        &Command::Publish {
            id: agent.clone(),
            revision: 2,
            enabled: true
        }
    )
    .is_err());
    assert!(authorize(
        &viewer,
        &Command::Chat(crate::agents::ChatRequest {
            agent_id: agent,
            conversation_id: None,
            message: "hello".into(),
            published: true
        })
    )
    .is_err());
}

#[test]
fn editor_cannot_expand_membership_or_reference_another_application() {
    let (_directory, owner, app, agent, other) = setup();
    let (editor, _) = share(&owner, &app, Role::Editor);
    let command = |id, kind, body| {
        Command::SaveResource(ResourceInput {
            id: Some(id),
            kind,
            name: "Edit".into(),
            description: String::new(),
            draft: body,
            revision: Some(1),
        })
    };
    assert!(authorize(
        &editor,
        &command(
            agent,
            ResourceKind::Agent,
            json!({"model":"test","toolIds":[other]})
        )
    )
    .is_err());
    assert!(authorize(
        &editor,
        &command(
            app,
            ResourceKind::App,
            json!({"entryId":other,"resourceIds":[other]})
        )
    )
    .is_err());
}

#[test]
fn executions_are_private_to_each_grant_and_revocation_cancels_future_access() {
    let (_directory, owner, app, _agent, _other) = setup();
    let (runner, issued) = share(&owner, &app, Role::Runner);
    let (second, _) = share(&owner, &app, Role::Runner);
    let id = uuid::Uuid::new_v4().to_string();
    register_execution(&runner, "job", &id).unwrap();
    assert!(authorize(
        &runner,
        &Command::JobStatus {
            id: id.clone(),
            after: 0
        }
    )
    .is_ok());
    assert!(authorize(&second, &Command::JobStatus { id, after: 0 }).is_err());
    let listing = list(&owner.db, &app).unwrap().to_string();
    assert!(!listing.contains(issued["token"].as_str().unwrap()));
    revoke(&owner, issued["id"].as_str().unwrap()).unwrap();
    assert!(authenticate(&owner.db, issued["token"].as_str().unwrap()).is_err());
    assert!(authorize(&runner, &Command::ListResources).is_err());
}

#[test]
fn mcp_listing_and_resource_calls_obey_the_same_scope() {
    let (_directory, owner, app, agent, other) = setup();
    let (runner, _) = share(&owner, &app, Role::Runner);
    let list = json!({"method":"tools/call","params":{"name":"coze_list"}});
    let permit = authorize_mcp(&runner, &list).unwrap();
    let body = json!([{ "id":agent },{ "id":other }]).to_string();
    let filtered = permit
        .finish_mcp(
            &runner,
            json!({"result":{"content":[{"type":"text","text":body}]}}),
        )
        .unwrap();
    assert!(!filtered.to_string().contains(&other));
    let call = json!({"method":"tools/call","params":{"name":"coze_call","arguments":{"resource_id":other}}});
    assert!(authorize_mcp(&runner, &call).is_err());
    let foreign = create(
        &owner.db,
        ResourceKind::Workflow,
        json!({"nodes":[
        {"id":"start","name":"start","type":"start"},
        {"id":"end","name":"end","type":"end","value":"private"}],
        "edges":[{"source":"start","target":"end"}]}),
    );
    let response = crate::mcp::dispatch(
        &runner,
        &json!({"id":1,"method":"tools/call",
        "params":{"name":"coze_list","arguments":{}}}),
    )
    .unwrap();
    assert!(response.get("error").is_none(), "{response}");
    assert_ne!(response["result"]["isError"], true, "{response}");
    assert!(!response.to_string().contains(&foreign));
}
