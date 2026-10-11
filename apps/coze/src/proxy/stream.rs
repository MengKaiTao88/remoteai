use super::{ModelProxy, MAX_RESPONSE_BYTES};
use crate::{
    error::{Error, Result},
    jobs::JobControl,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const MAX_TOOL_CALLS: usize = 32;
const MAX_ARGUMENT_BYTES: usize = 128 * 1024;

pub struct CompletionRequest<'a> {
    pub model: &'a str,
    pub messages: &'a [Value],
    pub temperature: f32,
    pub tools: &'a [Value],
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionCall,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Default)]
pub struct Completion {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Default)]
struct Decoder {
    pending: Vec<u8>,
    bytes: u64,
    content: String,
    tools: BTreeMap<usize, ToolCall>,
    finished: bool,
}

impl ModelProxy {
    pub fn complete(
        &self,
        request: CompletionRequest<'_>,
        control: &JobControl,
    ) -> Result<Completion> {
        if request.model.trim().is_empty()
            || request.model.len() > 200
            || !(0.0..=2.0).contains(&request.temperature)
            || request.tools.len() > MAX_TOOL_CALLS
            || request.messages.len() > 1024
        {
            return Err(Error::Invalid);
        }
        control.check()?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| Error::Proxy)?;
        runtime.block_on(self.stream(request, control))
    }

    async fn stream(
        &self,
        request: CompletionRequest<'_>,
        control: &JobControl,
    ) -> Result<Completion> {
        let mut body = json!({"model":request.model,"messages":request.messages,
            "temperature":request.temperature,"stream":true});
        if !request.tools.is_empty() {
            body["tools"] = json!(request.tools);
        }
        let send = self
            .stream_client
            .post(format!("{}/chat/completions", self.base))
            .bearer_auth(&self.token)
            .json(&body)
            .send();
        let mut response = tokio::select! {
            _ = control.cancelled() => return Err(Error::Cancelled),
            result = send => result.map_err(|_| Error::Proxy)?,
        };
        if !response.status().is_success() {
            return Err(Error::Proxy);
        }
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("application/json"))
        {
            return json_response(response, control).await;
        }
        let mut decoder = Decoder::default();
        loop {
            let chunk = tokio::select! {
                _ = control.cancelled() => return Err(Error::Cancelled),
                result = response.chunk() => result.map_err(|_| Error::Proxy)?,
            };
            let Some(chunk) = chunk else {
                break;
            };
            decoder.push(&chunk, control)?;
            if decoder.finished {
                break;
            }
        }
        decoder.finish()
    }
}

async fn json_response(
    mut response: reqwest::Response,
    control: &JobControl,
) -> Result<Completion> {
    // Some providers decline streaming. Deliver their single response without fabricating token deltas.
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = control.cancelled() => return Err(Error::Cancelled),
            result = response.chunk() => result.map_err(|_| Error::Proxy)?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > MAX_RESPONSE_BYTES {
            return Err(Error::Limit);
        }
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Proxy)?;
    let message = value.pointer("/choices/0/message").ok_or(Error::Proxy)?;
    let content = message["content"].as_str().unwrap_or_default().to_owned();
    let tool_calls: Vec<ToolCall> =
        serde_json::from_value(message.get("tool_calls").cloned().unwrap_or(json!([])))
            .map_err(|_| Error::Proxy)?;
    validate_calls(&tool_calls)?;
    control.emit(json!({"type":"delta","text":content}))?;
    Ok(Completion {
        content,
        tool_calls,
    })
}

impl Decoder {
    fn push(&mut self, chunk: &[u8], control: &JobControl) -> Result<()> {
        self.bytes += chunk.len() as u64;
        if self.bytes > MAX_RESPONSE_BYTES {
            return Err(Error::Limit);
        }
        self.pending.extend_from_slice(chunk);
        while let Some(position) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<_> = self.pending.drain(..=position).collect();
            let line = std::str::from_utf8(&line).map_err(|_| Error::Proxy)?.trim();
            if let Some(data) = line.strip_prefix("data:") {
                self.data(data.trim(), control)?;
            }
        }
        Ok(())
    }

    fn data(&mut self, data: &str, control: &JobControl) -> Result<()> {
        if data == "[DONE]" {
            self.finished = true;
            return Ok(());
        }
        if data.is_empty() {
            return Ok(());
        }
        let value: Value = serde_json::from_str(data).map_err(|_| Error::Proxy)?;
        if value.get("error").is_some() {
            return Err(Error::Proxy);
        }
        let Some(choice) = value.pointer("/choices/0") else {
            return Ok(());
        };
        if let Some(text) = choice.pointer("/delta/content").and_then(Value::as_str) {
            self.content.push_str(text);
            control.emit(json!({"type":"delta","text":text}))?;
        }
        if let Some(tools) = choice
            .pointer("/delta/tool_calls")
            .and_then(Value::as_array)
        {
            for tool in tools {
                self.tool(tool)?;
            }
        }
        // finish_reason arrives before optional usage and [DONE]; retain all complete content.
        if choice
            .get("finish_reason")
            .is_some_and(|value| !value.is_null())
        {
            self.finished = true;
        }
        Ok(())
    }

    fn tool(&mut self, delta: &Value) -> Result<()> {
        let index = delta["index"].as_u64().ok_or(Error::Proxy)? as usize;
        if index >= MAX_TOOL_CALLS {
            return Err(Error::Limit);
        }
        let tool = self.tools.entry(index).or_default();
        if let Some(id) = delta["id"].as_str() {
            tool.id.push_str(id);
        }
        if let Some(kind) = delta["type"].as_str() {
            tool.kind = kind.into();
        }
        if let Some(name) = delta.pointer("/function/name").and_then(Value::as_str) {
            tool.function.name.push_str(name);
        }
        if let Some(arguments) = delta.pointer("/function/arguments").and_then(Value::as_str) {
            tool.function.arguments.push_str(arguments);
        }
        if tool.function.arguments.len() > MAX_ARGUMENT_BYTES
            || tool.id.len() > 200
            || tool.function.name.len() > 200
        {
            return Err(Error::Limit);
        }
        Ok(())
    }

    fn finish(self) -> Result<Completion> {
        // A disconnected stream must never be persisted as a successful answer.
        if !self.finished {
            return Err(Error::Proxy);
        }
        let calls: Vec<_> = self.tools.into_values().collect();
        validate_calls(&calls)?;
        Ok(Completion {
            content: self.content,
            tool_calls: calls,
        })
    }
}

fn validate_calls(calls: &[ToolCall]) -> Result<()> {
    let mut ids = std::collections::HashSet::new();
    if calls.len() > MAX_TOOL_CALLS {
        return Err(Error::Limit);
    }
    for call in calls {
        if call.id.is_empty()
            || call.id.len() > 200
            || call.kind != "function"
            || call.function.name.is_empty()
            || call.function.name.len() > 200
            || call.function.arguments.len() > MAX_ARGUMENT_BYTES
            || !ids.insert(&call.id)
        {
            return Err(Error::Proxy);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_utf8_and_tool_arguments_are_assembled() {
        let control = JobControl::detached();
        let mut decoder = Decoder::default();
        let frames = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",",
            "\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,",
            "\"function\":{\"arguments\":\"\\\"Rust\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n");
        for byte in frames.bytes() {
            decoder.push(&[byte], &control).unwrap();
        }
        let completion = decoder.finish().unwrap();
        assert_eq!(completion.content, "你好");
        assert_eq!(
            completion.tool_calls[0].function.arguments,
            "{\"q\":\"Rust\"}"
        );
    }

    #[test]
    fn disconnected_and_cancelled_streams_do_not_succeed() {
        assert!(matches!(Decoder::default().finish(), Err(Error::Proxy)));
        let control = JobControl::detached();
        control.cancel();
        assert!(matches!(control.check(), Err(Error::Cancelled)));
    }
}
