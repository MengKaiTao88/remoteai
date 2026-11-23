//! Adapt the owner-authorized plugin catalog and structured plugin input.
use super::{projection::rows, thread_id, Client, Error, Result};
use serde_json::{json, Value};

pub(super) fn plugin_path(path: &str) -> bool {
    path.strip_prefix("plugin://").is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 300
            && id
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b"-_.@".contains(&ch))
    })
}

pub(super) fn mention(part: &Value) -> Option<Value> {
    let path = part["path"].as_str().filter(|path| plugin_path(path))?;
    let name = part["name"].as_str().filter(|name| {
        !name.trim().is_empty()
            && name.chars().count() <= 200
            && !name.chars().any(char::is_control)
    })?;
    Some(json!({"type":"mention", "name":name, "path":path}))
}

impl Client {
    pub(super) async fn plugins(&self, request: &Value) -> Result<Value> {
        if !request["threadId"].is_null() {
            return self
                .plugin_catalog(thread_id(request)?, "remoteai-plugins")
                .await;
        }
        let sessions = self
            .http
            .get("/api/sessions?scope=host&host=local&source=desktop")
            .await?;
        let mut sessions = rows(&sessions["sessions"]).iter().filter_map(|row| {
            let id = row["id"].as_str()?;
            uuid::Uuid::parse_str(id).ok()?;
            Some((id, row["cwd"].as_str()))
        });
        let cwd = request["cwd"].as_str().filter(|path| !path.is_empty());
        let matching = cwd.and_then(|cwd| sessions.clone().find(|(_, path)| *path == Some(cwd)));
        if let Some((id, _)) = matching {
            return self.plugin_catalog(id, "remoteai-plugins").await;
        }
        if let Some((id, _)) = sessions.next() {
            return self.plugin_catalog(id, "remoteai-user-plugins").await;
        }
        Ok(json!({"marketplaces":[], "marketplaceLoadErrors":[]}))
    }

    async fn plugin_catalog(&self, id: &str, kind: &str) -> Result<Value> {
        let result = self
            .http
            .get(&format!(
                "/api/sessions/{id}/catalog?host=local&kind={kind}"
            ))
            .await?;
        if !result["marketplaces"].is_array() || !result["marketplaceLoadErrors"].is_array() {
            return Err(Error::Unsupported);
        }
        Ok(result)
    }
}
