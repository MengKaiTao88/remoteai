//! Bounded image inputs; all validation completes before uploading or submitting a turn.
use super::{Error, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{io::Read, path::Path};

pub(super) const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 100 * 1024 * 1024;
const MAX_IMAGES: usize = 10;

pub(super) struct Image {
    pub name: String,
    pub bytes: Vec<u8>,
}

pub(super) struct Input {
    pub text: String,
    pub images: Vec<Image>,
}

pub(super) async fn prepare(request: &Value) -> Result<Input> {
    if !super::projection::rows(&request["skills"]).is_empty()
        || !super::projection::rows(&request["attachments"]).is_empty()
    {
        return Err(Error::Unsupported);
    }
    let nodes = if let Some(nodes) = request["input"].as_array() {
        nodes.clone()
    } else {
        let mut nodes = vec![json!({"type":"text", "text":request["text"]})];
        nodes.extend(
            super::projection::rows(&request["images"])
                .iter()
                .map(|url| json!({"type":"image", "url":url})),
        );
        nodes
    };
    let mut text = Vec::new();
    let mut images = Vec::new();
    let mut total = 0;
    for node in nodes {
        match node["type"].as_str() {
            Some("text") => text.push(node["text"].as_str().ok_or(Error::Input)?.to_owned()),
            Some("image" | "localImage") => {
                let image = image(node).await?;
                total += image.bytes.len();
                if images.len() >= MAX_IMAGES || total > MAX_TOTAL_BYTES {
                    return Err(Error::Input);
                }
                images.push(image);
            }
            _ => return Err(Error::Unsupported),
        }
    }
    let text = text.join("\n\n");
    if (text.trim().is_empty() && images.is_empty()) || text.chars().count() > 100_000 {
        return Err(Error::Input);
    }
    Ok(Input { text, images })
}

async fn image(node: Value) -> Result<Image> {
    let bytes = if node["type"] == "localImage" {
        let path = node["path"].as_str().ok_or(Error::Input)?.to_owned();
        if !Path::new(&path).is_absolute() {
            return Err(Error::Input);
        }
        tokio::task::spawn_blocking(move || {
            let file = std::fs::File::open(path).map_err(|_| Error::Input)?;
            let mut bytes = Vec::new();
            file.take(MAX_IMAGE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| Error::Input)?;
            Ok::<_, Error>(bytes)
        })
        .await
        .map_err(|_| Error::Input)??
    } else {
        let url = node["url"].as_str().ok_or(Error::Input)?;
        let (header, encoded) = url.split_once(',').ok_or(Error::Input)?;
        if !matches!(
            header,
            "data:image/png;base64"
                | "data:image/jpeg;base64"
                | "data:image/webp;base64"
                | "data:image/gif;base64"
        ) || encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4
        {
            return Err(Error::Input);
        }
        STANDARD.decode(encoded).map_err(|_| Error::Input)?
    };
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(Error::Input);
    }
    let suffix = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "jpg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "webp"
    } else {
        return Err(Error::Input);
    };
    Ok(Image {
        name: format!("image.{}", suffix),
        bytes,
    })
}
