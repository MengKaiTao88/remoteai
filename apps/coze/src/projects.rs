//! Applications group resources and publish a fixed entry point and dependency closure.
use crate::{
    api::Services,
    database::Database,
    error::{Error, Result},
    model::ResourceKind,
    resources,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppDraft {
    pub entry_id: String,
    pub resource_ids: Vec<String>,
}

pub fn validate(db: &Database, body: &Value) -> Result<()> {
    let app: AppDraft = serde_json::from_value(body.clone()).map_err(|_| Error::Invalid)?;
    if app.resource_ids.len() > 128 || !app.resource_ids.contains(&app.entry_id) {
        return Err(Error::Invalid);
    }
    let entry = resources::get(db, &app.entry_id)?;
    if !matches!(entry.kind, ResourceKind::Workflow | ResourceKind::Agent) {
        return Err(Error::Invalid);
    }
    for id in app.resource_ids {
        if resources::get(db, &id)?.kind == ResourceKind::App {
            return Err(Error::Invalid);
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppRun {
    pub app_id: String,
    #[serde(default = "empty_input")]
    pub input: Value,
    #[serde(default)]
    pub message: String,
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub published: bool,
}

fn empty_input() -> Value {
    json!({})
}

pub fn run(services: &Services, request: AppRun) -> Result<Value> {
    let scoped = if request.published {
        services.for_publication(&request.app_id)?
    } else {
        services.clone()
    };
    let (resource, body) = if request.published {
        resources::published(&scoped.db, &request.app_id)?
    } else {
        let resource = resources::get(&scoped.db, &request.app_id)?;
        let body = resource.draft.clone();
        (resource, body)
    };
    if resource.kind != ResourceKind::App {
        return Err(Error::Invalid);
    }
    validate(&scoped.db, &body)?;
    let app: AppDraft = serde_json::from_value(body).map_err(|_| Error::Invalid)?;
    match resources::get(&scoped.db, &app.entry_id)?.kind {
        ResourceKind::Workflow => crate::workflow::run(
            &scoped,
            crate::workflow::RunRequest {
                resource_id: app.entry_id,
                input: request.input,
                published: request.published,
            },
        ),
        ResourceKind::Agent => crate::agents::chat(
            &scoped,
            crate::agents::ChatRequest {
                agent_id: app.entry_id,
                message: request.message,
                conversation_id: request.conversation_id,
                published: request.published,
            },
        ),
        _ => Err(Error::Invalid),
    }
}
