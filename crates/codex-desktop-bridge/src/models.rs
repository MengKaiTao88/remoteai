use super::{projection::rows, thread_id, Client, Error, Result, INHERIT_MODEL};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static MODEL_REVISION: AtomicU64 = AtomicU64::new(0);

pub(super) fn selection(view: &Value) -> Option<Value> {
    let model = view["model"]
        .as_str()
        .or_else(|| view["latestModel"].as_str())?;
    let effort = view["effort"]
        .as_str()
        .or_else(|| view["latestReasoningEffort"].as_str())?;
    Some(json!({"model":model, "effort":effort}))
}

pub(super) fn snapshot(view: &Value) -> Option<Value> {
    let selected = selection(view)?;
    // Native sequence numbers reset with the gateway; clients also reject older settings revisions.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    MODEL_REVISION.fetch_max(now, Ordering::SeqCst);
    let revision = MODEL_REVISION.fetch_add(1, Ordering::SeqCst) + 1;
    Some(json!({"threadId":view["id"], "selection":selected, "revision":revision}))
}

impl Client {
    async fn catalog(&self, id: &str, refresh: bool) -> Result<Value> {
        uuid::Uuid::parse_str(id).map_err(|_| Error::Invalid)?;
        self.http
            .get(&format!(
                "/api/sessions/{id}/catalog?host=local&kind=models&refresh={refresh}"
            ))
            .await
    }

    pub(super) async fn models(&self, request: &Value) -> Result<Value> {
        if request["cursor"]
            .as_str()
            .is_some_and(|cursor| !cursor.is_empty())
        {
            return Ok(json!({"data":[], "nextCursor":null}));
        }
        let sessions = self
            .http
            .get("/api/sessions?scope=host&host=local&source=desktop")
            .await?;
        let Some(id) = rows(&sessions["sessions"])
            .iter()
            .find_map(|row| row["id"].as_str())
        else {
            return Ok(json!({"data":[], "nextCursor":null}));
        };
        let catalog = self.catalog(id, request["cacheOnly"] != true).await?;
        let data: Vec<Value> = rows(&catalog["models"])
            .iter()
            .filter_map(project_model)
            .collect();
        if data.is_empty() {
            return Err(Error::Unsupported);
        }
        Ok(json!({"data":data, "nextCursor":null}))
    }

    pub async fn model_settings(self: &std::sync::Arc<Self>, id: &str) -> Result<Value> {
        uuid::Uuid::parse_str(id).map_err(|_| Error::Invalid)?;
        let _write = self.writes.lock().await;
        self.read(id).await?;
        let view = self
            .snapshots
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or(Error::Disconnected)?;
        snapshot(&view).ok_or(Error::Invalid)
    }

    pub async fn set_model_settings(
        self: &std::sync::Arc<Self>,
        id: &str,
        requested: &Value,
    ) -> Result<Value> {
        let _write = self.writes.lock().await;
        self.update_model(id, requested).await?;
        self.read(id).await?;
        let view = self
            .snapshots
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or(Error::Disconnected)?;
        let mut result = snapshot(&view).ok_or(Error::Invalid)?;
        if result["selection"] != *requested {
            return Err(Error::Stale);
        }
        result["liveUpdate"] = json!(if rows(&view["turns"])
            .iter()
            .any(|turn| turn["status"] == "inProgress")
        {
            "nextTurn"
        } else {
            "applied"
        });
        Ok(result)
    }

    async fn update_model(&self, id: &str, requested: &Value) -> Result<()> {
        uuid::Uuid::parse_str(id).map_err(|_| Error::Invalid)?;
        let model = requested["model"].as_str().ok_or(Error::Invalid)?;
        let effort = requested["effort"].as_str().ok_or(Error::Invalid)?;
        let catalog = self.catalog(id, false).await?;
        let known = rows(&catalog["models"])
            .iter()
            .find(|entry| entry["id"] == model)
            .ok_or(Error::Invalid)?;
        if !rows(&known["efforts"]).iter().any(|entry| entry == effort) {
            return Err(Error::Invalid);
        }
        let result = self
            .http
            .post(
                &format!("/api/sessions/{id}/settings?host=local"),
                &json!({"model":model, "effort":effort}),
            )
            .await?;
        if result["applied"] != true || result["confirmed"] != true {
            return Err(Error::Stale);
        }
        Ok(())
    }

    pub(super) async fn apply_send_model(&self, request: &Value, before: &Value) -> Result<()> {
        let Some(model) = request["model"]
            .as_str()
            .filter(|model| *model != INHERIT_MODEL)
        else {
            return Ok(());
        };
        let requested = json!({"model":model, "effort":request["effort"]});
        if selection(before).as_ref() != Some(&requested) {
            self.update_model(thread_id(request)?, &requested).await?;
        }
        Ok(())
    }
}

fn project_model(row: &Value) -> Option<Value> {
    let id = row["id"].as_str()?;
    let efforts: Vec<Value> = rows(&row["efforts"])
        .iter()
        .filter_map(|effort| Some(json!({"reasoningEffort":effort.as_str()?, "description":""})))
        .collect();
    if id.is_empty() || id.len() > 200 || efforts.is_empty() {
        return None;
    }
    Some(
        json!({"id":id, "model":id, "displayName":row["name"].as_str().unwrap_or(id),
        "isDefault":row["isDefault"] == true, "defaultReasoningEffort":row["defaultEffort"],
        "supportedReasoningEfforts":efforts}),
    )
}
