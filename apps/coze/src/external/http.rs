use crate::{
    api::Services,
    collaboration_access::{self, Principal, Role},
    error::{Error, Result},
    mcp,
    server::respond,
};
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
};
use tiny_http::{Method, Request, Server};

const MAX_BODY: u64 = 1024 * 1024;
const VERSIONS: [&str; 3] = ["2025-03-26", "2025-06-18", "2025-11-25"];

pub(super) fn serve(
    services: Services,
    server: Arc<Server>,
    stopped: Arc<AtomicBool>,
) -> Result<()> {
    let (sender, receiver) = mpsc::sync_channel::<Request>(16);
    let receiver = Arc::new(Mutex::new(receiver));
    for index in 0..4 {
        let (services, receiver, stopped) = (services.clone(), receiver.clone(), stopped.clone());
        thread::Builder::new()
            .name(format!("coze-tools-{index}"))
            .spawn(move || loop {
                let request = match receiver.lock() {
                    Ok(queue) => queue.recv(),
                    Err(_) => return,
                };
                let Ok(request) = request else {
                    return;
                };
                if stopped.load(Ordering::Acquire) {
                    reply(request, 503, json!({"error":"工具调用已暂停。"}));
                } else {
                    handle(&services, request);
                }
            })?;
    }
    thread::Builder::new()
        .name("coze-tool-listener".into())
        .spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let Ok(request) = server.recv() else {
                    break;
                };
                if let Err(error) = sender.try_send(request) {
                    let request = match error {
                        mpsc::TrySendError::Full(r) | mpsc::TrySendError::Disconnected(r) => r,
                    };
                    reply(
                        request,
                        503,
                        json!({"error":"正在处理较多请求，请稍后重试。"}),
                    );
                }
            }
        })?;
    Ok(())
}

fn header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|value| value.field.equiv(name))
        .map(|value| value.value.as_str())
}

fn authenticate(services: &Services, request: &Request) -> Result<Services> {
    let token = header(request, "Authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or(Error::Unauthorized)?;
    let principal = collaboration_access::authenticate(&services.db, token)?;
    if !matches!(&principal, Principal::Shared(grant) if grant.role == Role::Tool) {
        return Err(Error::Unauthorized);
    }
    Ok(collaboration_access::scoped(services, principal))
}

fn handle(services: &Services, mut request: Request) {
    // This endpoint is for authenticated clients, not cross-origin browser pages.
    if header(&request, "Origin").is_some() {
        reply(request, 403, json!({"error":"不允许此网页访问。"}));
        return;
    }
    let services = match authenticate(services, &request) {
        Ok(value) => value,
        Err(error) => {
            reply(request, error.status(), json!({"error":error.to_string()}));
            return;
        }
    };
    if !matches!(request.url(), "/mcp" | "/api/run" | "/api/resume") {
        reply(request, 404, json!({"error":"未找到接口。"}));
        return;
    }
    if request.method() != &Method::Post {
        reply(request, 405, json!({"error":"请使用 POST 请求。"}));
        return;
    }
    if header(&request, "MCP-Protocol-Version").is_some_and(|version| !VERSIONS.contains(&version))
    {
        reply(request, 400, json!({"error":"不支持此协议版本。"}));
        return;
    }
    let result = execute(&services, &mut request);
    match result {
        Ok(Some(value)) => reply(request, 200, value),
        Ok(None) => respond(request, 202, vec![], "application/json"),
        Err(error) => reply(request, error.status(), json!({"error":error.to_string()})),
    }
}

fn execute(services: &Services, request: &mut Request) -> Result<Option<Value>> {
    let _lease = services.maintenance.read().map_err(|_| Error::Conflict)?;
    let mut bytes = Vec::new();
    request
        .as_reader()
        .take(MAX_BODY + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BODY {
        return Err(Error::Limit);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Invalid)?;
    if !body.is_object() {
        return Err(Error::Invalid);
    }
    if request.url() != "/mcp" {
        return invoke(services, request.url(), body).map(Some);
    }
    if body["jsonrpc"] != "2.0" {
        return Err(Error::Invalid);
    }
    if body.get("id").is_none() {
        return if body["method"] == "notifications/initialized" {
            Ok(None)
        } else {
            Err(Error::Invalid)
        };
    }
    let mut response = mcp::dispatch(services, &body).ok_or(Error::Invalid)?;
    if body["method"] == "initialize" && response.get("result").is_some() {
        let requested = body["params"]["protocolVersion"]
            .as_str()
            .unwrap_or_default();
        response["result"]["protocolVersion"] = json!(if VERSIONS.contains(&requested) {
            requested
        } else {
            VERSIONS[2]
        });
    }
    Ok(Some(response))
}

fn invoke(services: &Services, path: &str, mut arguments: Value) -> Result<Value> {
    let Principal::Shared(grant) = &services.principal else {
        return Err(Error::Unauthorized);
    };
    let name = if path == "/api/resume" {
        "coze_resume"
    } else {
        "coze_call"
    };
    if name == "coze_call" {
        if arguments
            .get("resource_id")
            .is_some_and(|id| id != &grant.app_id)
        {
            return Err(Error::Unauthorized);
        }
        arguments["resource_id"] = json!(grant.app_id);
    }
    let response = mcp::dispatch(
        services,
        &json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
        "params":{"name":name,"arguments":arguments}}),
    )
    .ok_or(Error::Invalid)?;
    if response.get("error").is_some() {
        return Err(Error::Unauthorized);
    }
    let text = response
        .pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .ok_or(Error::Invalid)?;
    if response["result"]["isError"] == true {
        return Err(Error::Invalid);
    }
    serde_json::from_str(text).map_err(|_| Error::Invalid)
}

fn reply(request: Request, status: u16, value: Value) {
    respond(
        request,
        status,
        value.to_string().into_bytes(),
        "application/json",
    );
}
