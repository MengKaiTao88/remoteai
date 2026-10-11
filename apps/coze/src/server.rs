use crate::{
    api::{self, Services},
    error::{ApiError, Error, Result},
    mcp,
};
use serde_json::Value;
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const MAX_REQUEST: u64 = 48 * 1024 * 1024;
const WORKERS: usize = 8;

pub struct Host {
    pub server: Arc<Server>,
    pub url: String,
    token: String,
    assets: PathBuf,
}

impl Host {
    pub fn bind(token: String, assets: PathBuf) -> Result<Self> {
        if token.len() < 32 {
            return Err(Error::Unauthorized);
        }
        let server = Server::http(("127.0.0.1", 0)).map_err(|_| Error::Network)?;
        let address = server.server_addr().to_ip().ok_or(Error::Network)?;
        Ok(Self {
            server: Arc::new(server),
            url: format!("http://{address}"),
            token,
            assets,
        })
    }

    pub fn run(self: Arc<Self>, services: Arc<Services>) -> Result<()> {
        let (sender, receiver) = mpsc::sync_channel::<Request>(16);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..WORKERS {
            let (host, services, receiver) = (self.clone(), services.clone(), receiver.clone());
            thread::Builder::new()
                .name(format!("coze-worker-{index}"))
                .spawn(move || loop {
                    let request = match receiver.lock() {
                        Ok(receiver) => receiver.recv(),
                        Err(_) => return,
                    };
                    match request {
                        Ok(request) => host.handle(&services, request),
                        Err(_) => break,
                    }
                })?;
        }
        for request in self.server.incoming_requests() {
            if request.url() == "/health" {
                respond(
                    request,
                    200,
                    b"{\"ready\":true}".to_vec(),
                    "application/json",
                );
                continue;
            }
            if let Err(error) = sender.try_send(request) {
                match error {
                    mpsc::TrySendError::Full(request)
                    | mpsc::TrySendError::Disconnected(request) => {
                        respond(request, 503, b"Busy".to_vec(), "text/plain")
                    }
                }
            }
        }
        Ok(())
    }

    fn handle(&self, services: &Services, mut request: Request) {
        let path = request.url().split('?').next().unwrap_or("");
        if request.method() == &Method::Get && !matches!(path, "/api" | "/mcp") {
            let result = asset(&self.assets, path);
            match result {
                Ok((bytes, mime)) => respond(request, 200, bytes, mime),
                Err(_) => respond(request, 404, b"Not found".to_vec(), "text/plain"),
            }
            return;
        }
        let result = self.authorize(&request).and_then(|()| {
            let mcp = request.url() == "/mcp";
            if request.method() != &Method::Post || (!mcp && request.url() != "/api") {
                return Err(Error::Invalid);
            }
            let mut bytes = Vec::new();
            request
                .as_reader()
                .take(MAX_REQUEST + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_REQUEST {
                return Err(Error::Limit);
            }
            if mcp {
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Invalid)?;
                Ok(mcp::dispatch(services, &value).unwrap_or(Value::Null))
            } else {
                let command = serde_json::from_slice(&bytes).map_err(|_| Error::Invalid)?;
                api::dispatch(services, command)
            }
        });
        match result {
            Ok(value) => respond(
                request,
                200,
                value.to_string().into_bytes(),
                "application/json",
            ),
            Err(error) => {
                eprintln!("Coze request failed: {error:?}");
                let body = serde_json::to_vec(&ApiError {
                    error: error.to_string(),
                })
                .unwrap_or_default();
                respond(request, error.status(), body, "application/json");
            }
        }
    }

    fn authorize(&self, request: &Request) -> Result<()> {
        let header = |name: &'static str| {
            request
                .headers()
                .iter()
                .find(|header| header.field.equiv(name))
                .map(|header| header.value.as_str())
        };
        if header("Origin").is_some_and(|origin| origin != self.url) {
            return Err(Error::Unauthorized);
        }
        let expected = format!("Bearer {}", self.token);
        let actual = header("Authorization").unwrap_or_default().as_bytes();
        if actual.len() != expected.len() {
            return Err(Error::Unauthorized);
        }
        let different = actual
            .iter()
            .zip(expected.bytes())
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b));
        if different != 0 {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
}

fn respond(request: Request, status: u16, body: Vec<u8>, mime: &str) {
    let mut response = Response::from_data(body).with_status_code(StatusCode(status));
    for (key, value) in [("Content-Type", mime), ("X-Content-Type-Options", "nosniff"),
        ("Cache-Control", "no-store"), ("Referrer-Policy", "no-referrer"),
        ("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
            img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'")] {
        if let Ok(header) = Header::from_bytes(key, value) { response.add_header(header); }
    }
    if let Err(error) = request.respond(response) {
        eprintln!("Coze client disconnected: {error}");
    }
}

fn asset(root: &Path, path: &str) -> Result<(Vec<u8>, &'static str)> {
    let relative = path.trim_start_matches('/');
    if relative.contains('\\')
        || relative.contains('%')
        || relative.split('/').any(|part| part == "..")
    {
        return Err(Error::Invalid);
    }
    let path = root
        .join(if relative.is_empty() {
            "index.html"
        } else {
            relative
        })
        .canonicalize()?;
    if !path.starts_with(root.canonicalize()?) {
        return Err(Error::Invalid);
    }
    let mime = match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    };
    Ok((std::fs::read(path)?, mime))
}
