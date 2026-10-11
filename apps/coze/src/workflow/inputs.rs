use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputField {
    pub name: String,
    pub description: String,
    pub kind: InputKind,
    #[serde(default)]
    pub required: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputKind {
    String,
    Number,
    Integer,
    Boolean,
    Object,
    Array,
}

pub(super) fn validate_fields(fields: &[InputField]) -> Result<()> {
    let mut names = std::collections::HashSet::new();
    if fields.len() > 100 {
        return Err(Error::Workflow);
    }
    for field in fields {
        if field.name.is_empty()
            || field.name.len() > 100
            || field.name.contains(['.', '{', '}'])
            || !names.insert(&field.name)
            || field.description.len() > 2000
        {
            return Err(Error::Workflow);
        }
    }
    Ok(())
}

pub(super) fn validate_input(fields: &[InputField], input: &Value) -> Result<()> {
    if !input.is_object() {
        return Err(Error::Invalid);
    }
    for field in fields {
        let Some(value) = input.get(&field.name) else {
            if field.required {
                return Err(Error::Invalid);
            }
            continue;
        };
        let valid = match field.kind {
            InputKind::String => value.is_string(),
            InputKind::Number => value.is_number(),
            InputKind::Integer => value.is_i64() || value.is_u64(),
            InputKind::Boolean => value.is_boolean(),
            InputKind::Object => value.is_object(),
            InputKind::Array => value.is_array(),
        };
        if !valid {
            return Err(Error::Invalid);
        }
    }
    Ok(())
}

pub fn schema(graph: &super::Graph) -> Value {
    let properties: serde_json::Map<String, Value> = graph
        .inputs
        .iter()
        .map(|field| {
            (
                field.name.clone(),
                json!({"type":field.kind,"description":field.description}),
            )
        })
        .collect();
    json!({"type":"object","properties":properties,
        "required":graph.inputs.iter().filter(|field| field.required).map(|field| &field.name).collect::<Vec<_>>()})
}
