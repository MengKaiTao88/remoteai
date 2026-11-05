//! Read-only compatibility with Desktop's project metadata before app-server migration completes.
use serde_json::{json, Value};
use std::{io::Read, path::PathBuf};

const MAX_STATE_BYTES: u64 = 8 * 1024 * 1024;

pub(super) async fn apply(response: &mut Value) {
    if !response["data"].is_array()
        && !response["thread"].is_object()
        && !response["params"]["thread"].is_object()
    {
        return;
    }
    let snapshot = tauri::async_runtime::spawn_blocking(read_snapshot).await;
    let Ok(Some(snapshot)) = snapshot else {
        return;
    };
    decorate(response, &snapshot);
}

fn read_snapshot() -> Option<Value> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))?;
    let file = std::fs::File::open(home.join(".codex-global-state.json")).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn decorate(response: &mut Value, snapshot: &Value) {
    if let Some(threads) = response["data"].as_array_mut() {
        for thread in threads {
            decorate_thread(thread, snapshot);
        }
    }
    if response["thread"].is_object() {
        decorate_thread(&mut response["thread"], snapshot);
    }
    if response["params"]["thread"].is_object() {
        decorate_thread(&mut response["params"]["thread"], snapshot);
    }
}

fn decorate_thread(thread: &mut Value, snapshot: &Value) {
    let Some(id) = thread["id"].as_str() else {
        return;
    };
    let projectless = snapshot["projectless-thread-ids"]
        .as_array()
        .is_some_and(|rows| rows.iter().any(|row| row.as_str() == Some(id)));
    let assignment = &snapshot["thread-project-assignments"][id];
    let project_id = assignment["projectId"].as_str();
    let Some(project_id) = project_id.filter(|_| !projectless) else {
        if projectless {
            thread["officialSidebar"]["projectId"] = Value::Null;
        }
        return;
    };
    let project = &snapshot["local-projects"][project_id];
    let Some(name) = project["name"].as_str() else {
        return;
    };
    let order = snapshot["project-order"]
        .as_array()
        .and_then(|rows| rows.iter().position(|row| row.as_str() == Some(project_id)))
        .unwrap_or(1_000_000);
    thread["officialSidebar"]["projectId"] = json!(project_id);
    thread["officialSidebar"]["projectName"] = json!(name);
    thread["officialSidebar"]["projectOrder"] = json!(order);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_membership_overlays_runtime_metadata_without_rewriting_execution_paths() {
        let state = json!({"local-projects":{"project":{"name":"Official project"}},
            "thread-project-assignments":{"assigned":{"projectId":"project"},"loose":{"projectId":"project"}},
            "projectless-thread-ids":["loose"],"project-order":["project"]});
        let mut result = json!({"data":[
            {"id":"assigned","cwd":"C:/work","officialSidebar":{"projectId":null}},
            {"id":"loose","cwd":"C:/work","officialSidebar":{"projectId":null}}
        ]});
        decorate(&mut result, &state);
        assert_eq!(
            result["data"][0]["officialSidebar"]["projectName"],
            "Official project"
        );
        assert_eq!(result["data"][0]["officialSidebar"]["projectOrder"], 0);
        assert_eq!(result["data"][0]["cwd"], "C:/work");
        assert!(result["data"][1]["officialSidebar"]["projectId"].is_null());
    }
}
