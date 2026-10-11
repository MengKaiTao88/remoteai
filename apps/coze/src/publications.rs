//! Immutable release dependency sets. Mutable knowledge and table data remain shared.
use crate::{
    database::Database,
    error::{Error, Result},
    model::{now, validate_id},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_DEPENDENCIES: usize = 256;

pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS publication_dependencies (
        resource_id TEXT NOT NULL, revision INTEGER NOT NULL, dependencies TEXT NOT NULL,
        PRIMARY KEY(resource_id,revision),
        FOREIGN KEY(resource_id,revision) REFERENCES revisions(resource_id,revision) ON DELETE CASCADE
    );")?;
    Ok(())
}

/// Captures the dependency closure inside the same write transaction as the root revision.
pub fn capture(conn: &Connection, id: &str, revision: u64, body: &Value) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM publication_dependencies WHERE resource_id=?1 AND revision=?2)",
        params![id, revision], |row| row.get(0))?;
    if exists {
        return Ok(());
    }
    let mut pinned = BTreeMap::from([(id.to_owned(), revision)]);
    collect(
        conn,
        body,
        &mut pinned,
        &mut BTreeSet::from([id.to_owned()]),
    )?;
    conn.execute(
        "INSERT INTO publication_dependencies VALUES (?1,?2,?3)",
        params![id, revision, json!(pinned).to_string()],
    )?;
    Ok(())
}

fn collect(
    conn: &Connection,
    body: &Value,
    pinned: &mut BTreeMap<String, u64>,
    visiting: &mut BTreeSet<String>,
) -> Result<()> {
    for id in references(body)? {
        if visiting.contains(&id) {
            return Err(Error::Dependency);
        }
        if pinned.contains_key(&id) {
            continue;
        }
        if pinned.len() >= MAX_DEPENDENCIES {
            return Err(Error::Limit);
        }
        let (revision, body) = dependency(conn, &id)?;
        pinned.insert(id.clone(), revision);
        if merge_captured(conn, &id, revision, pinned)? {
            continue;
        }
        visiting.insert(id.clone());
        collect(conn, &body, pinned, visiting)?;
        visiting.remove(&id);
    }
    Ok(())
}

fn merge_captured(
    conn: &Connection,
    id: &str,
    revision: u64,
    pinned: &mut BTreeMap<String, u64>,
) -> Result<bool> {
    let value: Option<String> = conn.query_row(
        "SELECT dependencies FROM publication_dependencies WHERE resource_id=?1 AND revision=?2",
        params![id, revision], |row| row.get(0)).optional()?;
    let Some(value) = value else {
        return Ok(false);
    };
    let dependencies: BTreeMap<String, u64> =
        serde_json::from_str(&value).map_err(|_| Error::Invalid)?;
    for (id, revision) in dependencies {
        if pinned
            .get(&id)
            .is_some_and(|previous| *previous != revision)
        {
            return Err(Error::Dependency);
        }
        pinned.insert(id, revision);
        if pinned.len() > MAX_DEPENDENCIES {
            return Err(Error::Limit);
        }
    }
    Ok(true)
}

fn dependency(conn: &Connection, id: &str) -> Result<(u64, Value)> {
    let result: Option<(u64, String)> = conn
        .query_row(
            "SELECT v.revision,v.body FROM resources r JOIN revisions v
         ON v.resource_id=r.id AND v.revision=r.published_revision WHERE r.id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (revision, body) = result.ok_or(Error::Dependency)?;
    Ok((
        revision,
        serde_json::from_str(&body).map_err(|_| Error::Invalid)?,
    ))
}

/// Resource links are explicit draft fields, never arbitrary UUID-like text in prompts/code.
pub fn references(body: &Value) -> Result<BTreeSet<String>> {
    let mut found = BTreeSet::new();
    find_links(body, &mut found)?;
    Ok(found)
}

fn find_links(value: &Value, found: &mut BTreeSet<String>) -> Result<()> {
    match value {
        Value::Array(values) => {
            for value in values {
                find_links(value, found)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                match key.as_str() {
                    "entryId" | "workflow_id" | "plugin_id" | "table_id" | "knowledge_id" => {
                        add_link(value, found)?
                    }
                    "resourceIds" | "toolIds" | "knowledgeIds" | "knowledge_ids" | "table_ids" => {
                        for value in value.as_array().ok_or(Error::Invalid)? {
                            add_link(value, found)?;
                        }
                    }
                    "nodes" => find_links(value, found)?,
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn add_link(value: &Value, found: &mut BTreeSet<String>) -> Result<()> {
    let id = value.as_str().ok_or(Error::Invalid)?;
    validate_id(id)?;
    found.insert(id.to_owned());
    Ok(())
}

pub fn snapshot(db: &Database, id: &str) -> Result<BTreeMap<String, u64>> {
    validate_id(id)?;
    let conn = db.connect()?;
    let (revision, body) = dependency(&conn, id)?;
    let encoded: Option<String> = conn.query_row(
        "SELECT dependencies FROM publication_dependencies WHERE resource_id=?1 AND revision=?2",
        params![id, revision], |row| row.get(0)).optional()?;
    if let Some(encoded) = encoded {
        return serde_json::from_str(&encoded).map_err(|_| Error::Invalid);
    }
    // Version 0.1 publications predate immutable dependencies. Capture their current graph once.
    let tx = conn.unchecked_transaction()?;
    capture(&tx, id, revision, &body)?;
    tx.commit()?;
    snapshot(db, id)
}

pub fn check_delete(conn: &Connection, id: &str) -> Result<()> {
    let used: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM publication_dependencies p,json_each(p.dependencies) d
         WHERE p.resource_id!=?1 AND d.key=?1)",
        [id],
        |row| row.get(0),
    )?;
    if used {
        return Err(Error::DependencyInUse);
    }
    Ok(())
}

pub fn list(db: &Database, id: &str) -> Result<Value> {
    validate_id(id)?;
    let conn = db.connect()?;
    let mut statement = conn.prepare(
        "SELECT r.revision,r.created_at,p.dependencies FROM revisions r
         LEFT JOIN publication_dependencies p ON p.resource_id=r.resource_id AND p.revision=r.revision
         WHERE r.resource_id=?1 ORDER BY r.revision DESC")?;
    let values = statement
        .query_map([id], |row| {
            let dependencies: Option<String> = row.get(2)?;
            Ok(
                json!({"revision":row.get::<_,u64>(0)?,"createdAt":row.get::<_,String>(1)?,
            "dependencies":dependencies.and_then(|s| serde_json::from_str::<Value>(&s).ok())}),
            )
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(values))
}

/// Rollback changes the active release only; it never overwrites unsaved or newer drafts.
pub fn activate(db: &Database, id: &str, revision: u64, expected: u64) -> Result<Value> {
    validate_id(id)?;
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM revisions WHERE resource_id=?1 AND revision=?2)",
        params![id, revision],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(Error::NotFound);
    }
    if tx.execute(
        "UPDATE resources SET published_revision=?1,mcp_enabled=1,updated_at=?2
        WHERE id=?3 AND revision=?4",
        params![revision, now(), id, expected],
    )? != 1
    {
        return Err(Error::Conflict);
    }
    tx.commit()?;
    Ok(json!(crate::resources::get(db, id)?))
}

#[cfg(test)]
#[path = "publications_tests.rs"]
mod tests;
