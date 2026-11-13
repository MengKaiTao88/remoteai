use super::{projection, Client, Error, Result, Watched, MAX_WATCHES};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

impl Client {
    pub(super) async fn with_metadata(&self, mut view: Value) -> Value {
        let metadata = self.metadata.lock().await;
        if let Some(row) = view["id"].as_str().and_then(|id| metadata.get(id)) {
            // Native live snapshots can omit list metadata. Listing owns labels; live state owns execution.
            for key in ["title", "cwd"] {
                if row[key].as_str().is_some_and(|s| !s.is_empty()) {
                    view[key] = row[key].clone();
                }
            }
            view["updated_at"] = row["updated_at"].clone();
            for key in ["recency", "project_id", "projectName", "is_pinned"] {
                view[key] = row[key].clone();
            }
        }
        view
    }

    pub(super) async fn watch(self: &Arc<Self>, id: &str) -> Result<()> {
        let mut watches = self.watches.lock().await;
        if let Some(watch) = watches.get_mut(id) {
            if !watch.task.is_finished() {
                watch.touched = Instant::now();
                return Ok(());
            }
        }
        if watches.len() >= MAX_WATCHES {
            let oldest = watches
                .iter()
                .min_by_key(|(_, watch)| watch.touched)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                if let Some(watch) = watches.remove(&oldest) {
                    watch.task.abort();
                }
                self.snapshots.lock().await.remove(&oldest);
                self.clear_approvals(&oldest).await;
            }
        }
        let weak = Arc::downgrade(self);
        let thread = id.to_owned();
        let task = tokio::spawn(async move {
            let mut sequence = -1;
            let mut delay = 1;
            let mut disconnected = false;
            loop {
                let Some(client) = weak.upgrade() else { return };
                let path = format!("/api/sessions/{thread}/poll?host=local&after={sequence}");
                let update = client.http.get(&path).await;
                match update {
                    Ok(update) => {
                        delay = 1;
                        if disconnected {
                            disconnected = false;
                            client.emit(json!({"method": "connection/restored", "params": {}}));
                        }
                        if !update["state"].is_null() {
                            let view = &update["state"];
                            sequence = view["sequence"].as_i64().unwrap_or(-1);
                            if client.accept(view).await.is_err() {
                                return;
                            }
                        } else if let Ok(view) = client
                            .http
                            .get(&format!("/api/sessions/{thread}?host=local"))
                            .await
                        {
                            // Queue storage has its own revision and may change while the
                            // conversation stream is idle. Refresh after the bounded long poll;
                            // this reads state only and never activates or replays a message.
                            if client.accept(&view).await.is_err() {
                                return;
                            }
                        }
                    }
                    Err(_) => {
                        sequence = -1;
                        client.snapshots.lock().await.remove(&thread);
                        client.clear_approvals(&thread).await;
                        if !disconnected {
                            disconnected = true;
                            client.emit(json!({"method": "connection/closed", "params": {}}));
                        }
                        drop(client);
                        tokio::time::sleep(Duration::from_secs(delay)).await;
                        delay = (delay * 2).min(15);
                    }
                }
            }
        });
        watches.insert(
            id.to_owned(),
            Watched {
                touched: Instant::now(),
                task,
            },
        );
        Ok(())
    }

    pub(super) async fn clear_approvals(&self, id: &str) {
        let mut approvals = self.approvals.lock().await;
        let stale: Vec<String> = approvals
            .iter()
            .filter(|(_, a)| a.thread_id == id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            approvals.remove(&id);
            self.emit(json!({"method": "serverRequest/resolved", "params": {"requestId": id}}));
        }
    }

    pub(super) async fn accept(&self, view: &Value) -> Result<()> {
        let _update = self.updates.lock().await;
        let view = self.with_metadata(view.clone()).await;
        let view = &view;
        let id = view["id"].as_str().ok_or(Error::Invalid)?;
        uuid::Uuid::parse_str(id).map_err(|_| Error::Invalid)?;
        if self.snapshots.lock().await.get(id).is_some_and(|previous| {
            previous["sequence"]
                .as_i64()
                .zip(view["sequence"].as_i64())
                .is_some_and(|(old, next)| old > next)
        }) {
            return Ok(());
        }
        let previous = self
            .snapshots
            .lock()
            .await
            .insert(id.to_owned(), view.clone());
        self.publish_turns(previous.as_ref(), view);
        self.publish_usage(previous.as_ref(), view);
        if view["nativeQueue"].is_array()
            && previous.as_ref().map(|old| &old["nativeQueue"]) != Some(&view["nativeQueue"])
        {
            self.emit(json!({"method":"thread/nativeQueue/updated",
                "params":{"threadId":id,"nativeQueue":view["nativeQueue"]}}));
        }
        if super::models::selection(view) != previous.as_ref().and_then(super::models::selection)
            || super::models::access(view) != previous.as_ref().and_then(super::models::access)
            || (view["permissionUpdate"] == "nextTurn")
                != previous
                    .as_ref()
                    .is_some_and(|view| view["permissionUpdate"] == "nextTurn")
        {
            if let Some(snapshot) = super::models::snapshot(view) {
                self.emit(json!({"method":"bridge/modelSettings", "params":snapshot}));
            }
        }
        let current = projection::approvals(view);
        let mut approvals = self.approvals.lock().await;
        let obsolete: Vec<String> = approvals
            .iter()
            .filter(|(key, a)| {
                a.thread_id == id
                    && !current
                        .iter()
                        .any(|a| a.event["id"].as_str() == Some(key.as_str()))
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in obsolete {
            approvals.remove(&key);
            self.emit(json!({"method": "serverRequest/resolved", "params": {"requestId": key}}));
        }
        for approval in current {
            let key = approval.event["id"]
                .as_str()
                .ok_or(Error::Invalid)?
                .to_owned();
            if approvals
                .get(&key)
                .is_none_or(|old| old.event != approval.event)
            {
                self.emit(approval.event.clone());
            }
            approvals.insert(key, approval);
        }
        Ok(())
    }

    fn publish_turns(&self, previous: Option<&Value>, view: &Value) {
        let id = &view["id"];
        let Some(previous) = previous else {
            self.emit(
                json!({"method": "thread/started", "params": {"thread": projection::thread(view)}}),
            );
            return;
        };
        if previous["title"] != view["title"] {
            self.emit(json!({"method": "thread/name/updated", "params": {"threadId": id, "threadName": view["title"]}}));
        }
        if projection::rows(&view["turns"]).iter().any(|turn| {
            turn["status"] != "inProgress"
                && !projection::provisional(turn)
                && !projection::rows(&previous["turns"])
                    .iter()
                    .any(|old| old["id"] == turn["id"])
        }) {
            // Hydrating old completed turns is a history snapshot, not a new
            // completion now. Lifecycle events would fabricate today's finish
            // time and leave empty headers when presentation bodies are deferred.
            self.emit(
                json!({"method":"thread/started", "params":{"thread":projection::thread(view)}}),
            );
            return;
        }
        for turn in projection::rows(&view["turns"]) {
            if projection::provisional(turn) {
                continue;
            }
            let before = projection::rows(&previous["turns"])
                .iter()
                .find(|t| t["id"] == turn["id"]);
            if before == Some(turn) {
                continue;
            }
            let projected = projection::turn(turn);
            if let Some(before) = before {
                self.publish_items(id, &projection::turn(before), &projected);
                if before["status"] == turn["status"] {
                    continue;
                }
            }
            let method = if turn["status"] == "inProgress" {
                "turn/started"
            } else {
                "turn/completed"
            };
            let mut lifecycle = projected;
            if before.is_some() {
                lifecycle["items"] = json!([]);
            }
            self.emit(json!({"method": method, "params": {"threadId": id, "turn": lifecycle}}));
        }
    }

    fn publish_items(&self, thread: &Value, before: &Value, turn: &Value) {
        for item in projection::rows(&turn["items"]) {
            let old = projection::rows(&before["items"])
                .iter()
                .find(|old| old["id"] == item["id"]);
            if old == Some(item) {
                continue;
            }
            let delta_key = match item["type"].as_str() {
                Some("agentMessage") => Some(("text", "item/agentMessage/delta")),
                Some("commandExecution") => {
                    Some(("aggregatedOutput", "item/commandExecution/outputDelta"))
                }
                _ => None,
            };
            if let (Some(old), Some((key, method))) = (old, delta_key) {
                if let (Some(previous), Some(current)) = (old[key].as_str(), item[key].as_str()) {
                    if let Some(delta) = current.strip_prefix(previous) {
                        let mut expected = old.clone();
                        expected[key] = item[key].clone();
                        if expected == *item {
                            if !delta.is_empty() {
                                self.emit(json!({"method": method, "params": {"threadId": thread,
                                    "turnId": turn["id"], "itemId": item["id"], "delta": delta}}));
                            }
                            continue;
                        }
                    }
                }
            }
            let method = if item["status"] == "inProgress"
                || item["status"].is_null() && turn["status"] == "inProgress"
            {
                "item/started"
            } else {
                "item/completed"
            };
            self.emit(json!({"method": method, "params": {"threadId": thread,
                "turnId": turn["id"], "item": item}}));
        }
        if before["diff"] != turn["diff"] && turn["diff"].is_string() {
            self.emit(
                json!({"method": "turn/diff/updated", "params": {"threadId": thread,
                "turnId": turn["id"], "diff": turn["diff"]}}),
            );
        }
    }
}
