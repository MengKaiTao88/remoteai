use serde_json::{json, Value};

#[derive(Clone)]
pub(super) struct Approval {
    pub thread_id: String,
    pub original_id: Value,
    pub event: Value,
}

pub(super) fn rows(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

pub(super) fn provisional(turn: &Value) -> bool {
    // The owner briefly publishes numeric turn IDs with an opening-* placeholder before native IDs arrive.
    rows(&turn["messages"]).iter().any(|message| {
        message["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("opening-"))
    })
}

pub(super) fn thread(view: &Value) -> Value {
    let turns: Vec<Value> = rows(&view["turns"])
        .iter()
        .filter(|turn| !provisional(turn))
        .map(turn)
        .collect();
    let preview = turns
        .iter()
        .flat_map(|t| rows(&t["items"]))
        .find(|item| item["type"] == "userMessage")
        .and_then(|item| item["content"][0]["text"].as_str())
        .unwrap_or_default();
    json!({"id": view["id"], "name": view["title"], "preview": preview,
        "cwd": view["cwd"].as_str().unwrap_or_default(), "updatedAt": view["recency"].as_f64()
            .or_else(|| view["updated_at"].as_f64()).unwrap_or(0.0),
        "officialSidebar": {"projectId": view["project_id"], "projectName": view["projectName"],
            "pinned": view["is_pinned"] == true || view["is_pinned"] == 1},
        "status": {"type": if view["connected"] == false { "notLoaded" }
            else { view["status"].as_str().unwrap_or("idle") }}, "turns": turns})
}

pub(super) fn turn(view: &Value) -> Value {
    let items: Vec<Value> = rows(&view["messages"]).iter().map(item).collect();
    json!({"id": view["id"], "status": view["status"].as_str().unwrap_or("completed"),
        "startedAt": view["startedAt"].as_f64().map(|ms| ms / 1000.0),
        "items": items, "error": view["error"], "diff": view["diff"]})
}

fn item(row: &Value) -> Value {
    let text = row["text"].as_str().unwrap_or_default();
    let mut value = json!({"id": row["id"], "type": row["kind"], "status": row["status"]});
    match row["kind"].as_str().unwrap_or_default() {
        "userMessage" | "steeringUserMessage" => {
            value["type"] = json!("userMessage");
            value["content"] = json!([{"type": "text", "text": text}]);
            if let Some(content) = value["content"].as_array_mut() {
                for attachment in rows(&row["attachments"]) {
                    if let Some(source) = super::images::source(attachment) {
                        content.push(json!({"type":"localImage", "path":source}));
                    }
                }
            }
        }
        "agentMessage" | "assistantMessage" | "planImplementation" => {
            value["type"] = json!("agentMessage");
            value["text"] = json!(text);
            value["phase"] = row["phase"].clone();
        }
        "reasoning" => value["summary"] = json!([text]),
        "commandExecution" => {
            value["command"] = json!(text);
            value["aggregatedOutput"] = row["output"].clone();
            value["exitCode"] = row["exitCode"].clone();
        }
        _ => {
            // The gateway normalizes tool bodies. Keep their full readable evidence available on demand.
            value["type"] = json!("dynamicToolCall");
            value["tool"] = row["title"].clone();
            value["arguments"] = json!(text);
            value["output"] = row["output"].clone();
            value["contentItems"] = json!([{"type": "inputText", "text": format!("{}\n{}", text,
                row["output"].as_str().unwrap_or_default())}]);
            value["success"] = json!(row["role"] != "error");
        }
    }
    value
}

pub(super) fn approvals(view: &Value) -> Vec<Approval> {
    if view["connected"] != true {
        return Vec::new();
    }
    rows(&view["requests"])
        .iter()
        .filter_map(|request| {
            let method = request["method"].as_str()?;
            if request["supported"] != true
                || !matches!(
                    method,
                    "item/commandExecution/requestApproval"
                        | "item/fileChange/requestApproval"
                        | "item/permissions/requestApproval"
                        | "item/tool/requestUserInput"
                        | "tool/requestUserInput"
                )
            {
                return None;
            }
            let thread_id = view["id"].as_str()?.to_owned();
            let original_id = request["id"].clone();
            if !original_id.is_string() && !original_id.is_number() {
                return None;
            }
            let id = format!("bridge:{}:{}", thread_id, original_id);
            let mut params = request["params"].clone();
            params["threadId"] = json!(thread_id);
            params["turnId"] = rows(&view["turns"])
                .iter()
                .rev()
                .find(|turn| turn["status"] == "inProgress")
                .map(|turn| turn["id"].clone())
                .unwrap_or(Value::Null);
            Some(Approval {
                thread_id,
                original_id,
                event: json!({"id": id, "method": if method == "tool/requestUserInput" {
                "item/tool/requestUserInput" } else { method }, "params": params}),
            })
        })
        .collect()
}
