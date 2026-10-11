use crate::{
    database::Database,
    embedding::{self, Embedder},
    error::{Error, Result},
    model::*,
};
use rusqlite::params;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

const CANDIDATE_COUNT: usize = 40;
const RRF_K: f32 = 60.0;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchRequest {
    pub knowledge_ids: Vec<String>,
    pub query: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    6
}

pub fn search(
    db: &Database,
    embedder: &dyn Embedder,
    request: SearchRequest,
) -> Result<Vec<Citation>> {
    if request.query.trim().is_empty()
        || request.query.len() > 8000
        || request.knowledge_ids.is_empty()
        || request.knowledge_ids.len() > 20
        || !(1..=20).contains(&request.limit)
    {
        return Err(Error::Invalid);
    }
    for id in &request.knowledge_ids {
        validate_id(id)?;
    }
    let vector = embedder.encode(&request.query, true)?;
    embedding::validate_vector(&vector)?;
    let allowed: HashSet<_> = request.knowledge_ids.iter().collect();
    let semantic = semantic(db, &allowed, &vector, embedder.model_id())?;
    let lexical = lexical(db, &allowed, &request.query)?;
    Ok(fuse(semantic, lexical, request.limit))
}

fn semantic(
    db: &Database,
    allowed: &HashSet<&String>,
    vector: &[f32],
    model: &str,
) -> Result<Vec<Citation>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT c.id,d.id,d.name,c.content,c.vector,d.knowledge_id FROM chunks c
         JOIN documents d ON d.id=c.document_id WHERE c.embedding_model=?1",
    )?;
    let mut rows = stmt.query([model])?;
    let mut best = Vec::new();
    while let Some(row) = rows.next()? {
        let knowledge: String = row.get(5)?;
        if !allowed.contains(&knowledge) {
            continue;
        }
        let bytes: Vec<u8> = row.get(4)?;
        let score = embedding::similarity(vector, &bytes);
        let mut citation = citation(row)?;
        citation.score = score;
        best.push(citation);
        best.sort_by(|left, right| right.score.total_cmp(&left.score));
        best.truncate(CANDIDATE_COUNT);
    }
    Ok(best)
}

fn lexical(db: &Database, allowed: &HashSet<&String>, query: &str) -> Result<Vec<Citation>> {
    let conn = db.connect()?;
    // LIKE handles one/two-character CJK queries; longer phrases use FTS5's trigram index.
    let pattern = format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let mut stmt = conn.prepare(
        "SELECT c.id,d.id,d.name,c.content,d.knowledge_id FROM chunks c
         JOIN documents d ON d.id=c.document_id
         WHERE c.rowid IN (SELECT rowid FROM chunk_search WHERE content LIKE ?1 ESCAPE '\\')",
    )?;
    let mut rows = stmt.query(params![pattern])?;
    let mut found = Vec::new();
    while let Some(row) = rows.next()? {
        let knowledge: String = row.get(4)?;
        if allowed.contains(&knowledge) {
            found.push(citation(row)?);
        }
        if found.len() == CANDIDATE_COUNT {
            break;
        }
    }
    Ok(found)
}

fn citation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Citation> {
    Ok(Citation {
        chunk_id: row.get(0)?,
        document_id: row.get(1)?,
        document_name: row.get(2)?,
        text: row.get(3)?,
        score: 0.0,
    })
}

/// Reciprocal rank fusion preserves both exact matches and semantic candidates.
fn fuse(semantic: Vec<Citation>, lexical: Vec<Citation>, limit: usize) -> Vec<Citation> {
    let mut results: HashMap<String, Citation> = HashMap::new();
    for ranked in [semantic, lexical] {
        for (rank, mut value) in ranked.into_iter().enumerate() {
            let score = 1.0 / (RRF_K + rank as f32 + 1.0);
            results
                .entry(value.chunk_id.clone())
                .and_modify(|item| item.score += score)
                .or_insert_with(|| {
                    value.score = score;
                    value
                });
        }
    }
    let mut values: Vec<_> = results.into_values().collect();
    values.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then(left.chunk_id.cmp(&right.chunk_id))
    });
    values.truncate(limit);
    values
}
