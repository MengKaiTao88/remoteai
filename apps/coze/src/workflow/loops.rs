use super::{checkpoint::Checkpoint, RuntimeContext};
use crate::{
    error::{Error, Result},
    model::ResourceKind,
    resources,
};
use serde_json::{json, Value};

const MAX_ITERATIONS: usize = 100;

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Signal {
    #[default]
    Completed,
    Break,
    Continue,
}

/// Iterations share workflow variables, but each iteration gets an isolated node-output scope.
pub(super) fn run(
    context: &RuntimeContext<'_>,
    id: &str,
    items: Value,
    values: &mut Value,
) -> Result<Value> {
    let items = items.as_array().ok_or(Error::Workflow)?;
    if items.len() > MAX_ITERATIONS {
        return Err(Error::Limit);
    }
    let graph = graph(context, id)?;
    let mut results = Vec::new();
    let mut bytes = 0;
    for (index, item) in items.iter().enumerate() {
        context.control.check()?;
        let mut state = Checkpoint::new(
            graph.clone(),
            json!({"item":item,"index":index}),
            context.published,
        )?;
        state.values["variables"] = values["variables"].clone();
        let child = RuntimeContext {
            services: context.services,
            depth: context.depth + 1,
            deadline: context.deadline,
            published: context.published,
            control: context.control.clone(),
        };
        let signal = super::engine::execute_state(&child, &mut state)?;
        values["variables"] = state.values["variables"].clone();
        if signal == Signal::Break {
            break;
        }
        if signal == Signal::Continue {
            continue;
        }
        let output = state.output.ok_or(Error::Workflow)?;
        bytes += output.to_string().len();
        if bytes > 8 * 1024 * 1024 {
            return Err(Error::Limit);
        }
        results.push(output);
    }
    Ok(json!(results))
}

pub(super) fn repeat(
    context: &RuntimeContext<'_>,
    id: &str,
    count: Value,
    values: &mut Value,
) -> Result<Value> {
    let count = count.as_u64().ok_or(Error::Workflow)?;
    if count > MAX_ITERATIONS as u64 {
        return Err(Error::Limit);
    }
    run(context, id, json!((0..count).collect::<Vec<_>>()), values)
}

pub(super) fn graph(context: &RuntimeContext<'_>, id: &str) -> Result<super::Graph> {
    let (resource, body) = if context.published {
        resources::published(&context.services.db, id)?
    } else {
        let resource = resources::get(&context.services.db, id)?;
        let body = resource.draft.clone();
        (resource, body)
    };
    if resource.kind != ResourceKind::Workflow {
        return Err(Error::Workflow);
    }
    serde_json::from_value(body).map_err(|_| Error::Workflow)
}
