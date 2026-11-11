use super::{Config, Error, Result};
use reqwest::{header, redirect::Policy, Client, Method, StatusCode};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};

// Native saved/live snapshots include tool output and image metadata. Ordinary
// long chats exceed 16 MiB before the desktop applies its display window.
// Keep a finite bound and enforce it both on headers and streamed chunks.
const MAX_RESPONSE: usize = 640 * 1024 * 1024;
const MAX_REQUEST: usize = 500_000;

pub(super) struct Transport {
    client: Client,
    config: Config,
    csrf: RwLock<Option<String>>,
    login: Mutex<()>,
}

impl Transport {
    pub(super) async fn image(&self, path: &str, limit: usize) -> Result<String> {
        use base64::Engine;
        self.authenticate().await?;
        let url = self.config.url.join(path).map_err(|_| Error::Invalid)?;
        if url.origin() != self.config.url.origin() {
            return Err(Error::Invalid);
        }
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| Error::Disconnected)?;
        if !response.status().is_success() {
            return Err(Error::Disconnected);
        }
        let mime = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .filter(|value| {
                matches!(
                    *value,
                    "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                )
            })
            .ok_or(Error::Invalid)?
            .to_owned();
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(Error::Invalid);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Disconnected)? {
            if bytes.len() + chunk.len() > limit {
                return Err(Error::Invalid);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    pub(super) fn new(config: Config) -> Result<Self> {
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .cookie_provider(Arc::new(reqwest::cookie::Jar::default()))
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(100))
            .build()
            .map_err(|_| Error::Disconnected)?;
        Ok(Self {
            client,
            config,
            csrf: RwLock::new(None),
            login: Mutex::new(()),
        })
    }

    pub(super) async fn authenticate(&self) -> Result<()> {
        let _login = self.login.lock().await;
        if self.csrf.read().await.is_some() {
            return Ok(());
        }
        let (status, auth) = self.raw(Method::GET, "/api/auth", None).await?;
        let response = if status.is_success() && auth["authenticated"] == true {
            auth
        } else {
            let body =
                json!({"username": self.config.username, "password": &**self.config.password});
            let (status, value) = self.raw(Method::POST, "/api/login", Some(&body)).await?;
            if !status.is_success() {
                return Err(Error::Authentication);
            }
            value
        };
        let csrf = response["csrf"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(Error::Authentication)?;
        *self.csrf.write().await = Some(csrf.to_owned());
        Ok(())
    }

    async fn raw(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<(StatusCode, Value)> {
        // All paths are generated internally; callers never provide arbitrary URLs or HTTP headers.
        let url = self.config.url.join(path).map_err(|_| Error::Invalid)?;
        if url.origin() != self.config.url.origin() {
            return Err(Error::Invalid);
        }
        let mut request = self.client.request(method, url).header(
            header::ORIGIN,
            self.config.url.origin().ascii_serialization(),
        );
        if let Some(csrf) = self.csrf.read().await.as_ref() {
            request = request.header("X-CSRF-Token", csrf);
        }
        if let Some(body) = body {
            if body.to_string().len() > MAX_REQUEST {
                return Err(Error::Input);
            }
            request = request.json(body);
        }
        Self::receive(request.send().await, body.is_some()).await
    }

    async fn receive(
        response: std::result::Result<reqwest::Response, reqwest::Error>,
        write: bool,
    ) -> Result<(StatusCode, Value)> {
        let mut response = response.map_err(|_| {
            if write {
                Error::UnknownWrite
            } else {
                Error::Disconnected
            }
        })?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE as u64)
        {
            return Err(Error::Invalid);
        }
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            if write {
                Error::UnknownWrite
            } else {
                Error::Disconnected
            }
        })? {
            if data.len() + chunk.len() > MAX_RESPONSE {
                return Err(Error::Invalid);
            }
            data.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&data).map_err(|_| {
            if write {
                Error::UnknownWrite
            } else {
                Error::Invalid
            }
        })?;
        Ok((status, value))
    }

    pub(super) async fn get(&self, path: &str) -> Result<Value> {
        self.authenticate().await?;
        let (status, value) = self.raw(Method::GET, path, None).await?;
        if status == StatusCode::UNAUTHORIZED {
            *self.csrf.write().await = None;
            self.authenticate().await?;
            let (status, value) = self.raw(Method::GET, path, None).await?;
            return checked(status, value, false);
        }
        checked(status, value, false)
    }

    pub(super) async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.authenticate().await?;
        let (status, value) = self.raw(Method::POST, path, Some(body)).await?;
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            *self.csrf.write().await = None;
        }
        // Writes are never automatically replayed, even after authentication expires.
        checked(status, value, true)
    }

    pub(super) async fn upload(&self, path: &str, bytes: Vec<u8>) -> Result<Value> {
        self.authenticate().await?;
        if bytes.len() > super::input::MAX_IMAGE_BYTES {
            return Err(Error::Input);
        }
        let url = self.config.url.join(path).map_err(|_| Error::Invalid)?;
        if url.origin() != self.config.url.origin() {
            return Err(Error::Invalid);
        }
        let csrf = self
            .csrf
            .read()
            .await
            .clone()
            .ok_or(Error::Authentication)?;
        let request = self
            .client
            .post(url)
            .header(
                header::ORIGIN,
                self.config.url.origin().ascii_serialization(),
            )
            .header("X-CSRF-Token", csrf)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes);
        let (status, value) = Self::receive(request.send().await, true).await?;
        checked(status, value, true)
    }
}

fn checked(status: StatusCode, value: Value, write: bool) -> Result<Value> {
    if status.is_success() {
        return Ok(value);
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err(Error::Authentication);
    }
    if status == StatusCode::NOT_FOUND {
        return Err(Error::Stale);
    }
    if write && value["code"] != "send_not_submitted" {
        return Err(Error::UnknownWrite);
    }
    Err(Error::Disconnected)
}

#[cfg(test)]
mod response_limit_tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn enlarged_snapshot_budget_still_rejects_an_oversized_declared_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 1024];
            assert!(socket.read(&mut bytes).await.unwrap() > 0);
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        MAX_RESPONSE + 1
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await;
        assert!(matches!(
            Transport::receive(response, false).await,
            Err(Error::Invalid)
        ));
        server.await.unwrap();
    }
}
