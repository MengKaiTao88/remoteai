use super::ChatRequest;
use crate::{
    database::Database,
    error::{Error, Result},
    model::{now, validate_id, Citation, Message},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// Kept separately so tool call/result pairs survive upgrades from plain chat history.
pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS agent_turns (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        status TEXT NOT NULL, messages TEXT NOT NULL, citations TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS agent_turns_conversation ON agent_turns(conversation_id,created_at);")?;
    Ok(())
}

pub(super) fn prepare(db: &Database, request: &ChatRequest) -> Result<String> {
    let conn = db.connect()?;
    if let Some(id) = &request.conversation_id {
        validate_id(id)?;
        let agent: Option<String> = conn
            .query_row(
                "SELECT agent_id FROM conversations WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        if agent.as_deref() != Some(&request.agent_id) {
            return Err(Error::NotFound);
        }
        return Ok(id.clone());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let title: String = request.message.chars().take(60).collect();
    conn.execute(
        "INSERT INTO conversations VALUES (?1,?2,?3,?4)",
        params![id, request.agent_id, title, now()],
    )?;
    Ok(id)
}

pub(super) fn load(db: &Database, conversation: &str, limit: usize) -> Result<Vec<Value>> {
    if limit == 0 {
        return Ok(vec![]);
    }
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT messages FROM
        (SELECT messages,created_at FROM agent_turns WHERE conversation_id=?1 AND status IN ('completed','failed','cancelled')
        ORDER BY created_at DESC LIMIT ?2) ORDER BY created_at",
    )?;
    let turns = stmt
        .query_map(params![conversation, limit], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if turns.is_empty() {
        return Ok(messages(db, conversation)?
            .into_iter()
            .filter(|message| message.role != "tool")
            .map(|message| json!({"role":message.role,"content":message.content}))
            .collect());
    }
    let mut history = Vec::new();
    for turn in turns {
        history.extend(serde_json::from_str::<Vec<Value>>(&turn).map_err(|_| Error::Invalid)?);
    }
    Ok(history)
}

pub(super) fn begin(db: &Database, conversation: &str, user: &Value) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    db.connect()?.execute(
        "INSERT INTO agent_turns VALUES (?1,?2,'running',?3,'[]',?4)",
        params![id, conversation, json!([user]).to_string(), now()],
    )?;
    Ok(id)
}

pub(super) fn checkpoint(db: &Database, id: &str, turn: &[Value]) -> Result<()> {
    db.connect()?.execute(
        "UPDATE agent_turns SET messages=?1 WHERE id=?2 AND status='running'",
        params![json!(turn).to_string(), id],
    )?;
    Ok(())
}

pub(super) struct Finish<'a> {
    pub id: &'a str,
    pub conversation: &'a str,
    pub turn: &'a [Value],
    pub citations: &'a [Citation],
    pub status: &'a str,
}

pub(super) fn finish(db: &Database, update: Finish<'_>) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    tx.execute(
        "UPDATE agent_turns SET messages=?1,citations=?2,status=?3 WHERE id=?4",
        params![
            json!(update.turn).to_string(),
            json!(update.citations).to_string(),
            update.status,
            update.id
        ],
    )?;
    for message in update.turn {
        let content = message["content"].as_str().unwrap_or_default();
        if content.is_empty() {
            continue;
        }
        let role = message["role"].as_str().ok_or(Error::Invalid)?;
        let citations = if role == "assistant" {
            json!(update.citations)
        } else {
            json!([])
        };
        tx.execute(
            "INSERT INTO messages (conversation_id,role,content,citations,created_at)
            VALUES (?1,?2,?3,?4,?5)",
            params![
                update.conversation,
                role,
                content,
                citations.to_string(),
                now()
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn messages(db: &Database, id: &str) -> Result<Vec<Message>> {
    validate_id(id)?;
    let conn = db.connect()?;
    let mut stmt = conn.prepare("SELECT role,content,citations FROM
        (SELECT id,role,content,citations FROM messages WHERE conversation_id=?1 ORDER BY id DESC LIMIT 200) ORDER BY id")?;
    let items = stmt
        .query_map([id], |row| {
            let citations: String = row.get(2)?;
            Ok(Message {
                role: row.get(0)?,
                content: row.get(1)?,
                citations: serde_json::from_str(&citations).unwrap_or_default(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(items)
}

pub fn conversations(db: &Database, agent: &str) -> Result<Value> {
    validate_id(agent)?;
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT id,title FROM conversations WHERE agent_id=?1 ORDER BY created_at DESC LIMIT 100",
    )?;
    let items = stmt
        .query_map([agent], |row| {
            Ok(json!({"id":row.get::<_,String>(0)?,
        "title":row.get::<_,String>(1)?}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(items))
}
