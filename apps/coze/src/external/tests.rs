use super::*;
use crate::{
    collaboration_access::{self as access, AccessIssue, Role},
    database::Database,
    embedding::Embedder,
    model::{ResourceInput, ResourceKind},
    proxy::ModelProxy,
    resources,
};
use reqwest::blocking::{Client, RequestBuilder};
use serde_json::{json, Value};

struct NoEmbedding;
impl Embedder for NoEmbedding {
    fn encode(&self, _: &str, _: bool) -> Result<Vec<f32>> {
        unreachable!()
    }
    fn model_id(&self) -> &str {
        "test"
    }
}

struct Fixture {
    services: Services,
    url: String,
    id: String,
    token: String,
    grant: String,
    client: Client,
    _directory: tempfile::TempDir,
}

impl Fixture {
    fn new(mode: Mode) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        let resource = resources::save(
            &db,
            ResourceInput {
                id: None,
                kind: ResourceKind::Prompt,
                name: "External prompt".into(),
                description: String::new(),
                draft: json!({"text":"Hello {{input.name}}"}),
                revision: None,
            },
        )
        .unwrap();
        resources::publish(&db, &resource.id, resource.revision, true).unwrap();
        let services = Services::new(
            db,
            Arc::new(NoEmbedding),
            ModelProxy::new("http://127.0.0.1:1/v1", "test".into()).unwrap(),
        );
        let issued = access::issue(
            &services.db,
            AccessIssue {
                app_id: resource.id.clone(),
                name: "Test client".into(),
                role: Role::Tool,
                expires_days: 30,
            },
        )
        .unwrap();
        let status = services
            .external
            .configure(
                &services,
                Settings {
                    enabled: true,
                    mode,
                    port: 0,
                },
            )
            .unwrap();
        Self {
            services,
            url: status.urls[0].clone(),
            id: resource.id,
            token: issued["token"].as_str().unwrap().into(),
            grant: issued["id"].as_str().unwrap().into(),
            client: Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap(),
            _directory: directory,
        }
    }
    fn post(&self, path: &str, body: Value) -> RequestBuilder {
        self.client
            .post(format!("{}{path}", self.url))
            .bearer_auth(&self.token)
            .json(&body)
    }
    fn rpc(&self, method: &str, params: Value) -> Value {
        self.post(
            "/mcp",
            json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}),
        )
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let settings = self.services.external.status().unwrap().settings;
        self.services
            .external
            .configure(
                &self.services,
                Settings {
                    enabled: false,
                    ..settings
                },
            )
            .unwrap();
    }
}

#[test]
fn mcp_negotiates_lists_and_calls_published_resource_over_http() {
    let f = Fixture::new(Mode::Local);
    for version in ["2025-03-26", "2025-06-18", "2025-11-25"] {
        let init = f.rpc("initialize", json!({"protocolVersion":version}));
        assert_eq!(init["result"]["protocolVersion"], version);
    }
    let response = f
        .post(
            "/mcp",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .send()
        .unwrap();
    assert_eq!(response.status(), 202);
    assert!(response.text().unwrap().is_empty());
    assert_eq!(
        f.rpc("tools/list", json!({}))["result"]["tools"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let result = f.rpc("tools/call", json!({"name":"coze_list","arguments":{}}));
    let entries: Value =
        serde_json::from_str(result["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(entries.as_array().unwrap().len(), 1);
    assert_eq!(entries[0]["id"], f.id);
    let result = f.rpc(
        "tools/call",
        json!({"name":"coze_call","arguments":{
        "resource_id":f.id,"input":{"name":"MCP"}}}),
    );
    assert_eq!(
        result["result"]["content"][0]["text"],
        "{\"text\":\"Hello MCP\"}"
    );
}

#[test]
fn api_uses_released_version_and_rejects_other_resources_and_editor_commands() {
    let f = Fixture::new(Mode::Network);
    resources::save(
        &f.services.db,
        ResourceInput {
            id: Some(f.id.clone()),
            kind: ResourceKind::Prompt,
            name: "External prompt".into(),
            description: String::new(),
            draft: json!({"text":"draft secret"}),
            revision: Some(1),
        },
    )
    .unwrap();
    let response: Value = f
        .post("/api/run", json!({"input":{"name":"API"}}))
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(response["text"], "Hello API");
    assert_eq!(
        f.post(
            "/api/run",
            json!({"resource_id":uuid::Uuid::new_v4().to_string()})
        )
        .send()
        .unwrap()
        .status(),
        401
    );
    assert_eq!(
        f.post("/api", json!({"method":"list_resources"}))
            .send()
            .unwrap()
            .status(),
        404
    );
    let principal = access::authenticate(&f.services.db, &f.token).unwrap();
    let scoped = access::scoped(&f.services, principal);
    assert!(access::authorize(&scoped, &crate::api::Command::ListResources).is_err());
    assert_eq!(
        f.post(
            "/api/resume",
            json!({"run_id":uuid::Uuid::new_v4().to_string(),
        "interaction_id":"foreign","input":{}})
        )
        .send()
        .unwrap()
        .status(),
        401
    );
}

#[test]
fn transport_rejects_missing_auth_origins_invalid_versions_and_revoked_keys() {
    let f = Fixture::new(Mode::Local);
    assert_eq!(
        f.client
            .post(format!("{}/mcp", f.url))
            .json(&json!({}))
            .send()
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        f.client
            .post(format!("{}/mcp", f.url))
            .bearer_auth("a".repeat(64))
            .json(&json!({}))
            .send()
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        f.post("/mcp", json!({}))
            .header("Origin", "https://example.com")
            .send()
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        f.post("/mcp", json!({}))
            .header("MCP-Protocol-Version", "unsupported")
            .send()
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        f.client
            .get(format!("{}/mcp", f.url))
            .bearer_auth(&f.token)
            .send()
            .unwrap()
            .status(),
        405
    );
    assert_eq!(
        f.post("/mcp", json!({"method":"tools/list"}))
            .send()
            .unwrap()
            .status(),
        400
    );
    access::revoke(&f.services, &f.grant).unwrap();
    assert_eq!(f.post("/api/run", json!({})).send().unwrap().status(), 401);
}

#[test]
fn expiry_and_unpublishing_remove_access_and_disabled_settings_survive_restart() {
    let f = Fixture::new(Mode::Network);
    f.services
        .db
        .connect()
        .unwrap()
        .execute(
            "UPDATE app_access SET expires_at='2000' WHERE id=?1",
            [&f.grant],
        )
        .unwrap();
    assert_eq!(f.post("/api/run", json!({})).send().unwrap().status(), 401);
    f.services
        .db
        .connect()
        .unwrap()
        .execute(
            "UPDATE app_access SET expires_at='2099' WHERE id=?1",
            [&f.grant],
        )
        .unwrap();
    resources::publish(&f.services.db, &f.id, 1, false).unwrap();
    assert_eq!(f.post("/api/run", json!({})).send().unwrap().status(), 400);
    let settings = Settings {
        enabled: false,
        mode: Mode::Network,
        port: 15462,
    };
    f.services
        .external
        .configure(&f.services, settings)
        .unwrap();
    assert_eq!(f.services.external.status().unwrap().settings.port, 15462);
    restore(&f.services).unwrap();
    assert_eq!(
        f.services.external.status().unwrap().settings.mode,
        Mode::Network
    );
    assert!(f.services.external.status().unwrap().urls.is_empty());
}
