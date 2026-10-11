use super::{
    bindings::{render, resolve},
    NodeAction,
};
use crate::error::{Error, Result};
use serde_json::{json, Value};

pub(super) fn evaluate(action: &NodeAction, values: &mut Value) -> Result<Value> {
    match action {
        NodeAction::Start => Ok(values["input"].clone()),
        NodeAction::End { value } | NodeAction::Output { value } => resolve(value, values),
        NodeAction::JsonStringify { value } => Ok(json!(resolve(value, values)?.to_string())),
        NodeAction::JsonParse { text } => {
            serde_json::from_str(&render(text, values)?).map_err(|_| Error::Workflow)
        }
        NodeAction::Template { template } => Ok(json!(render(template, values)?)),
        NodeAction::Condition {
            left,
            right,
            operator,
        } => super::engine::condition(resolve(left, values)?, resolve(right, values)?, *operator),
        NodeAction::Variable {
            variable_name,
            value,
        } => {
            let value = resolve(value, values)?;
            values["variables"][variable_name] = value.clone();
            Ok(value)
        }
        NodeAction::Aggregate { values: candidates } => aggregate(candidates, values),
        NodeAction::AggregateGroups { groups } => groups
            .iter()
            .map(|(name, candidates)| Ok((name.clone(), aggregate(candidates, values)?)))
            .collect::<Result<serde_json::Map<_, _>>>()
            .map(Value::Object),
        _ => Err(Error::Workflow),
    }
}

fn aggregate(candidates: &[Value], values: &Value) -> Result<Value> {
    candidates
        .iter()
        .filter_map(|candidate| resolve(candidate, values).ok())
        .find(|value| !value.is_null())
        .ok_or(Error::Workflow)
}
