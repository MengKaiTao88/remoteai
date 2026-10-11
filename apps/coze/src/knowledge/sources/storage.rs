use crate::{
    database::Database,
    error::{Error, Result},
    model::{now, validate_id},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS document_sources (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, url TEXT, model TEXT, mime_type TEXT NOT NULL, updated_at TEXT NOT NULL
);";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub document_id: String,
    pub kind: String,
    pub url: Option<String>,
    pub model: Option<String>,
    pub mime_type: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_base64: Option<String>,
}

impl SourceInfo {
    pub(super) fn new(kind: &str, mime: &str) -> Self {
        Self {
            document_id: String::new(),
            kind: kind.into(),
            url: None,
            model: None,
            mime_type: mime.into(),
            updated_at: now(),
            content_base64: None,
        }
    }
}

pub(in crate::knowledge) fn save(tx: &Transaction<'_>, id: &str, info: &SourceInfo) -> Result<()> {
    tx.execute(
        "INSERT INTO document_sources VALUES (?1,?2,?3,?4,?5,?6)
        ON CONFLICT(document_id) DO UPDATE SET kind=excluded.kind,url=excluded.url,
        model=excluded.model,mime_type=excluded.mime_type,updated_at=excluded.updated_at",
        params![
            id,
            info.kind,
            info.url,
            info.model,
            info.mime_type,
            info.updated_at
        ],
    )?;
    Ok(())
}

pub fn list_sources(db: &Database, knowledge: &str) -> Result<Vec<SourceInfo>> {
    validate_id(knowledge)?;
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT s.* FROM document_sources s JOIN documents d
        ON d.id=s.document_id WHERE d.knowledge_id=?1",
    )?;
    let items = stmt
        .query_map([knowledge], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items)
}

/// Return an image's original bytes only on an explicit preview request.
pub fn document_source(db: &Database, id: &str) -> Result<SourceInfo> {
    validate_id(id)?;
    let conn = db.connect()?;
    let mut source = conn
        .query_row(
            "SELECT * FROM document_sources WHERE document_id=?1",
            [id],
            from_row,
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    if source.kind == "image" {
        let bytes: Vec<u8> =
            conn.query_row("SELECT source FROM documents WHERE id=?1", [id], |row| {
                row.get(0)
            })?;
        source.content_base64 = Some(STANDARD.encode(bytes));
    }
    Ok(source)
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceInfo> {
    Ok(SourceInfo {
        document_id: row.get("document_id")?,
        kind: row.get("kind")?,
        url: row.get("url")?,
        model: row.get("model")?,
        mime_type: row.get("mime_type")?,
        updated_at: row.get("updated_at")?,
        content_base64: None,
    })
}
