use super::{
    parse,
    sources::{storage, SourceInfo},
    split, ChunkOptions,
};
use crate::{
    database::Database,
    embedding::{self, Embedder},
    error::{Error, Result},
    jobs::JobControl,
    model::*,
    resources,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDocument {
    pub knowledge_id: String,
    pub name: String,
    pub content_base64: String,
    #[serde(default)]
    pub chunk: ChunkOptions,
}

pub fn import_document(
    db: &Database,
    embedder: &dyn Embedder,
    input: ImportDocument,
) -> Result<Document> {
    import_controlled(db, embedder, input, &JobControl::detached())
}

pub fn import_controlled(
    db: &Database,
    embedder: &dyn Embedder,
    input: ImportDocument,
    control: &JobControl,
) -> Result<Document> {
    control.emit(serde_json::json!({"type":"progress","stage":"parse"}))?;
    let bytes = STANDARD
        .decode(&input.content_base64)
        .map_err(|_| Error::Invalid)?;
    let text = parse::extract(&input.name, &bytes)?;
    index_controlled(
        db,
        embedder,
        PreparedDocument {
            knowledge_id: input.knowledge_id,
            name: input.name,
            bytes,
            text,
            chunk: input.chunk,
            source: None,
            replacing: None,
        },
        control,
    )
}

pub(super) struct PreparedDocument {
    pub knowledge_id: String,
    pub name: String,
    pub bytes: Vec<u8>,
    pub text: String,
    pub chunk: ChunkOptions,
    pub source: Option<SourceInfo>,
    pub replacing: Option<(String, String)>,
}

#[cfg(test)]
pub(super) fn index(
    db: &Database,
    embedder: &dyn Embedder,
    input: PreparedDocument,
) -> Result<Document> {
    index_controlled(db, embedder, input, &JobControl::detached())
}

pub(super) fn index_controlled(
    db: &Database,
    embedder: &dyn Embedder,
    input: PreparedDocument,
    control: &JobControl,
) -> Result<Document> {
    control.check()?;
    if resources::get(db, &input.knowledge_id)?.kind != ResourceKind::Knowledge
        || input.name.trim().is_empty()
        || input.name.chars().count() > 255
    {
        return Err(Error::Invalid);
    }
    let mut digest = Sha256::new();
    digest.update(&input.bytes);
    if let Some(source) = &input.source {
        digest.update(source.kind.as_bytes());
        digest.update(source.url.as_deref().unwrap_or_default().as_bytes());
    }
    let hash = format!("{:x}", digest.finalize());
    if input.replacing.is_none() {
        if let Some(document) = existing(db, &input.knowledge_id, &hash)? {
            return Ok(document);
        }
    }
    let parts = split(&input.text, input.chunk)?;
    let vectors = parts
        .iter()
        .enumerate()
        .map(|(index, part)| {
            control.emit(serde_json::json!({"type":"progress","stage":"index", "completed":index,"total":parts.len()}))?;
            let vector = embedder.encode(part, false)?;
            embedding::validate_vector(&vector)?;
            Ok(embedding::encode_vector(&vector))
        })
        .collect::<Result<Vec<_>>>()?;
    control.check()?;
    let document = Document {
        id: input
            .replacing
            .as_ref()
            .map(|item| item.0.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        knowledge_id: input.knowledge_id,
        name: input.name,
        chunks: parts.len(),
        bytes: input.bytes.len(),
        created_at: now(),
    };
    store(
        db,
        &document,
        StoredDocument {
            bytes: &input.bytes,
            hash: &hash,
            chunk: input.chunk,
            parts: &parts,
            vectors: &vectors,
            model: embedder.model_id(),
            source: input.source.as_ref(),
            previous: input.replacing.as_ref().map(|item| item.1.as_str()),
            control,
        },
    )?;
    Ok(document)
}

struct StoredDocument<'a> {
    bytes: &'a [u8],
    hash: &'a str,
    chunk: ChunkOptions,
    parts: &'a [String],
    vectors: &'a [Vec<u8>],
    model: &'a str,
    source: Option<&'a SourceInfo>,
    previous: Option<&'a str>,
    control: &'a JobControl,
}

fn store(db: &Database, document: &Document, input: StoredDocument<'_>) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    if let Some(previous) = input.previous {
        if tx.execute(
            "DELETE FROM documents WHERE id=?1 AND source_hash=?2",
            params![document.id, previous],
        )? != 1
        {
            return Err(Error::Conflict);
        }
    }
    tx.execute(
        "INSERT INTO documents VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            document.id,
            document.knowledge_id,
            document.name,
            document.chunks,
            document.bytes,
            document.created_at,
            input.bytes,
            input.hash,
            input.chunk.size,
            input.chunk.overlap
        ],
    )?;
    for (index, (text, vector)) in input.parts.iter().zip(input.vectors).enumerate() {
        input.control.check()?;
        tx.execute(
            "INSERT INTO chunks VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                uuid::Uuid::new_v4().to_string(),
                document.id,
                index,
                text,
                vector,
                input.model
            ],
        )?;
    }
    if let Some(source) = input.source {
        storage::save(&tx, &document.id, source)?;
    }
    input.control.check()?;
    tx.commit()?;
    Ok(())
}

fn existing(db: &Database, knowledge: &str, hash: &str) -> Result<Option<Document>> {
    Ok(db
        .connect()?
        .query_row(
            "SELECT * FROM documents WHERE knowledge_id=?1 AND source_hash=?2",
            params![knowledge, hash],
            from_row,
        )
        .optional()?)
}

pub fn list_documents(db: &Database, knowledge: &str) -> Result<Vec<Document>> {
    validate_id(knowledge)?;
    let conn = db.connect()?;
    let mut stmt =
        conn.prepare("SELECT * FROM documents WHERE knowledge_id=?1 ORDER BY created_at DESC")?;
    let documents = stmt
        .query_map([knowledge], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(documents)
}

pub fn read_chunks(db: &Database, document: &str) -> Result<Vec<serde_json::Value>> {
    validate_id(document)?;
    let conn = db.connect()?;
    let mut stmt = conn
        .prepare("SELECT id,ordinal,content FROM chunks WHERE document_id=?1 ORDER BY ordinal")?;
    let chunks = stmt.query_map([document], |row| Ok(serde_json::json!({
        "id": row.get::<_, String>(0)?, "ordinal": row.get::<_, u32>(1)?, "text": row.get::<_, String>(2)?
    })))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(chunks)
}

pub fn delete_document(db: &Database, id: &str) -> Result<()> {
    validate_id(id)?;
    if db
        .connect()?
        .execute("DELETE FROM documents WHERE id=?1", [id])?
        != 1
    {
        return Err(Error::NotFound);
    }
    Ok(())
}

pub fn update_chunk(db: &Database, embedder: &dyn Embedder, update: ChunkUpdate) -> Result<()> {
    validate_id(&update.id)?;
    if update.text.trim().is_empty() || update.text.chars().count() > 2000 {
        return Err(Error::Invalid);
    }
    let vector = embedder.encode(&update.text, false)?;
    embedding::validate_vector(&vector)?;
    let count = db.connect()?.execute(
        "UPDATE chunks SET content=?1,vector=?2,embedding_model=?3 WHERE id=?4 AND content=?5",
        params![
            update.text,
            embedding::encode_vector(&vector),
            embedder.model_id(),
            update.id,
            update.previous
        ],
    )?;
    if count != 1 {
        return Err(Error::Conflict);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChunkUpdate {
    pub id: String,
    pub text: String,
    pub previous: String,
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Document> {
    Ok(Document {
        id: row.get("id")?,
        knowledge_id: row.get("knowledge_id")?,
        name: row.get("name")?,
        chunks: row.get("chunks")?,
        bytes: row.get("bytes")?,
        created_at: row.get("created_at")?,
    })
}
