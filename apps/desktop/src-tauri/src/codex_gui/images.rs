use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageFormat;
use serde_json::{json, Value};

use super::error::{GuiError, Result};

pub(super) const MAX_IMAGES: usize = 8;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

// Clipboard and file-picker images travel inline, without granting the WebView filesystem access.
pub(super) fn input(image: String) -> Result<Value> {
    input_limited(image, MAX_IMAGE_BYTES as u64)
}

pub(super) fn input_limited(image: String, max_bytes: u64) -> Result<Value> {
    if image.starts_with("data:") {
        decode_data_url(&image, max_bytes)?;
        return Ok(json!({"type": "image", "url": image}));
    }
    let path = Path::new(&image);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if !path.is_absolute()
        || !path.is_file()
        || path
            .metadata()
            // Local image inputs carry only a path. Byte limits apply to inline uploads, not this reference.
            .map(|metadata| metadata.len() == 0)
            .unwrap_or(true)
        || !["png", "jpg", "jpeg", "webp", "gif"].contains(&extension.as_str())
    {
        return Err(GuiError::InvalidRequest);
    }
    Ok(json!({"type": "localImage", "path": image}))
}

pub(super) fn decode_data_url(url: &str, max_bytes: u64) -> Result<Vec<u8>> {
    let (header, encoded) = url.split_once(',').ok_or(GuiError::InvalidRequest)?;
    let format = match header {
        "data:image/png;base64" => ImageFormat::Png,
        "data:image/jpeg;base64" => ImageFormat::Jpeg,
        "data:image/webp;base64" => ImageFormat::WebP,
        "data:image/gif;base64" => ImageFormat::Gif,
        _ => return Err(GuiError::InvalidRequest),
    };
    if encoded.is_empty() || encoded.len() as u64 > max_bytes.div_ceil(3).saturating_mul(4) {
        return Err(GuiError::InvalidRequest);
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| GuiError::InvalidRequest)?;
    if bytes.len() as u64 > max_bytes || image::guess_format(&bytes).ok() != Some(format) {
        return Err(GuiError::InvalidRequest);
    }
    Ok(bytes)
}
