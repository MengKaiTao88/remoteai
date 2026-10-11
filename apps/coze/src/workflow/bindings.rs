use crate::error::{Error, Result};
use serde_json::Value;

const MAX_EXPANDED_BYTES: usize = 1024 * 1024;

pub(crate) fn resolve(value: &Value, context: &Value) -> Result<Value> {
    match value {
        Value::String(text)
            if text.starts_with("{{")
                && text.ends_with("}}")
                && text.matches("{{").count() == 1 =>
        {
            lookup(&text[2..text.len() - 2], context).cloned()
        }
        Value::String(text) => Ok(Value::String(render(text, context)?)),
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|item| resolve(item, context))
                .collect::<Result<_>>()?,
        )),
        Value::Object(items) => Ok(Value::Object(
            items
                .iter()
                .map(|(key, value)| Ok((key.clone(), resolve(value, context)?)))
                .collect::<Result<_>>()?,
        )),
        _ => Ok(value.clone()),
    }
}

pub(crate) fn render(template: &str, context: &Value) -> Result<String> {
    let mut remaining = template;
    let mut result = String::new();
    while let Some(start) = remaining.find("{{") {
        result.push_str(&remaining[..start]);
        remaining = &remaining[start + 2..];
        let end = remaining.find("}}").ok_or(Error::Workflow)?;
        let value = lookup(&remaining[..end], context)?;
        result.push_str(&match value {
            Value::String(text) => text.clone(),
            _ => value.to_string(),
        });
        if result.len() > MAX_EXPANDED_BYTES {
            return Err(Error::Limit);
        }
        remaining = &remaining[end + 2..];
    }
    result.push_str(remaining);
    if result.len() > MAX_EXPANDED_BYTES {
        return Err(Error::Limit);
    }
    Ok(result)
}

fn lookup<'a>(path: &str, context: &'a Value) -> Result<&'a Value> {
    let mut value = context;
    for segment in path.trim().split('.') {
        value = match value {
            Value::Array(items) => {
                items.get(segment.parse::<usize>().map_err(|_| Error::Workflow)?)
            }
            _ => value.get(segment),
        }
        .ok_or(Error::Workflow)?;
    }
    Ok(value)
}
