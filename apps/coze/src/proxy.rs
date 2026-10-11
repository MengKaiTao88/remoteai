use crate::{
    error::{Error, Result},
    model::Message,
};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{io::Read, time::Duration};

mod responses;
mod stream;
#[cfg(test)]
mod tests;
pub use stream::{Completion, CompletionRequest, ToolCall};

#[derive(Clone)]
pub struct VisionImage {
    pub mime_type: String,
    pub content_base64: String,
}

pub struct VisionRequest<'a> {
    pub model: &'a str,
    pub images: &'a [VisionImage],
    pub prompt: &'a str,
}

const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

/// The runtime receives only the local proxy credential, never a Provider's upstream key.
#[derive(Clone)]
pub struct ModelProxy {
    base: String,
    token: String,
    client: Client,
    stream_client: reqwest::Client,
    native_responses: bool,
}

impl ModelProxy {
    pub fn new(base: &str, token: String) -> Result<Self> {
        let url = url::Url::parse(base).map_err(|_| Error::Invalid)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Invalid);
        }
        let client = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| Error::Proxy)?;
        let stream_client = reqwest::Client::builder()
            .no_proxy()
            .pool_max_idle_per_host(0)
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| Error::Proxy)?;
        Ok(Self {
            native_responses: url.path().trim_end_matches('/') == "/codex-gui/v1",
            base: base.trim_end_matches('/').to_owned(),
            token,
            client,
            stream_client,
        })
    }

    pub fn models(&self) -> Result<Value> {
        let response = self
            .client
            .get(format!("{}/models", self.base))
            .bearer_auth(&self.token)
            .send()
            .map_err(|_| Error::Proxy)?;
        let value = decode(response)?;
        let models = value
            .get("data")
            .or_else(|| value.get("models"))
            .and_then(Value::as_array)
            .ok_or(Error::Proxy)?;
        Ok(json!(models.iter().filter_map(|model| {
            let id = model.get("id").or_else(|| model.get("slug"))?.as_str()?;
            Some(json!({"id":id,"name":model.get("display_name").and_then(Value::as_str).unwrap_or(id)}))
        }).collect::<Vec<_>>()))
    }

    pub fn chat(&self, model: &str, messages: &[Message], temperature: f32) -> Result<String> {
        if model.trim().is_empty() || model.len() > 200 || !(0.0..=2.0).contains(&temperature) {
            return Err(Error::Invalid);
        }
        let messages: Vec<_> = messages
            .iter()
            .map(|message| json!({"role":message.role,"content":message.content}))
            .collect();
        Ok(self
            .complete(
                CompletionRequest {
                    model,
                    messages: &messages,
                    temperature,
                    tools: &[],
                },
                &crate::jobs::JobControl::detached(),
            )?
            .content)
    }

    /// Images are forwarded only to the Remote AI loopback proxy selected by the desktop.
    pub fn vision(&self, model: &str, images: &[VisionImage], prompt: &str) -> Result<String> {
        self.vision_controlled(
            VisionRequest {
                model,
                images,
                prompt,
            },
            &crate::jobs::JobControl::detached(),
        )
    }

    pub fn vision_controlled(
        &self,
        request: VisionRequest<'_>,
        control: &crate::jobs::JobControl,
    ) -> Result<String> {
        let VisionRequest {
            model,
            images,
            prompt,
        } = request;
        if images.is_empty()
            || images.len() > 16
            || prompt.len() > 32_000
            || model.trim().is_empty()
            || model.len() > 200
            || images
                .iter()
                .map(|image| image.content_base64.len())
                .sum::<usize>()
                > 24 * 1024 * 1024
        {
            return Err(Error::Invalid);
        }
        let mut content = vec![json!({"type":"text","text":prompt})];
        for image in images {
            if !matches!(
                image.mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp"
            ) || image.content_base64.is_empty()
                || !image
                    .content_base64
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
            {
                return Err(Error::Invalid);
            }
            content.push(json!({"type":"image_url","image_url":{
                "url":format!("data:{};base64,{}",image.mime_type,image.content_base64)}}));
        }
        let messages = [json!({"role":"user","content":content})];
        Ok(self
            .complete(
                CompletionRequest {
                    model,
                    messages: &messages,
                    temperature: 0.1,
                    tools: &[],
                },
                control,
            )?
            .content)
    }
}

fn decode(response: reqwest::blocking::Response) -> Result<Value> {
    if !response.status().is_success() {
        return Err(Error::Proxy);
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Proxy)?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(Error::Limit);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Proxy)
}
