use super::{storage, Principal, Role};
use crate::{
    api::Services,
    error::{Error, Result},
    resources,
};
use serde_json::{json, Value};

#[derive(Default)]
pub struct Permit {
    pub(super) output: Output,
}

#[derive(Default)]
pub(super) enum Output {
    #[default]
    Plain,
    Resource,
    Resources,
    Execution,
    Job,
    JobStatus,
    History(&'static str),
    McpList,
}

impl Permit {
    pub(super) fn new(output: Output) -> Self {
        Self { output }
    }

    pub fn finish(self, services: &Services, mut value: Value) -> Result<Value> {
        if services.principal.is_owner() {
            return Ok(value);
        }
        storage::ensure_active(services)?;
        match self.output {
            Output::Plain => {}
            Output::Resource => value = resource(services, value)?,
            Output::Resources => {
                let values = value.as_array().ok_or(Error::Invalid)?;
                let mut allowed = Vec::new();
                for value in values {
                    if services
                        .principal
                        .allows(value["id"].as_str().unwrap_or_default())
                    {
                        allowed.push(resource(services, value.clone())?);
                    }
                }
                value = json!(allowed);
            }
            Output::Execution => remember_output(services, &value)?,
            Output::Job => {
                storage::remember(services, "job", value["id"].as_str().ok_or(Error::Invalid)?)?
            }
            Output::JobStatus => remember_output(services, &value["result"])?,
            Output::History(kind) => {
                let mut allowed = Vec::new();
                for item in value.as_array().ok_or(Error::Invalid)? {
                    if storage::owns(services, kind, item["id"].as_str().unwrap_or_default())? {
                        allowed.push(item.clone());
                    }
                }
                value = json!(allowed);
            }
            Output::McpList => {
                let entries = value.as_array().ok_or(Error::Invalid)?;
                value = json!(entries
                    .iter()
                    .filter(|item| services
                        .principal
                        .allows(item["id"].as_str().unwrap_or_default()))
                    .collect::<Vec<_>>());
            }
        }
        Ok(value)
    }

    pub fn finish_mcp(self, services: &Services, mut response: Value) -> Result<Value> {
        if services.principal.is_owner() || response["result"]["isError"] == true {
            return Ok(response);
        }
        let Some(text) = response
            .pointer("/result/content/0/text")
            .and_then(Value::as_str)
        else {
            return Ok(response);
        };
        let value = serde_json::from_str(text).map_err(|_| Error::Invalid)?;
        response["result"]["content"][0]["text"] =
            Value::String(self.finish(services, value)?.to_string());
        Ok(response)
    }
}

fn remember_output(services: &Services, value: &Value) -> Result<()> {
    if let Some(id) = value["conversationId"].as_str() {
        storage::remember(services, "conversation", id)?;
    }
    if value["status"].is_string() {
        if let Some(id) = value["id"].as_str() {
            storage::remember(services, "run", id)?;
        }
    }
    Ok(())
}

fn resource(services: &Services, mut value: Value) -> Result<Value> {
    let Principal::Shared(grant) = &services.principal else {
        return Ok(value);
    };
    let id = value["id"].as_str().ok_or(Error::Invalid)?;
    if grant.role == Role::Editor && value["kind"] != "app" {
        return Ok(value);
    }
    let (_, body) = resources::published(&services.db, id)?;
    let revision = grant.revisions.get(id).ok_or(Error::Unauthorized)?;
    value["draft"] = body;
    value["revision"] = json!(revision);
    value["publishedRevision"] = json!(revision);
    Ok(value)
}
