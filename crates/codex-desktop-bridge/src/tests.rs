use super::*;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

pub(super) const THREAD: &str = "00000000-0000-4000-8000-000000000001";

fn view(text: &str) -> Value {
    json!({"id": THREAD, "title": "Fixture", "cwd": "C:\\fixture", "connected": true,
        "status": "active", "sequence": 1, "requests": [], "turns": [{"id": "turn-1", "status": "inProgress",
        "startedAt": 1_700_000_000_000u64, "messages": [
            {"id": "u", "kind": "userMessage", "text": "hello"},
            {"id": "a", "kind": "agentMessage", "text": text, "phase": "commentary"},
            {"id": "c", "kind": "commandExecution", "text": "git status", "output": "clean", "exitCode": 0}]}]})
}

#[test]
fn rejects_remote_urls_credentials_queries_and_paths() {
    for url in [
        "https://127.0.0.1:8000",
        "http://localhost:8000",
        "http://example.com",
        "http://127.0.0.1.evil.test",
        "http://u:p@127.0.0.1",
        "http://127.0.0.1/api",
        "http://127.0.0.1/?token=x",
    ] {
        assert!(
            Config::new(url, String::new(), String::new()).is_err(),
            "{url}"
        );
    }
    assert!(Config::new("http://127.0.0.1:8787", String::new(), String::new()).is_ok());
}

#[test]
fn projects_native_ids_text_timing_and_command_output() {
    let thread = projection::thread(&view("working"));
    assert_eq!(thread["id"], THREAD);
    assert_eq!(thread["turns"][0]["id"], "turn-1");
    assert_eq!(thread["turns"][0]["startedAt"], 1_700_000_000.0);
    assert_eq!(
        thread["turns"][0]["items"][0]["content"][0]["text"],
        "hello"
    );
    assert_eq!(thread["turns"][0]["items"][1]["text"], "working");
    assert_eq!(thread["turns"][0]["items"][2]["aggregatedOutput"], "clean");
}

#[tokio::test]
async fn opening_placeholders_never_create_duplicate_turns_on_viewers() {
    let fixture = fixture(false).await;
    let client = client(&fixture).await;
    let mut events = client.subscribe();
    client.accept(&view("initial")).await.unwrap();
    let _ = events.recv().await.unwrap();
    let mut pending = view("initial");
    pending["turns"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"1", "status":"inProgress",
        "messages":[{"id":"opening-None", "kind":"userMessage", "text":"next"}]}));
    client.accept(&pending).await.unwrap();
    assert!(events.try_recv().is_err());
    assert_eq!(
        projection::thread(&pending)["turns"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut native = pending.clone();
    native["turns"][1]["id"] = json!("native-turn");
    native["turns"][1]["messages"][0]["id"] = json!("native-user");
    client.accept(&native).await.unwrap();
    let event = events.recv().await.unwrap();
    assert_eq!(event["params"]["turn"]["id"], "native-turn");
    assert!(events.try_recv().is_err());
    client.close().await;
}

#[test]
fn cached_or_unsupported_approvals_never_become_actionable() {
    let mut state = view("working");
    state["requests"] = json!([{"id": 7, "method": "item/commandExecution/requestApproval",
        "supported": true, "params": {"command": "git status", "availableDecisions": ["accept", "decline"]}},
        {"id": 8, "method": "mcpServer/elicitation/request", "supported": false}]);
    let requests = projection::approvals(&state);
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].original_id, 7);
    assert_eq!(requests[0].event["params"]["turnId"], "turn-1");
    state["connected"] = json!(false);
    assert!(projection::approvals(&state).is_empty());
}

#[tokio::test]
async fn async_questions_outlive_turn_completion_and_submit_through_the_native_gateway() {
    let fixture = fixture(false).await;
    let client = client(&fixture).await;
    let mut state = view("working");
    let native_id = format!("async:{THREAD}:question-item");
    state["requests"] = json!([{"id":native_id, "method":"bridge/requestUserInputAsync",
        "supported":true, "params":{"questions":[{"id":"question", "question":"Choose",
        "options":[{"label":"A"}, {"label":"B"}]}]}}]);
    client.accept(&state).await.unwrap();
    let pending = client.pending().await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["method"], "item/tool/requestUserInput");
    assert!(pending[0]["params"]["turnId"].is_null());
    assert_eq!(
        pending[0]["params"]["questions"][0]["options"][1]["label"],
        "B"
    );
    state["sequence"] = json!(2);
    state["turns"][0]["status"] = json!("completed");
    client.accept(&state).await.unwrap();
    assert_eq!(client.pending().await, pending);
    client
        .respond(json!({"id":pending[0]["id"], "answers":{"question":{"answers":["B"]}}}))
        .await
        .unwrap();
    assert!(client.pending().await.is_empty());
    client.close().await;
}

pub(super) struct Fixture {
    url: String,
    pub(super) sessions: Arc<tokio::sync::Mutex<Vec<Value>>>,
    pub(super) sends: Arc<AtomicUsize>,
    pub(super) posts: Arc<AtomicUsize>,
    pub(super) model_confirmed: Arc<std::sync::atomic::AtomicBool>,
    pub(super) connected: Arc<std::sync::atomic::AtomicBool>,
    pub(super) hydration_reads: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(super) async fn fixture(drop_send: bool) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let sends = Arc::new(AtomicUsize::new(0));
    let posts = Arc::new(AtomicUsize::new(0));
    let send_count = sends.clone();
    let post_count = posts.clone();
    let model = Arc::new(tokio::sync::Mutex::new(Value::Null));
    let model_confirmed = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let confirmation = model_confirmed.clone();
    let connected = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let connection = connected.clone();
    let hydration_reads = Arc::new(AtomicUsize::new(0));
    let hydration = hydration_reads.clone();
    let sessions = Arc::new(tokio::sync::Mutex::new(vec![json!({"id": THREAD,
        "title": "Fixture", "cwd": "C:\\fixture", "recency": 100})]));
    let session_rows = sessions.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let sends = send_count.clone();
            let posts = post_count.clone();
            let model = model.clone();
            let confirmation = confirmation.clone();
            let connected = connection.clone();
            let sessions = session_rows.clone();
            let hydration = hydration.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut chunk = [0; 8192];
                let (header_end, content_length) = loop {
                    let count = socket.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(position) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..position]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .and_then(|s| s.parse::<usize>().ok())
                            .unwrap_or(0);
                        break (position + 4, length);
                    }
                };
                while bytes.len() < header_end + content_length {
                    let count = socket.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                }
                let headers = String::from_utf8_lossy(&bytes[..header_end]).to_lowercase();
                let path = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .to_owned();
                let mut status = "200 OK";
                let mut cookie = "";
                let response = if path == "/api/auth" {
                    json!({"authenticated": false})
                } else if path == "/api/login" {
                    assert!(headers.contains("origin: http://127.0.0.1:"));
                    cookie = "Set-Cookie: cmb=test-only-cookie; Path=/; HttpOnly\r\n";
                    json!({"csrf": "test-only-csrf"})
                } else {
                    assert!(headers.contains("cookie: cmb=test-only-cookie"));
                    if headers.starts_with("post ") {
                        assert!(headers.contains("x-csrf-token: test-only-csrf"));
                        posts.fetch_add(1, Ordering::SeqCst);
                    }
                    if path.contains("/send?") {
                        sends.fetch_add(1, Ordering::SeqCst);
                        let body: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                        assert!(uuid::Uuid::parse_str(body["id"].as_str().unwrap()).is_ok());
                        assert!(body.get("access").is_none() && body.get("model").is_none());
                        if !projection::rows(&body["attachments"]).is_empty() {
                            assert_eq!(projection::rows(&body["attachments"]).len(), 2);
                            assert_eq!(body["text"], "first\n\nsecond");
                        }
                        if drop_send {
                            return;
                        }
                        json!({"status": "accepted", "result": {"turn": {"id": "turn-2", "status": "inProgress", "items": []}}})
                    } else if path.contains("/uploads?") {
                        assert!(headers.contains("content-type: application/octet-stream"));
                        assert!(content_length > 500_000);
                        assert!(bytes[header_end..].starts_with(b"\x89PNG\r\n\x1a\n"));
                        json!({"ok": true})
                    } else if path.contains("/catalog?") {
                        json!({"models":[{"id":"model-a", "name":"Model A", "isDefault":true,
                            "defaultEffort":"high", "efforts":["low","high"]},
                            {"id":"model-b", "name":"Model B", "defaultEffort":"low", "efforts":["low"]}]})
                    } else if path.contains("/settings?") {
                        let body: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                        *model.lock().await = body.clone();
                        json!({"applied":true, "confirmed":confirmation.load(Ordering::SeqCst),
                            "model":body["model"], "effort":body["effort"]})
                    } else if path.contains("/poll?") {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        json!({"state": null})
                    } else if path.starts_with("/api/sessions?") {
                        json!({"sessions": sessions.lock().await.clone()})
                    } else if path.contains("/reconnect?") {
                        connected.store(true, Ordering::SeqCst);
                        status = "409 Conflict";
                        json!({"error":"Acknowledgement deadline elapsed"})
                    } else if path.contains("/respond?") {
                        let body: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                        if body["requestId"]
                            .as_str()
                            .is_some_and(|id| id.starts_with("async:"))
                        {
                            assert_eq!(body["requestId"], format!("async:{THREAD}:question-item"));
                            assert_eq!(body["response"]["answers"]["question"], json!(["B"]));
                        }
                        json!({"ok": true})
                    } else if path.starts_with(&format!("/api/sessions/{THREAD}?")) {
                        let mut state = view("working");
                        if hydration.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| left.checked_sub(1)).is_ok() {
                            state["turns"] = json!([]);
                            state["loadingHistory"] = json!(true);
                        }
                        state["connected"] = json!(connected.load(Ordering::SeqCst));
                        let selected = model.lock().await;
                        if selected.is_object() {
                            state["model"] = selected["model"].clone();
                            state["effort"] = selected["effort"].clone();
                            state["sequence"] = json!(2);
                        }
                        state
                    } else {
                        status = "404 Not Found";
                        json!({"error": "missing"})
                    }
                };
                let body = response.to_string();
                let output = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{cookie}Connection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(output.as_bytes()).await;
            });
        }
    });
    Fixture {
        url,
        sessions,
        sends,
        posts,
        model_confirmed,
        connected,
        hydration_reads,
        task,
    }
}

pub(super) async fn client(fixture: &Fixture) -> Arc<Client> {
    Client::connect(
        Config::new(&fixture.url, "fixture".into(), "not-a-real-password".into()).unwrap(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn authenticated_history_and_sending_keep_native_turn_identity() {
    let fixture = fixture(false).await;
    let client = client(&fixture).await;
    let history = client
        .request(json!({"operation": "read", "threadId": THREAD}))
        .await
        .unwrap();
    assert_eq!(history["thread"]["turns"][0]["id"], "turn-1");
    let result = client
        .request(json!({"operation": "send", "threadId": THREAD, "text": "next"}))
        .await
        .unwrap();
    assert_eq!(result["turn"]["id"], "turn-2");
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 1);
    client.close().await;
}

#[tokio::test]
async fn interrupted_write_is_reported_unknown_and_never_replayed() {
    let fixture = fixture(true).await;
    let client = client(&fixture).await;
    let result = client
        .request(json!({"operation": "send", "threadId": THREAD, "text": "next"}))
        .await;
    assert!(matches!(result, Err(Error::UnknownWrite)));
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 1);
    client.close().await;
}

#[tokio::test]
async fn stale_stop_and_invalid_images_do_not_write() {
    let fixture = fixture(false).await;
    let client = client(&fixture).await;
    assert!(matches!(
        client
            .request(json!({"operation": "interrupt", "threadId": THREAD,
        "turnId": "old-turn"}))
            .await,
        Err(Error::Stale)
    ));
    assert!(matches!(
        client
            .request(json!({"operation": "send", "threadId": THREAD,
        "text": "hello", "images": ["data:image/png;base64,AAAA"]}))
            .await,
        Err(Error::Input)
    ));
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 0);
    client.close().await;
}

#[tokio::test]
async fn normalized_batch_uploads_images_as_binary_then_submits_once() {
    use base64::Engine;
    let fixture = fixture(false).await;
    let client = client(&fixture).await;
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.resize(600_000, 0);
    let url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    let result = client
        .request(json!({"operation":"send", "threadId":THREAD, "input":[
            {"type":"text", "text":"first"}, {"type":"image", "url":url},
            {"type":"text", "text":"second"}, {"type":"image", "url":url}
        ]}))
        .await
        .unwrap();
    assert_eq!(result["turn"]["id"], "turn-2");
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 3);
    client.close().await;
}

#[test]
fn official_membership_is_separate_from_the_execution_directory() {
    let mut state = view("working");
    state["project_id"] = json!("official-project");
    state["projectName"] = json!("My project");
    state["recency"] = json!(200.0);
    state["updated_at"] = json!(100.0);
    let thread = projection::thread(&state);
    assert_eq!(thread["officialSidebar"]["projectId"], "official-project");
    assert_eq!(thread["officialSidebar"]["projectName"], "My project");
    assert_eq!(thread["cwd"], "C:\\fixture");
    assert_eq!(thread["updatedAt"], 200.0);
}

#[tokio::test]
async fn updates_and_resolved_approvals_reach_all_viewers() {
    let fixture = fixture(false).await;
    let client = client(&fixture).await;
    let mut computer = client.subscribe();
    let mut phone = client.subscribe();
    client.accept(&view("first")).await.unwrap();
    assert_eq!(computer.recv().await.unwrap()["method"], "thread/started");
    assert_eq!(phone.recv().await.unwrap()["method"], "thread/started");
    let mut state = view("first and second");
    state["requests"] = json!([{"id": 7, "method": "item/commandExecution/requestApproval",
        "supported": true, "params": {"command": "git status"}}]);
    client.accept(&state).await.unwrap();
    let update = computer.recv().await.unwrap();
    assert_eq!(update, phone.recv().await.unwrap());
    assert_eq!(update["method"], "item/agentMessage/delta");
    assert_eq!(update["params"]["delta"], " and second");
    let approval = computer.recv().await.unwrap();
    assert_eq!(approval, phone.recv().await.unwrap());
    client
        .respond(json!({"id": approval["id"], "decision": "accept"}))
        .await
        .unwrap();
    assert_eq!(
        computer.recv().await.unwrap()["method"],
        "serverRequest/resolved"
    );
    assert_eq!(
        phone.recv().await.unwrap()["method"],
        "serverRequest/resolved"
    );
    assert!(client.pending().await.is_empty());
    client.close().await;
}

#[tokio::test]
async fn live_snapshots_keep_authoritative_list_labels_and_ignore_old_revisions() {
    let fixture = fixture(false).await;
    let client = client(&fixture).await;
    client.metadata.lock().await.insert(
        THREAD.into(),
        json!({"title": "Listed title", "cwd": "C:\\project"}),
    );
    let mut state = view("newest");
    state["title"] = json!("gateway fallback");
    state["cwd"] = Value::Null;
    state["sequence"] = json!(10);
    client.accept(&state).await.unwrap();
    let stored = client.snapshots.lock().await[THREAD].clone();
    assert_eq!(stored["title"], "Listed title");
    assert_eq!(stored["cwd"], "C:\\project");
    client.accept(&view("older")).await.unwrap();
    assert_eq!(client.snapshots.lock().await[THREAD]["sequence"], 10);
    client.close().await;
}
