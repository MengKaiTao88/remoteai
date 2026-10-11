use super::{fetch, storage::SourceInfo};
use crate::{
    database::Database,
    embedding::Embedder,
    error::{Error, Result},
    jobs::JobControl,
    knowledge::{
        documents::{index_controlled, PreparedDocument},
        ChunkOptions,
    },
    model::{validate_id, Document},
};
use rusqlite::OptionalExtension;
use scraper::{Html, Selector};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportWebDocument {
    pub knowledge_id: String,
    pub url: String,
    #[serde(default)]
    pub chunk: ChunkOptions,
}

pub fn import_web(
    db: &Database,
    embedder: &dyn Embedder,
    input: ImportWebDocument,
) -> Result<Document> {
    import_web_controlled(db, embedder, input, &JobControl::detached())
}

pub fn import_web_controlled(
    db: &Database,
    embedder: &dyn Embedder,
    input: ImportWebDocument,
    control: &JobControl,
) -> Result<Document> {
    control.check()?;
    if crate::resources::get(db, &input.knowledge_id)?.kind != crate::model::ResourceKind::Knowledge
    {
        return Err(Error::Invalid);
    }
    index_controlled(db, embedder, prepare(input, control)?, control)
}

pub fn refresh_web(db: &Database, embedder: &dyn Embedder, id: &str) -> Result<Document> {
    refresh_web_controlled(db, embedder, id, &JobControl::detached())
}

pub fn refresh_web_controlled(
    db: &Database,
    embedder: &dyn Embedder,
    id: &str,
    control: &JobControl,
) -> Result<Document> {
    control.check()?;
    validate_id(id)?;
    let (knowledge_id, hash, url, size, overlap): (String, String, String, usize, usize) = db
        .connect()?
        .query_row(
            "SELECT d.knowledge_id,d.source_hash,s.url,d.chunk_size,d.overlap FROM documents d
            JOIN document_sources s ON s.document_id=d.id WHERE d.id=?1 AND s.kind='web'",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    let mut prepared = prepare(
        ImportWebDocument {
            knowledge_id,
            url,
            chunk: ChunkOptions { size, overlap },
        },
        control,
    )?;
    prepared.replacing = Some((id.into(), hash));
    index_controlled(db, embedder, prepared, control)
}

fn prepare(input: ImportWebDocument, control: &JobControl) -> Result<PreparedDocument> {
    control.emit(serde_json::json!({"type":"progress","stage":"download"}))?;
    let page = fetch::get(&input.url, control)?;
    let raw = String::from_utf8(page.bytes.clone()).map_err(|_| Error::Format)?;
    let (name, text) = if page.html {
        extract_html(&raw)?
    } else {
        (page.url.clone(), raw)
    };
    let mut source = SourceInfo::new("web", if page.html { "text/html" } else { "text/plain" });
    source.url = Some(page.url);
    Ok(PreparedDocument {
        knowledge_id: input.knowledge_id,
        name: name.chars().take(255).collect(),
        bytes: page.bytes,
        text,
        chunk: input.chunk,
        source: Some(source),
        replacing: None,
    })
}

pub(super) fn extract_html(html: &str) -> Result<(String, String)> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("title").map_err(|_| Error::Format)?;
    let name = document
        .select(&selector)
        .next()
        .map(|element| element.text().collect::<String>())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "网页文档".into());
    let mut parts = Vec::new();
    for node in document.root_element().descendants() {
        let Some(text) = node.value().as_text() else {
            continue;
        };
        let hidden = node.ancestors().any(|ancestor| {
            ancestor.value().as_element().is_some_and(|element| {
                matches!(
                    element.name(),
                    "head" | "script" | "style" | "noscript" | "nav" | "footer" | "svg"
                ) || element.attr("hidden").is_some()
                    || element.attr("aria-hidden") == Some("true")
            })
        });
        if !hidden && !text.trim().is_empty() {
            parts.push(text.trim().to_owned());
        }
    }
    let text = parts.join("\n");
    if text.trim().is_empty() {
        return Err(Error::EmptyDocument);
    }
    Ok((name.trim().to_owned(), text))
}
