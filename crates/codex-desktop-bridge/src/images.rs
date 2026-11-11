//! Resolve opaque image references only from authoritative attachments in the requested chat.
use super::{projection::rows, thread_id, Client, Error, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn image_source(id: &str) -> String {
    // Keep bridge references distinct from the desktop's inline-image registry namespace.
    format!("codex-bridge-images/{id}.png")
}

fn identifiers(attachment: &Value) -> Option<(String, String)> {
    if let Some(id) = attachment["uploadId"].as_str() {
        let id = uuid::Uuid::parse_str(id).ok()?;
        let opaque = id.simple().to_string().repeat(2);
        return Some((opaque, format!("uploads/{id}/preview")));
    }
    let id = attachment["desktopId"].as_str()?;
    if id.len() != 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    Some((id.to_owned(), format!("desktop-images/{id}")))
}

pub(super) fn source(attachment: &Value) -> Option<String> {
    identifiers(attachment)
        .map(|(id, _)| image_source(&id))
        .or_else(|| {
            matches!(attachment["type"].as_str(), Some("localImage" | "image"))
                .then(|| {
                    attachment["path"]
                        .as_str()
                        .map(|path| image_source(&format!("{:x}", Sha256::digest(path.as_bytes()))))
                })
                .flatten()
        })
}

enum ImageRoute {
    Gateway(String),
    DesktopPath(String),
}

fn route(view: &Value, requested: &str) -> Option<ImageRoute> {
    rows(&view["turns"])
        .iter()
        .flat_map(|turn| rows(&turn["messages"]))
        .flat_map(|message| rows(&message["attachments"]))
        .find_map(|attachment| {
            if let Some((id, path)) = identifiers(attachment) {
                return (requested == image_source(&id)).then_some(ImageRoute::Gateway(path));
            }
            (source(attachment).as_deref() == Some(requested))
                .then(|| {
                    attachment["path"]
                        .as_str()
                        .map(|path| ImageRoute::DesktopPath(path.to_owned()))
                })
                .flatten()
        })
        .or_else(|| {
            // The gateway authorizes model-authored file references against this
            // chat's workspace. Use that ledger rather than trusting a raw path.
            rows(&view["files"]).iter().find_map(|file| {
                let id = file["id"].as_str()?;
                let valid_id = id.len() == 64
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
                let matches = file["reference"].as_str() == Some(requested)
                    || rows(&file["references"])
                        .iter()
                        .any(|reference| reference.as_str() == Some(requested));
                (valid_id && file["image"] == true && matches)
                    .then(|| ImageRoute::Gateway(format!("files/{id}")))
            })
        })
}

async fn gateway_route(route: ImageRoute) -> Result<String> {
    match route {
        ImageRoute::Gateway(path) => Ok(path),
        ImageRoute::DesktopPath(path) => tokio::task::spawn_blocking(move || {
            // Match pathlib.resolve(), whose digest is checked against this chat by the gateway.
            let path = std::fs::canonicalize(path).map_err(|_| Error::Invalid)?;
            let resolved = path.to_str().ok_or(Error::Invalid)?;
            let resolved = resolved.strip_prefix(r"\\?\").unwrap_or(resolved);
            Ok(format!(
                "desktop-images/{:x}",
                Sha256::digest(resolved.as_bytes())
            ))
        })
        .await
        .map_err(|_| Error::Invalid)?,
    }
}

impl Client {
    pub(super) async fn image_preview(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let id = thread_id(request)?;
        let source = request["source"].as_str().ok_or(Error::Invalid)?;
        if source.is_empty() || source.len() > 4096 || source.contains('\0') {
            return Err(Error::Invalid);
        }
        let view = self
            .http
            .get(&format!("/api/sessions/{id}?host=local"))
            .await?;
        let path = gateway_route(route(&view, source).ok_or(Error::Invalid)?).await?;
        let variant = if request["variant"] == "original" {
            "original"
        } else {
            "thumb"
        };
        let limit = request["maxBytes"]
            .as_u64()
            .unwrap_or(super::input::MAX_IMAGE_BYTES as u64)
            .clamp(1, super::input::MAX_IMAGE_BYTES as u64) as usize;
        let url = self
            .http
            .image(
                &format!("/api/sessions/{id}/{path}?host=local&variant={variant}"),
                limit,
            )
            .await?;
        Ok(json!({"url":url}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_require_an_attachment_in_the_requested_chat() {
        let attachment = json!({"uploadId":"00000000-0000-4000-8000-000000000001"});
        let source = source(&attachment).unwrap();
        let view = json!({"turns":[{"messages":[{"attachments":[attachment]}]}]});
        assert!(
            matches!(route(&view, &source).unwrap(), ImageRoute::Gateway(path)
                if path == "uploads/00000000-0000-4000-8000-000000000001/preview")
        );
        assert!(route(&json!({"turns":[]}), &source).is_none());
        assert!(route(&view, "C:/private.png").is_none());
        assert!(super::source(&json!({"desktopId":"../private"})).is_none());
        let attachment = json!({"type":"localImage", "path":"C:/chat/image.png"});
        let opaque = super::source(&attachment).unwrap();
        assert!(opaque.starts_with("codex-bridge-images/"));
        assert!(!opaque.contains("C:"));
        let view = json!({"turns":[{"messages":[{"attachments":[attachment]}]}]});
        assert!(
            matches!(route(&view, &opaque), Some(ImageRoute::DesktopPath(path))
            if path == "C:/chat/image.png")
        );
    }

    #[test]
    fn model_image_previews_use_only_the_requested_chats_authorized_file_ledger() {
        let id = "a".repeat(64);
        let path = "C:/project/figure.png";
        let alias = "file:///C:/project/figure.png";
        let mut view =
            json!({"files":[{"id":id,"image":true,"reference":path,"references":[path,alias]}]});
        for source in [path, alias] {
            assert!(
                matches!(route(&view, source), Some(ImageRoute::Gateway(route))
                if route == format!("files/{id}"))
            );
        }
        assert!(route(&view, "C:/private/secret.png").is_none());
        assert!(route(&json!({"files":[]}), path).is_none());
        view["files"][0]["image"] = json!(false);
        assert!(route(&view, path).is_none());
        view["files"][0]["image"] = json!(true);
        view["files"][0]["id"] = json!("../private");
        assert!(route(&view, path).is_none());
    }
}
