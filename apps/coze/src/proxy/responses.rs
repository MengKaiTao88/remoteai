//! Adapt stored chat history to the same Responses transport used by Codex GUI.
use super::{
    stream::{validate_calls, FunctionCall},
    Completion, CompletionRequest, ToolCall,
};
use crate::error::{Error, Result};
use serde_json::{json, Value};

pub(super) fn request_body(request: &CompletionRequest<'_>) -> Result<Value> {
    let mut instructions = Vec::new();
    let mut input = Vec::new();
    for message in request.messages {
        append_message(message, &mut instructions, &mut input)?;
    }
    let tools = request
        .tools
        .iter()
        .map(|tool| {
            let mut function = tool["function"].clone();
            if !function.is_object() {
                return Err(Error::Invalid);
            }
            function["type"] = json!("function");
            function["strict"] = json!(false);
            Ok(function)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut body = json!({"model":request.model,"instructions":instructions.join("\n\n"),
        "input":input,"tools":tools,"store":false,"stream":true});
    // Codex reasoning models reject sampling controls; ordinary chat Providers still receive them.
    if !["gpt-5", "gpt-6", "o1", "o3", "o4"]
        .iter()
        .any(|prefix| request.model.starts_with(prefix))
    {
        body["temperature"] = json!(request.temperature);
    }
    Ok(body)
}

#[cfg(test)]
#[path = "responses_tests.rs"]
mod tests;

fn append_message(
    message: &Value,
    instructions: &mut Vec<String>,
    input: &mut Vec<Value>,
) -> Result<()> {
    let role = message["role"].as_str().ok_or(Error::Invalid)?;
    if matches!(role, "system" | "developer") {
        instructions.push(
            message["content"]
                .as_str()
                .ok_or(Error::Invalid)?
                .to_owned(),
        );
        return Ok(());
    }
    if role == "tool" {
        input.push(
            json!({"type":"function_call_output", "call_id":message["tool_call_id"],
            "output":message["content"]}),
        );
        return Ok(());
    }
    if !matches!(role, "user" | "assistant") {
        return Err(Error::Invalid);
    }
    if !message["content"].is_null() && message["content"] != "" {
        input.push(json!({"role":role,"content":content(&message["content"],role)?}));
    }
    if let Some(calls) = message["tool_calls"].as_array() {
        for call in calls {
            input.push(json!({"type":"function_call","call_id":call["id"],
                "name":call["function"]["name"],"arguments":call["function"]["arguments"]}));
        }
    }
    Ok(())
}

fn content(value: &Value, role: &str) -> Result<Value> {
    if value.is_string() {
        return Ok(value.clone());
    }
    let parts = value.as_array().ok_or(Error::Invalid)?;
    parts
        .iter()
        .map(|part| match part["type"].as_str() {
            Some("text") => Ok(
                json!({"type":if role == "assistant" {"output_text"} else {"input_text"},
            "text":part["text"]}),
            ),
            Some("image_url") if role == "user" => Ok(json!({"type":"input_image",
            "image_url":part["image_url"]["url"]})),
            _ => Err(Error::Invalid),
        })
        .collect::<Result<Vec<_>>>()
        .map(Value::Array)
}

pub(super) fn completion(value: &Value) -> Result<Completion> {
    if value["status"] != "completed" || value.get("error").is_some_and(|error| !error.is_null()) {
        return Err(Error::Proxy);
    }
    let mut completion = Completion::default();
    for item in value["output"].as_array().ok_or(Error::Proxy)? {
        match item["type"].as_str() {
            Some("message") => append_text(item, &mut completion)?,
            Some("function_call") => completion.tool_calls.push(tool_call(item)?),
            _ => {}
        }
    }
    validate_calls(&completion.tool_calls)?;
    Ok(completion)
}

pub(super) fn tool_call(item: &Value) -> Result<ToolCall> {
    Ok(ToolCall {
        id: string(item, "call_id")?,
        kind: "function".into(),
        function: FunctionCall {
            name: string(item, "name")?,
            arguments: string(item, "arguments")?,
        },
    })
}

fn string(value: &Value, key: &str) -> Result<String> {
    value[key].as_str().map(str::to_owned).ok_or(Error::Proxy)
}

fn append_text(item: &Value, completion: &mut Completion) -> Result<()> {
    for part in item["content"].as_array().ok_or(Error::Proxy)? {
        match part["type"].as_str() {
            Some("output_text") => completion.content.push_str(&string(part, "text")?),
            Some("refusal") => completion.content.push_str(&string(part, "refusal")?),
            _ => {}
        }
    }
    Ok(())
}
