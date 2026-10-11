use crate::{
    database::Database,
    error::{Error, Result},
    model::ResourceKind,
    resources,
    workflow::{bindings, graph::HttpMethod, http},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HttpTool {
    pub url: String,
    pub method: HttpMethod,
    #[serde(default)]
    pub body: Value,
}

pub fn validate(body: &Value) -> Result<()> {
    let tool: HttpTool = serde_json::from_value(body.clone()).map_err(|_| Error::Invalid)?;
    if !tool.url.starts_with("https://") || tool.url.len() > 8000 {
        return Err(Error::Invalid);
    }
    Ok(())
}

pub fn invoke(db: &Database, id: &str, input: Value, published: bool) -> Result<Value> {
    let (resource, body) = if published {
        resources::published(db, id)?
    } else {
        let resource = resources::get(db, id)?;
        let draft = resource.draft.clone();
        (resource, draft)
    };
    if resource.kind != ResourceKind::Plugin {
        return Err(Error::Invalid);
    }
    validate(&body)?;
    let tool: HttpTool = serde_json::from_value(body).map_err(|_| Error::Invalid)?;
    let context = json!({"input":input});
    http::request(
        &bindings::render(&tool.url, &context)?,
        tool.method,
        &bindings::resolve(&tool.body, &context)?,
    )
}
