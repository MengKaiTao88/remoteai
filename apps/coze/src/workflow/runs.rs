use crate::{
    api::Services,
    database::Database,
    error::{Error, Result},
    model::*,
    resources,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    pub resource_id: String,
    pub input: Value,
    #[serde(default)]
    pub published: bool,
}

pub fn run(services: &Services, request: RunRequest) -> Result<Value> {
    run_controlled(services, request, &crate::jobs::JobControl::detached())
}

pub fn start(services: &Services, request: RunRequest) -> Result<Value> {
    let services = services.clone();
    services.jobs.clone().start(move |control| {
        let _lease = services.maintenance.read().map_err(|_| Error::Conflict)?;
        run_controlled(&services, request, &control)
    })
}

/// Run with cancellation and progressive node events, including when called by an agent tool.
pub fn run_controlled(
    services: &Services,
    request: RunRequest,
    control: &crate::jobs::JobControl,
) -> Result<Value> {
    let scoped = if request.published {
        services.for_publication(&request.resource_id)?
    } else {
        services.clone()
    };
    let services = &scoped;
    let (resource, body) = if request.published {
        resources::published(&services.db, &request.resource_id)?
    } else {
        let resource = resources::get(&services.db, &request.resource_id)?;
        let body = resource.draft.clone();
        (resource, body)
    };
    if resource.kind != ResourceKind::Workflow {
        return Err(Error::Workflow);
    }
    let graph = serde_json::from_value(body).map_err(|_| Error::Workflow)?;
    let mut state =
        super::checkpoint::Checkpoint::new(graph, request.input.clone(), request.published)?;
    state.revisions = services.db.pinned_revisions().cloned();
    let id = uuid::Uuid::new_v4().to_string();
    let revision = if request.published {
        resource.published_revision.ok_or(Error::Unpublished)?
    } else {
        resource.revision
    };
    services.db.connect()?.execute(
        "INSERT INTO runs (id,resource_id,revision,status,input,created_at) VALUES (?1,?2,?3,'running',?4,?5)",
        params![id, resource.id, revision, request.input.to_string(), now()])?;
    crate::collaboration_access::register_execution(services, "run", &id)?;
    super::checkpoint::store(&services.db, &id, &state, "running")?;
    super::continuation::drive(services, &id, state, control)
}

pub fn list_runs(db: &Database, id: &str) -> Result<Value> {
    validate_id(id)?;
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT r.id,status,input,output,trace,error,created_at,revision,c.state FROM runs r
        LEFT JOIN workflow_checkpoints c ON c.run_id=r.id
        WHERE resource_id=?1 ORDER BY created_at DESC LIMIT 100",
    )?;
    let runs = stmt
        .query_map([id], |row| {
            let input: String = row.get(2)?;
            let output: Option<String> = row.get(3)?;
            let trace: String = row.get(4)?;
            let state: Option<String> = row.get(8)?;
            let state = state.and_then(|text| serde_json::from_str::<Value>(&text).ok());
            Ok(
                json!({"id":row.get::<_, String>(0)?,"status":row.get::<_, String>(1)?,
            "input":serde_json::from_str::<Value>(&input).unwrap_or(Value::Null),
            "output":output.and_then(|text| serde_json::from_str::<Value>(&text).ok()),
            "trace":serde_json::from_str::<Value>(&trace).unwrap_or(Value::Null),
            "error":row.get::<_, Option<String>>(5)?,"createdAt":row.get::<_, String>(6)?,
            "revision":row.get::<_, u64>(7)?,"interaction":state.and_then(|state| state.get("interaction").cloned())}),
            )
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(runs))
}
