use super::storage::SourceInfo;
use crate::{
    database::Database,
    embedding::Embedder,
    error::{Error, Result},
    jobs::JobControl,
    knowledge::{
        documents::{index_controlled, PreparedDocument},
        parse::MAX_FILE_BYTES,
        ChunkOptions,
    },
    model::Document,
    proxy::{ModelProxy, VisionImage, VisionRequest},
    resources,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;

mod pdf;

const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const IMAGE_PROMPT: &str = "请忠实识别图片中的全部可见文字，保留标题、段落和表格顺序。\
    如果图片包含图表或照片，请补充简洁、客观的内容描述以便检索。\
    看不清的内容标注[无法辨认]，不要猜测或添加图片之外的知识。仅输出识别结果。";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportMediaDocument {
    pub knowledge_id: String,
    pub name: String,
    pub content_base64: String,
    pub model: String,
    #[serde(default)]
    pub chunk: ChunkOptions,
}

/// OCR uses the currently selected local model proxy; it never needs separate service credentials.
pub fn import_media(
    db: &Database,
    embedder: &dyn Embedder,
    proxy: &ModelProxy,
    input: ImportMediaDocument,
) -> Result<Document> {
    validate(db, &input)?;
    let control = JobControl::detached();
    index_controlled(db, embedder, prepare(proxy, input, &control)?, &control)
}

pub fn import_media_controlled(
    services: &crate::api::Services,
    input: ImportMediaDocument,
    control: &JobControl,
) -> Result<Document> {
    control.check()?;
    validate(&services.db, &input)?;
    let prepared = prepare(&services.proxy, input, control)?;
    index_controlled(&services.db, services.embedder.as_ref(), prepared, control)
}

fn validate(db: &Database, input: &ImportMediaDocument) -> Result<()> {
    if resources::get(db, &input.knowledge_id)?.kind != crate::model::ResourceKind::Knowledge
        || input.name.trim().is_empty()
        || input.name.chars().count() > 255
    {
        return Err(Error::Invalid);
    }
    Ok(())
}

fn prepare(
    proxy: &ModelProxy,
    input: ImportMediaDocument,
    control: &JobControl,
) -> Result<PreparedDocument> {
    control
        .emit(serde_json::json!({"type":"progress","stage":"recognize","completed":0,"total":1}))?;
    let bytes = STANDARD
        .decode(&input.content_base64)
        .map_err(|_| Error::Invalid)?;
    if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
        return Err(Error::Limit);
    }
    let is_pdf = input.name.to_ascii_lowercase().ends_with(".pdf");
    let (mime, text) = if is_pdf {
        (
            "application/pdf",
            pdf::recognize(proxy, &input.model, &bytes, control)?,
        )
    } else {
        let mime = image_mime(&bytes)?;
        let image = VisionImage {
            mime_type: mime.into(),
            content_base64: STANDARD.encode(&bytes),
        };
        (
            mime,
            proxy.vision_controlled(
                VisionRequest {
                    model: &input.model,
                    images: &[image],
                    prompt: IMAGE_PROMPT,
                },
                &control.without_events(),
            )?,
        )
    };
    if text.trim().is_empty() {
        return Err(Error::EmptyDocument);
    }
    let mut source = SourceInfo::new(if is_pdf { "scanned_pdf" } else { "image" }, mime);
    source.model = Some(input.model);
    Ok(PreparedDocument {
        knowledge_id: input.knowledge_id,
        name: input.name,
        bytes,
        text,
        chunk: input.chunk,
        source: Some(source),
        replacing: None,
    })
}

fn image_mime(bytes: &[u8]) -> Result<&'static str> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(Error::Limit);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Ok("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Ok("image/jpeg");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Ok("image/webp");
    }
    Err(Error::Format)
}
