use super::{text, unsupported};
use crate::error::{Error, Result};
use serde_json::{Map, Value};
use std::collections::HashMap;

pub(super) fn parameters(value: &Value, index: &HashMap<&str, &str>) -> Result<Value> {
    let Some(items) = value.as_array() else {
        return if value.is_null() {
            Ok(Value::Object(Map::new()))
        } else {
            Err(Error::Workflow)
        };
    };
    let mut parameters = Map::new();
    for item in items {
        if parameters
            .insert(
                text(item, "name")?.to_owned(),
                typed(&item["input"], index)?,
            )
            .is_some()
        {
            return Err(Error::Workflow);
        }
    }
    Ok(Value::Object(parameters))
}

pub(super) fn typed(value: &Value, index: &HashMap<&str, &str>) -> Result<Value> {
    let content = &value["value"]["content"];
    match value["value"]["type"].as_str() {
        Some("literal") => literal(value, content),
        Some("ref") => reference(content, index).map(Value::String),
        _ => Err(unsupported("变量表达式")),
    }
}

fn literal(value: &Value, content: &Value) -> Result<Value> {
    let Some(text) = content.as_str() else {
        return Ok(content.clone());
    };
    if matches!(
        value["type"].as_str(),
        Some("integer" | "float" | "boolean")
    ) {
        return serde_json::from_str(text).map_err(|_| Error::Workflow);
    }
    Ok(content.clone())
}

fn reference(content: &Value, index: &HashMap<&str, &str>) -> Result<String> {
    if content["source"] != "block-output" {
        return Err(unsupported("应用或系统变量"));
    }
    let block = text(content, "blockID")?;
    let name = text(content, "name")?;
    let kind = index.get(block).ok_or(Error::Workflow)?;
    if name.is_empty() || name.contains(['{', '}']) {
        return Err(Error::Workflow);
    }
    let path = match *kind {
        "1" => format!("input.{name}"),
        "3" | "58" | "59" => {
            let suffix = name.strip_prefix("output").ok_or(Error::Workflow)?;
            if !suffix.is_empty() && !suffix.starts_with('.') {
                return Err(Error::Workflow);
            }
            format!("{block}.output{suffix}")
        }
        _ => format!("{block}.output.{name}"),
    };
    Ok(format!("{{{{{path}}}}}"))
}

/// Replace upstream local aliases with equivalent typed bindings; unresolved aliases fail.
pub(super) fn template(value: &Value, parameters: &Value) -> Result<String> {
    let mut remaining = value.as_str().ok_or(Error::Workflow)?;
    let mut output = String::new();
    while let Some(start) = remaining.find("{{") {
        output.push_str(&remaining[..start]);
        remaining = &remaining[start + 2..];
        let end = remaining.find("}}").ok_or(Error::Workflow)?;
        let alias = remaining[..end].trim();
        let value = parameters.get(alias).ok_or(Error::Workflow)?;
        output.push_str(&match value {
            Value::String(text) => text.clone(),
            _ => value.to_string(),
        });
        remaining = &remaining[end + 2..];
    }
    output.push_str(remaining);
    Ok(output)
}
