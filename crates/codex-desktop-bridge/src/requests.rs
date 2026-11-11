use super::{projection, thread_id, Client, Error, Result};
use serde_json::{json, Value};
use std::sync::Arc;

const ATTACH_RECOVERY_ATTEMPTS: usize = 40;
const ATTACH_RECOVERY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

impl Client {
    /// Closed chat operation set. No native RPC, arbitrary URL or filesystem proxy is exposed.
    pub async fn request(self: &Arc<Self>, request: Value) -> Result<Value> {
        match request["operation"].as_str().ok_or(Error::Invalid)? {
            "models" => self.models(&request).await,
            "skills" => Ok(json!({"data": []})),
            "plugins" => Ok(json!({"data": []})),
            "list" => self.list(&request).await,
            "read" => self.read(thread_id(&request)?).await,
            "imagePreview" => self.image_preview(&request).await,
            "resume" => self.resume(thread_id(&request)?).await,
            "send" | "steer" => self.send(&request).await,
            "interrupt" => self.interrupt(&request).await,
            "toolDetails" => self.tool_details(&request).await,
            "rename" => self.rename(&request).await,
            _ => Err(Error::Unsupported),
        }
    }

    async fn list(&self, request: &Value) -> Result<Value> {
        let offset = request["cursor"]
            .as_str()
            .unwrap_or("0")
            .parse::<usize>()
            .map_err(|_| Error::Invalid)?;
        if offset > 100_000 {
            return Err(Error::Invalid);
        }
        let limit = request["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize;
        let mut url =
            reqwest::Url::parse("http://127.0.0.1/api/sessions").map_err(|_| Error::Invalid)?;
        url.query_pairs_mut()
            .append_pair("scope", "host")
            .append_pair("host", "local")
            .append_pair("source", "desktop")
            .append_pair(
                "archived",
                if request["archived"] == true {
                    "true"
                } else {
                    "false"
                },
            )
            .append_pair("offset", &offset.to_string())
            .append_pair("q", request["search"].as_str().unwrap_or_default());
        let result = self
            .http
            .get(&format!(
                "{}?{}",
                url.path(),
                url.query().unwrap_or_default()
            ))
            .await?;
        let source = projection::rows(&result["sessions"]);
        {
            let mut metadata = self.metadata.lock().await;
            for row in source {
                if let Some(id) = row["id"].as_str() {
                    metadata.insert(id.to_owned(), row.clone());
                }
            }
        }
        let data: Vec<Value> = source
            .iter()
            // The gateway's host-scoped endpoint returns a cumulative prefix for this offset.
            .skip(offset)
            .take(limit)
            .map(|row| {
                let mut thread = projection::thread(row);
                if let Some(object) = thread.as_object_mut() {
                    object.remove("turns");
                }
                thread
            })
            .collect();
        Ok(
            json!({"data": data, "nextCursor": if source.len() > offset + limit {
            Some((offset + limit).to_string()) } else { None }}),
        )
    }

    pub(super) async fn read(self: &Arc<Self>, id: &str) -> Result<Value> {
        let mut view = self
            .http
            .get(&format!("/api/sessions/{id}?host=local"))
            .await?;
        // The gateway starts saved-history hydration asynchronously. An empty initial
        // snapshot is not the result of a completed read, and must not become a blank chat.
        for _ in 0..ATTACH_RECOVERY_ATTEMPTS {
            if !projection::rows(&view["turns"]).is_empty()
                || (view["loadingHistory"] != true && view["connecting"] != true)
            {
                break;
            }
            tokio::time::sleep(ATTACH_RECOVERY_INTERVAL).await;
            view = self.http.get(&format!("/api/sessions/{id}?host=local")).await?;
        }
        let view = self.with_metadata(view).await;
        self.accept(&view).await?;
        self.watch(id).await?;
        Ok(json!({"thread": projection::thread(&view)}))
    }

    async fn resume(self: &Arc<Self>, id: &str) -> Result<Value> {
        let path = format!("/api/sessions/{id}?host=local");
        if self.http.get(&path).await?["connected"] == true {
            return self.read(id).await;
        }
        // Opening/continuing is explicit. Background history/watch requests never activate the app.
        let attach = self
            .http
            .post(
                &format!("/api/sessions/{id}/reconnect?host=local"),
                &json!({"activate": true}),
            )
            .await;
        // The owner may attach just after the gateway's acknowledgement deadline.
        // Read its state without replaying the activation request or any message.
        for _ in 0..ATTACH_RECOVERY_ATTEMPTS {
            if self.http.get(&path).await?["connected"] == true {
                return self.read(id).await;
            }
            tokio::time::sleep(ATTACH_RECOVERY_INTERVAL).await;
        }
        attach?;
        Err(Error::Disconnected)
    }

    async fn send(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let _write = self.writes.lock().await;
        let id = thread_id(request)?;
        let input = super::input::prepare(request).await?;
        let before = self
            .http
            .get(&format!("/api/sessions/{id}?host=local"))
            .await?;
        if before["connected"] != true {
            return Err(Error::Disconnected);
        }
        let active = projection::rows(&before["turns"])
            .iter()
            .rev()
            .find(|turn| turn["status"] == "inProgress");
        if request["operation"] == "steer" && active.map(|t| &t["id"]) != Some(&request["turnId"]) {
            return Err(Error::Stale);
        }
        if request["operation"] == "send" {
            self.apply_send_model(request, &before).await?;
        }
        let submission = request["submissionId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        uuid::Uuid::parse_str(&submission).map_err(|_| Error::Invalid)?;
        let mut attachments = Vec::new();
        for image in input.images {
            let upload_id = uuid::Uuid::new_v4().to_string();
            self.http
                .upload(
                    &format!(
                        "/api/sessions/{id}/uploads?host=local&id={upload_id}&name={}",
                        image.name
                    ),
                    image.bytes,
                )
                .await?;
            attachments.push(upload_id);
        }
        let body = json!({"id": submission, "text": input.text, "attachments": attachments,
            "mode": if request["operation"] == "steer" { "steer" } else { "send" }});
        let result = self
            .http
            .post(&format!("/api/sessions/{id}/send?host=local"), &body)
            .await?;
        if result["status"] != "accepted" {
            return Err(Error::UnknownWrite);
        }
        self.watch(id).await?;
        let turn = self.confirm_turn(id, &submission, &result).await?;
        Ok(json!({"turn": turn, "submissionId": submission, "accepted": true}))
    }

    async fn confirm_turn(&self, id: &str, submission: &str, result: &Value) -> Result<Value> {
        // IPC acceptance can precede the next native snapshot. Only retry reads, never the send.
        for _ in 0..80 {
            if let Ok(view) = self
                .http
                .get(&format!("/api/sessions/{id}?host=local"))
                .await
            {
                self.accept(&view).await?;
                let matched = projection::rows(&view["turns"]).iter().rev().find(|turn| {
                    projection::rows(&turn["messages"])
                        .iter()
                        .any(|message| message["requestId"].as_str() == Some(submission))
                });
                if let Some(turn) = matched {
                    return Ok(projection::turn(turn));
                }
            }
            if result["result"]["turn"]["id"].is_string() {
                return Ok(result["result"]["turn"].clone());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        Err(Error::UnknownWrite)
    }

    async fn interrupt(&self, request: &Value) -> Result<Value> {
        let _write = self.writes.lock().await;
        let id = thread_id(request)?;
        let view = self
            .http
            .get(&format!("/api/sessions/{id}?host=local"))
            .await?;
        let active = projection::rows(&view["turns"])
            .iter()
            .rev()
            .find(|t| t["status"] == "inProgress");
        if view["connected"] != true || active.map(|t| &t["id"]) != Some(&request["turnId"]) {
            return Err(Error::Stale);
        }
        self.http
            .post(&format!("/api/sessions/{id}/stop?host=local"), &json!({}))
            .await
    }

    async fn rename(&self, request: &Value) -> Result<Value> {
        let id = thread_id(request)?;
        let result = self
            .http
            .post(
                &format!("/api/sessions/{id}/rename?host=local"),
                &json!({"title": request["name"]}),
            )
            .await?;
        if let Some(metadata) = self.metadata.lock().await.get_mut(id) {
            metadata["title"] = request["name"].clone();
        }
        Ok(result)
    }

    async fn tool_details(&self, request: &Value) -> Result<Value> {
        let snapshots = self.snapshots.lock().await;
        let view = snapshots.get(thread_id(request)?).ok_or(Error::Stale)?;
        let thread = projection::thread(view);
        let item = projection::rows(&thread["turns"])
            .iter()
            .find(|turn| turn["id"] == request["turnId"])
            .and_then(|turn| {
                projection::rows(&turn["items"])
                    .iter()
                    .find(|item| item["id"] == request["itemId"])
            })
            .ok_or(Error::Stale)?;
        Ok(json!({"item": item}))
    }

    pub async fn respond(&self, reply: Value) -> Result<()> {
        let _write = self.writes.lock().await;
        let id = reply["id"].as_str().ok_or(Error::Invalid)?;
        let approval = self
            .approvals
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or(Error::Stale)?;
        let mut response = json!({});
        if let Some(decision) = reply["decision"].as_str() {
            if !matches!(decision, "accept" | "decline" | "cancel") {
                return Err(Error::Invalid);
            }
            response["decision"] = json!(decision);
        } else if let Some(answers) = reply["answers"].as_object() {
            response["answers"] = answers
                .iter()
                .map(|(id, answer)| (id.clone(), answer["answers"].clone()))
                .collect::<serde_json::Map<_, _>>()
                .into();
        } else {
            return Err(Error::Invalid);
        }
        self.http
            .post(
                &format!("/api/sessions/{}/respond?host=local", approval.thread_id),
                &json!({"requestId": approval.original_id, "response": response}),
            )
            .await?;
        self.approvals.lock().await.remove(id);
        self.emit(json!({"method": "serverRequest/resolved", "params": {"requestId": id}}));
        Ok(())
    }
}
