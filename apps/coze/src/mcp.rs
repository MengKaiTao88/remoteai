use crate::{
    agents,
    api::Services,
    error::{Error, Result},
    knowledge,
    model::ResourceKind,
    resources, workflow,
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::Path,
    time::Duration,
};

const PROTOCOL: &str = "2024-11-05";

pub fn dispatch(services: &Services, request: &Value) -> Option<Value> {
    let id = request.get("id")?;
    let result = crate::collaboration_access::authorize_mcp(services, request).and_then(|permit| {
        let response = dispatch_inner(services, request).unwrap_or(Value::Null);
        permit.finish_mcp(services, response)
    });
    Some(result.unwrap_or_else(|error| {
        json!({"jsonrpc":"2.0","id":id,
        "error":{"code":-32001,"message":error.to_string()}})
    }))
}

fn dispatch_inner(services: &Services, request: &Value) -> Option<Value> {
    let id = request.get("id")?;
    let result = match request["method"].as_str() {
        Some("initialize") => Ok(
            json!({"protocolVersion":PROTOCOL,"capabilities":{"tools":{}},
            "serverInfo":{"name":"remoteai-coze","version":env!("CARGO_PKG_VERSION")}}),
        ),
        Some("ping") => Ok(json!({})),
        Some("tools/list") => tools(services),
        Some("tools/call") => Ok(match call(services, &request["params"]) {
            Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
            Err(error) => {
                json!({"isError":true,"content":[{"type":"text","text":error.to_string()}]})
            }
        }),
        _ => {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unknown method"}}),
            )
        }
    };
    Some(match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err(error) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":error.to_string()}})
        }
    })
}

fn tools(_services: &Services) -> Result<Value> {
    // Stable tools make newly published resources immediately callable in an existing GUI session.
    Ok(json!({"tools":[
        {"name":"coze_list","description":"List the user's published Coze workflows, agents and knowledge bases. \
            Call this first to discover resource IDs and descriptions.",
            "inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"coze_call","description":"Run a published Coze resource discovered with coze_list. \
            Workflows take input, agents take message, knowledge bases take query. \
            This can execute user-defined workflows with external effects; inspect the description before calling.",
            "inputSchema":{"type":"object","properties":{"resource_id":{"type":"string"},
                "input":{"type":"object"},"message":{"type":"string"},"query":{"type":"string"},
                "conversation_id":{"type":"string"}},
                "required":["resource_id"],"additionalProperties":false}},
        {"name":"coze_resume","description":"Resume a paused published Coze Chatflow with the user's answer. \
            Use run_id and interaction.id from a paused coze_call result and provide its requested input fields.",
            "inputSchema":{"type":"object","properties":{"run_id":{"type":"string"},
                "interaction_id":{"type":"string"},"input":{"type":"object"}},
                "required":["run_id","interaction_id","input"],"additionalProperties":false}}
    ]}))
}

fn call(services: &Services, params: &Value) -> Result<Value> {
    let name = params["name"].as_str().ok_or(Error::Invalid)?;
    if name == "coze_list" {
        return list_published(services);
    }
    if name == "coze_resume" {
        let args = &params["arguments"];
        let request = serde_json::from_value(json!({"runId":args["run_id"],"input":args["input"],
            "interactionId":args["interaction_id"]}))
        .map_err(|_| Error::Invalid)?;
        return workflow::resume_published(services, request);
    }
    if name != "coze_call" {
        return Err(Error::Invalid);
    }
    let args = &params["arguments"];
    let id = args["resource_id"]
        .as_str()
        .ok_or(Error::Invalid)?
        .to_owned();
    let resource = resources::get(&services.db, &id)?;
    if !resource.mcp_enabled || resource.published_revision.is_none() {
        return Err(Error::Unpublished);
    }
    match resource.kind {
        ResourceKind::App => crate::projects::run(
            services,
            crate::projects::AppRun {
                app_id: id,
                input: args.get("input").cloned().unwrap_or_else(|| json!({})),
                message: args["message"].as_str().unwrap_or_default().to_owned(),
                conversation_id: args["conversation_id"].as_str().map(str::to_owned),
                published: true,
            },
        ),
        ResourceKind::Plugin => crate::plugins::invoke(
            &services.db,
            &id,
            args.get("input")
                .filter(|input| input.is_object())
                .ok_or(Error::Invalid)?
                .clone(),
            true,
        ),
        ResourceKind::Workflow => workflow::run(
            services,
            workflow::RunRequest {
                resource_id: id,
                input: args
                    .get("input")
                    .filter(|value| value.is_object())
                    .ok_or(Error::Invalid)?
                    .clone(),
                published: true,
            },
        )
        .and_then(|run| {
            if run["status"] == "completed" || run["status"] == "paused" {
                Ok(run)
            } else {
                Err(Error::Workflow)
            }
        }),
        ResourceKind::Agent => agents::chat(
            services,
            agents::ChatRequest {
                agent_id: id,
                conversation_id: args["conversation_id"].as_str().map(str::to_owned),
                message: args["message"].as_str().ok_or(Error::Invalid)?.to_owned(),
                published: true,
            },
        ),
        ResourceKind::Knowledge => Ok(json!(knowledge::search(
            &services.db,
            services.embedder.as_ref(),
            knowledge::SearchRequest {
                knowledge_ids: vec![id],
                query: args["query"].as_str().ok_or(Error::Invalid)?.to_owned(),
                limit: 6
            }
        )?)),
        ResourceKind::Table => crate::tables::query(
            &services.db,
            &id,
            args.get("input")
                .and_then(|input| input.get("filter"))
                .unwrap_or(&json!({})),
        ),
        ResourceKind::Prompt => {
            let (_, body) = resources::published(&services.db, &id)?;
            let context = json!({"input":args.get("input").cloned().unwrap_or_else(|| json!({}))});
            Ok(
                json!({"text":workflow::bindings::render(body["text"].as_str().ok_or(Error::Invalid)?, &context)?}),
            )
        }
    }
}

fn list_published(services: &Services) -> Result<Value> {
    let mut entries = Vec::new();
    for resource in resources::list(&services.db)? {
        if !services.principal.allows(&resource.id)
            || !resource.mcp_enabled
            || resource.published_revision.is_none()
        {
            continue;
        }
        let mut entry = json!({"id":resource.id,"name":resource.name,"kind":resource.kind,
            "description":resource.description});
        if resource.kind == ResourceKind::Workflow {
            let (_, body) = resources::published(&services.db, &resource.id)?;
            let graph: workflow::Graph =
                serde_json::from_value(body).map_err(|_| Error::Workflow)?;
            entry["inputSchema"] = workflow::schema(&graph);
        }
        entries.push(entry);
    }
    Ok(json!(entries))
}

/// STDIO helpers connect to the app-owned runtime and write protocol frames only to stdout.
pub fn run_stdio(state_file: &Path) -> Result<()> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(330))
        .build()
        .map_err(|_| Error::Network)?;
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut line = String::new();
        if std::io::Read::take(&mut input, 1024 * 1024 + 1).read_line(&mut line)? == 0 {
            break;
        }
        if line.len() > 1024 * 1024 {
            return Err(Error::Limit);
        }
        let request: Value = serde_json::from_str(&line).map_err(|_| Error::Invalid)?;
        if request.get("id").is_none() {
            continue;
        }
        let response = forward_stdio(&client, state_file, &request).unwrap_or_else(|error|
            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32603,"message":error.to_string()}}));
        serde_json::to_writer(&mut output, &response).map_err(|_| Error::Invalid)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}

fn forward_stdio(
    client: &reqwest::blocking::Client,
    state_file: &Path,
    request: &Value,
) -> Result<Value> {
    use std::io::Read;
    // Re-read the app lease for every call so an existing GUI session survives a Coze restart.
    let mut bytes = Vec::new();
    std::fs::File::open(state_file)?
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 {
        return Err(Error::Unauthorized);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Unauthorized)?;
    let address = value["url"].as_str().ok_or(Error::Unauthorized)?;
    let token = value["token"].as_str().ok_or(Error::Unauthorized)?;
    let url = url::Url::parse(address).map_err(|_| Error::Unauthorized)?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::Unauthorized);
    }
    let response = client
        .post(format!("{}/mcp", address.trim_end_matches('/')))
        .bearer_auth(token)
        .json(request)
        .send()
        .map_err(|_| Error::Network)?
        .error_for_status()
        .map_err(|_| Error::Network)?;
    bytes.clear();
    response
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Network)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(Error::Limit);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Network)
}
