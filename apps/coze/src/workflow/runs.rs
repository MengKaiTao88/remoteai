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
    let id = uuid::Uuid::new_v4().to_string();
    let revision = if request.published {
        resource.published_revision.ok_or(Error::Unpublished)?
    } else {
        resource.revision
    };
    services.db.connect()?.execute(
        "INSERT INTO runs (id,resource_id,revision,status,input,created_at) VALUES (?1,?2,?3,'running',?4,?5)",
        params![id, resource.id, revision, request.input.to_string(), now()])?;
    let mut trace = Vec::new();
    let result = super::execute(
        &super::RuntimeContext::new(services, request.published),
        &graph,
        request.input,
        &mut trace,
    );
    let (status, output, error) = match &result {
        Ok(value) => ("completed", Some(value.to_string()), None),
        Err(error) => ("failed", None, Some(error.to_string())),
    };
    services.db.connect()?.execute(
        "UPDATE runs SET status=?1, output=?2, trace=?3, error=?4, finished_at=?5 WHERE id=?6",
        params![status, output, json!(trace).to_string(), error, now(), id],
    )?;
    Ok(json!({"id":id,"status":status,"output":result.ok(),"error":error,"trace":trace}))
}

pub fn list_runs(db: &Database, id: &str) -> Result<Value> {
    validate_id(id)?;
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT id,status,input,output,trace,error,created_at,revision FROM runs
        WHERE resource_id=?1 ORDER BY created_at DESC LIMIT 100",
    )?;
    let runs = stmt
        .query_map([id], |row| {
            let input: String = row.get(2)?;
            let output: Option<String> = row.get(3)?;
            let trace: String = row.get(4)?;
            Ok(
                json!({"id":row.get::<_, String>(0)?,"status":row.get::<_, String>(1)?,
            "input":serde_json::from_str::<Value>(&input).unwrap_or(Value::Null),
            "output":output.and_then(|text| serde_json::from_str::<Value>(&text).ok()),
            "trace":serde_json::from_str::<Value>(&trace).unwrap_or(Value::Null),
            "error":row.get::<_, Option<String>>(5)?,"createdAt":row.get::<_, String>(6)?,
            "revision":row.get::<_, u64>(7)?}),
            )
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(runs))
}
