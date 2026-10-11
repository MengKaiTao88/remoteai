use crate::{
    api::Services,
    database::Database,
    error::{Error, Result},
    model::{now, validate_id},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Create,
    List,
    Rename,
    Delete,
    History,
    Append,
    EditMessage,
    DeleteMessage,
    Clear,
}

/// Workflow chat memory is separate from agent conversations and survives runtime restarts.
pub(super) fn execute(services: &Services, operation: Operation, input: Value) -> Result<Value> {
    if !input.is_object() || input.to_string().len() > 1024 * 1024 {
        return Err(Error::Invalid);
    }
    let db = &services.db;
    if !matches!(operation, Operation::Create | Operation::List) {
        crate::collaboration_access::require_execution(
            services,
            "workflow_conversation",
            field(&input, "conversationId")?,
        )?;
    }
    match operation {
        Operation::Create => {
            let value = create(db, &input)?;
            crate::collaboration_access::register_execution(
                services,
                "workflow_conversation",
                field(&value, "conversationId")?,
            )?;
            Ok(value)
        }
        Operation::List => {
            let rows = list(db)?;
            let mut visible = Vec::new();
            for row in rows {
                if crate::collaboration_access::owns_execution(
                    services,
                    "workflow_conversation",
                    field(&row, "conversationId")?,
                )? {
                    visible.push(row);
                }
            }
            Ok(json!(visible))
        }
        Operation::Append => append(db, &input),
        Operation::History => history(db, &input),
        _ => mutate(db, operation, &input),
    }
}

fn field<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input.get(key).and_then(Value::as_str).ok_or(Error::Invalid)
}

fn conversation<'a>(db: &Database, input: &'a Value) -> Result<&'a str> {
    let id = field(input, "conversationId")?;
    validate_id(id)?;
    if db
        .connect()?
        .query_row(
            "SELECT 1 FROM workflow_conversations WHERE id=?1",
            [id],
            |_| Ok(()),
        )
        .optional()?
        .is_none()
    {
        return Err(Error::NotFound);
    }
    Ok(id)
}

fn create(db: &Database, input: &Value) -> Result<Value> {
    let title = field(input, "title")?;
    if title.trim().is_empty() || title.len() > 500 {
        return Err(Error::Invalid);
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.connect()?.execute(
        "INSERT INTO workflow_conversations(id,title,created_at) VALUES (?1,?2,?3)",
        params![id, title, now()],
    )?;
    Ok(json!({"conversationId":id,"title":title}))
}

fn list(db: &Database) -> Result<Vec<Value>> {
    let conn = db.connect()?;
    let mut statement = conn.prepare(
        "SELECT id,title,created_at FROM workflow_conversations
        ORDER BY created_at DESC LIMIT 100",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({"conversationId":row.get::<_,String>(0)?,
        "title":row.get::<_,String>(1)?,"createdAt":row.get::<_,String>(2)?}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn history(db: &Database, input: &Value) -> Result<Value> {
    let id = conversation(db, input)?;
    let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(40);
    if !(1..=100).contains(&limit) {
        return Err(Error::Invalid);
    }
    let conn = db.connect()?;
    let mut statement = conn.prepare(
        "SELECT id,role,content,created_at FROM
        (SELECT rowid,id,role,content,created_at FROM workflow_messages WHERE conversation_id=?1
        ORDER BY rowid DESC LIMIT ?2) ORDER BY rowid",
    )?;
    let rows = statement
        .query_map(params![id, limit], |row| {
            Ok(json!({"messageId":row.get::<_,String>(0)?,
        "role":row.get::<_,String>(1)?,"content":row.get::<_,String>(2)?,
        "createdAt":row.get::<_,String>(3)?}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(rows))
}

fn append(db: &Database, input: &Value) -> Result<Value> {
    let conversation = conversation(db, input)?;
    let role = field(input, "role")?;
    let content = field(input, "content")?;
    if !["user", "assistant", "system"].contains(&role) || content.len() > 100_000 {
        return Err(Error::Invalid);
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.connect()?.execute(
        "INSERT INTO workflow_messages(id,conversation_id,role,content,created_at)
        VALUES (?1,?2,?3,?4,?5)",
        params![id, conversation, role, content, now()],
    )?;
    Ok(json!({"messageId":id,"conversationId":conversation}))
}

fn mutate(db: &Database, operation: Operation, input: &Value) -> Result<Value> {
    let id = conversation(db, input)?;
    let conn = db.connect()?;
    let changed = match operation {
        Operation::Rename => {
            let title = field(input, "title")?;
            if title.trim().is_empty() || title.len() > 500 {
                return Err(Error::Invalid);
            }
            conn.execute(
                "UPDATE workflow_conversations SET title=?1 WHERE id=?2",
                params![title, id],
            )?
        }
        Operation::Delete => {
            conn.execute("DELETE FROM workflow_conversations WHERE id=?1", [id])?
        }
        Operation::Clear => conn.execute(
            "DELETE FROM workflow_messages WHERE conversation_id=?1",
            [id],
        )?,
        Operation::EditMessage | Operation::DeleteMessage => {
            message_change(&conn, operation, (id, input))?
        }
        _ => return Err(Error::Invalid),
    };
    if changed == 0 && !matches!(operation, Operation::Clear) {
        return Err(Error::NotFound);
    }
    Ok(json!({"changed":changed}))
}

fn message_change(
    conn: &rusqlite::Connection,
    operation: Operation,
    target: (&str, &Value),
) -> Result<usize> {
    let message = field(target.1, "messageId")?;
    validate_id(message)?;
    if matches!(operation, Operation::DeleteMessage) {
        return Ok(conn.execute(
            "DELETE FROM workflow_messages WHERE id=?1 AND conversation_id=?2",
            params![message, target.0],
        )?);
    }
    let content = field(target.1, "content")?;
    if content.len() > 100_000 {
        return Err(Error::Invalid);
    }
    Ok(conn.execute(
        "UPDATE workflow_messages SET content=?1 WHERE id=?2 AND conversation_id=?3",
        params![content, message, target.0],
    )?)
}
