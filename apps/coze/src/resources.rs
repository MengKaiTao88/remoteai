use crate::{
    database::Database,
    error::{Error, Result},
    model::*,
};
use rusqlite::{params, OptionalExtension, Row};
use serde_json::Value;

pub fn list(db: &Database) -> Result<Vec<Resource>> {
    let conn = db.connect()?;
    let mut stmt = conn.prepare("SELECT * FROM resources ORDER BY updated_at DESC")?;
    let values = stmt
        .query_map([], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(values)
}

pub fn get(db: &Database, id: &str) -> Result<Resource> {
    validate_id(id)?;
    db.connect()?
        .query_row("SELECT * FROM resources WHERE id=?1", [id], from_row)
        .optional()?
        .ok_or(Error::NotFound)
}

pub fn save(db: &Database, input: ResourceInput) -> Result<Resource> {
    validate(&input)?;
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    validate_id(&id)?;
    let conn = db.connect()?;
    let draft = input.draft.to_string();
    let timestamp = now();
    if let Some(revision) = input.revision {
        let count = conn.execute(
            "UPDATE resources SET name=?1, description=?2, draft=?3, revision=revision+1, updated_at=?4
             WHERE id=?5 AND revision=?6 AND kind=?7",
            params![input.name.trim(), input.description, draft, timestamp, id, revision, input.kind.as_str()],
        )?;
        if count != 1 {
            return Err(Error::Conflict);
        }
    } else {
        conn.execute(
            "INSERT INTO resources VALUES (?1,?2,?3,?4,?5,1,NULL,0,?6)",
            params![
                id,
                input.kind.as_str(),
                input.name.trim(),
                input.description,
                draft,
                timestamp
            ],
        )?;
    }
    get(db, &id)
}

fn validate(input: &ResourceInput) -> Result<()> {
    if input.name.trim().is_empty()
        || input.name.chars().count() > 100
        || input.description.chars().count() > 2000
        || !input.draft.is_object()
        || input.draft.to_string().len() > 1024 * 1024
        || input.id.is_some() != input.revision.is_some()
    {
        return Err(Error::Invalid);
    }
    Ok(())
}

pub fn publish(db: &Database, id: &str, revision: u64, mcp_enabled: bool) -> Result<Resource> {
    let resource = get(db, id)?;
    if !mcp_enabled {
        if db.connect()?.execute(
            "UPDATE resources SET mcp_enabled=0 WHERE id=?1 AND revision=?2",
            params![id, revision],
        )? != 1
        {
            return Err(Error::Conflict);
        }
        return get(db, id);
    }
    match resource.kind {
        ResourceKind::Workflow => crate::workflow::validate_value(&resource.draft)?,
        ResourceKind::Agent => crate::agents::validate(&resource.draft)?,
        ResourceKind::Plugin => crate::plugins::validate(&resource.draft)?,
        ResourceKind::Knowledge => {}
        _ => return Err(Error::Invalid),
    }
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    if resource.revision != revision {
        return Err(Error::Conflict);
    }
    let count = tx.execute(
        "UPDATE resources SET published_revision=?1,mcp_enabled=?2 WHERE id=?3 AND revision=?1",
        params![revision, mcp_enabled, id],
    )?;
    if count != 1 {
        return Err(Error::Conflict);
    }
    tx.execute(
        "INSERT OR IGNORE INTO revisions VALUES (?1,?2,?3,?4)",
        params![id, revision, resource.draft.to_string(), now()],
    )?;
    tx.commit()?;
    get(db, id)
}

pub fn published(db: &Database, id: &str) -> Result<(Resource, Value)> {
    let resource = get(db, id)?;
    let revision = resource.published_revision.ok_or(Error::Unpublished)?;
    let body: String = db.connect()?.query_row(
        "SELECT body FROM revisions WHERE resource_id=?1 AND revision=?2",
        params![id, revision],
        |row| row.get(0),
    )?;
    let body = serde_json::from_str(&body).map_err(|_| Error::Invalid)?;
    Ok((resource, body))
}

pub fn delete(db: &Database, id: &str, revision: u64) -> Result<()> {
    validate_id(id)?;
    if db.connect()?.execute(
        "DELETE FROM resources WHERE id=?1 AND revision=?2",
        params![id, revision],
    )? != 1
    {
        return Err(Error::Conflict);
    }
    Ok(())
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Resource> {
    let kind: String = row.get("kind")?;
    let draft: String = row.get("draft")?;
    let decode_error = |error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    };
    Ok(Resource {
        id: row.get("id")?,
        kind: serde_json::from_value(Value::String(kind)).map_err(decode_error)?,
        name: row.get("name")?,
        description: row.get("description")?,
        draft: serde_json::from_str(&draft).map_err(decode_error)?,
        revision: row.get("revision")?,
        published_revision: row.get("published_revision")?,
        mcp_enabled: row.get("mcp_enabled")?,
        updated_at: row.get("updated_at")?,
    })
}
