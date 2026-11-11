//! Extend saved history through the gateway's passive, bounded timeline reader.
use super::{projection::rows, thread_id, Client, Error, Result};
use serde_json::Value;
use std::sync::Arc;

pub(super) fn has_more(view: &Value) -> bool {
    view["historyWindowMore"] == true
        || view["savedHistoryMore"] == true
        || view["historyComplete"] == false
}

fn first(view: &Value) -> Option<(&str, &str)> {
    rows(&view["turns"]).iter().find_map(|turn| {
        rows(&turn["messages"])
            .first()
            .and_then(|message| Some((turn["id"].as_str()?, message["id"].as_str()?)))
    })
}

fn contains(thread: &Value, cursor: &Value) -> bool {
    rows(&thread["turns"]).iter().any(|turn| {
        turn["id"] == cursor["turnId"]
            && rows(&turn["items"])
                .iter()
                .any(|item| item["id"] == cursor["itemId"])
    })
}

impl Client {
    pub(super) async fn read_history(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let id = thread_id(request)?;
        let mut result = self.read(id).await?;
        // Forwarding a local display cursor lets a restarted gateway restore the
        // requested range instead of silently replacing it with the latest tail.
        let anchor = &request["history"]["start"];
        if request["history"]["older"] == true && result["historyMore"] == true {
            self.extend_history(id).await?;
            result = self.read(id).await?;
        }
        for _ in 0..64 {
            if !anchor.is_object()
                || contains(&result["thread"], anchor)
                || result["historyMore"] != true
            {
                return Ok(result);
            }
            self.extend_history(id).await?;
            result = self.read(id).await?;
        }
        Err(Error::Disconnected)
    }

    async fn extend_history(&self, id: &str) -> Result<()> {
        let path = format!("/api/sessions/{id}?host=local");
        let before_view = self.http.get(&path).await?;
        let initial = first(&before_view);
        let mut page = self
            .http
            .get(&format!("/api/sessions/{id}/timeline?host=local&limit=100"))
            .await?;
        for _ in 0..256 {
            if page["hasMore"] != true {
                return Ok(());
            }
            let cursor = page["before"]
                .as_str()
                .filter(|cursor| !cursor.is_empty())
                .ok_or(Error::Invalid)?;
            let mut url = reqwest::Url::parse("http://127.0.0.1/").map_err(|_| Error::Invalid)?;
            url.set_path(&format!("/api/sessions/{id}/timeline"));
            url.query_pairs_mut()
                .append_pair("host", "local")
                .append_pair("limit", "100")
                .append_pair("before", cursor);
            page = self
                .http
                .get(&format!(
                    "{}?{}",
                    url.path(),
                    url.query().unwrap_or_default()
                ))
                .await?;
            let expanded = self.http.get(&path).await?;
            if first(&expanded) != initial || !has_more(&expanded) {
                return Ok(());
            }
        }
        Err(Error::Disconnected)
    }
}

#[cfg(test)]
mod tests {
    use crate::tests::{client, fixture, THREAD};
    use serde_json::json;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn saved_tail_exposes_and_loads_earlier_messages_without_activating_the_owner() {
        let fixture = fixture(false).await;
        fixture.saved_total.store(165, Ordering::SeqCst);
        fixture.connected.store(false, Ordering::SeqCst);
        let client = client(&fixture).await;
        let first = client
            .request(json!({"operation":"read","threadId":THREAD}))
            .await
            .unwrap();
        assert_eq!(
            first["thread"]["turns"][0]["items"]
                .as_array()
                .unwrap()
                .len(),
            40
        );
        assert_eq!(first["historyMore"], true);
        let older = client
            .request(json!({"operation":"read","threadId":THREAD,"history":{"older":true}}))
            .await
            .unwrap();
        assert_eq!(
            older["thread"]["turns"][0]["items"]
                .as_array()
                .unwrap()
                .len(),
            140
        );
        assert_eq!(older["historyMore"], true);
        let oldest = client
            .request(json!({"operation":"read","threadId":THREAD,"history":{"older":true}}))
            .await
            .unwrap();
        assert_eq!(oldest["thread"]["turns"][0]["items"][0]["id"], "saved-0");
        assert_eq!(oldest["historyMore"], false);
        assert_eq!(fixture.posts.load(Ordering::SeqCst), 0);
        client.close().await;
    }

    #[tokio::test]
    async fn cached_display_anchor_is_restored_after_gateway_history_resets_to_its_tail() {
        let fixture = fixture(false).await;
        fixture.saved_total.store(265, Ordering::SeqCst);
        fixture.saved_limit.store(40, Ordering::SeqCst);
        let client = client(&fixture).await;
        let restored = client
            .request(json!({"operation":"read","threadId":THREAD,
            "history":{"start":{"turnId":"turn-1","itemId":"saved-5"}}}))
            .await
            .unwrap();
        assert_eq!(restored["thread"]["turns"][0]["items"][0]["id"], "saved-0");
        assert_eq!(restored["historyMore"], false);
        assert_eq!(fixture.posts.load(Ordering::SeqCst), 0);
        client.close().await;
    }
}
