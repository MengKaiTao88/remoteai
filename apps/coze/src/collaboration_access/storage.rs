use super::{Grant, Principal, Role};
use crate::{
    api::Services,
    database::Database,
    error::{Error, Result},
    model::{now, validate_id, ResourceKind},
    resources,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_access (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
        CREATE TABLE IF NOT EXISTS app_access_executions (
        access_id TEXT NOT NULL REFERENCES app_access(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, object_id TEXT NOT NULL, PRIMARY KEY(access_id,kind,object_id));",
    )?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessIssue {
    pub app_id: String,
    pub name: String,
    pub role: Role,
    #[serde(default = "default_days")]
    pub expires_days: i64,
}

fn default_days() -> i64 {
    30
}

pub fn issue(db: &Database, input: AccessIssue) -> Result<Value> {
    if input.name.trim().is_empty()
        || input.name.chars().count() > 80
        || !(1..=365).contains(&input.expires_days)
    {
        return Err(Error::Invalid);
    }
    let (app, _) = resources::published(db, &input.app_id)?;
    if app.kind != ResourceKind::App && input.role != Role::Tool {
        return Err(Error::Invalid);
    }
    let _snapshot = crate::publications::snapshot(db, &input.app_id)?;
    let id = uuid::Uuid::new_v4().to_string();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let hash = hash(&token);
    let expires = (chrono::Utc::now() + chrono::Duration::days(input.expires_days)).to_rfc3339();
    db.connect()?.execute(
        "INSERT INTO app_access VALUES (?1,?2,?3,?4,?5,?6,?7,NULL)",
        params![
            id,
            input.app_id,
            input.name.trim(),
            role_name(input.role),
            hash,
            now(),
            expires
        ],
    )?;
    Ok(json!({"id":id,"token":token,"expiresAt":expires,"role":input.role}))
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Viewer => "viewer",
        Role::Tool => "tool",
        Role::Runner => "runner",
        Role::Editor => "editor",
    }
}

fn hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub fn authenticate(db: &Database, token: &str) -> Result<Principal> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error::Unauthorized);
    }
    let data: Option<(String,String,String)> = db.connect()?.query_row(
        "SELECT id,app_id,role FROM app_access WHERE token_hash=?1 AND revoked_at IS NULL AND expires_at>?2",
        params![hash(token),now()],|row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
    let (id, app_id, role) = data.ok_or(Error::Unauthorized)?;
    let role: Role = serde_json::from_value(json!(role)).map_err(|_| Error::Unauthorized)?;
    let revisions = crate::publications::snapshot(db, &app_id).map_err(|_| Error::Unauthorized)?;
    Ok(Principal::Shared(Grant {
        id,
        app_id,
        role,
        revisions,
    }))
}

pub fn list(db: &Database, app: &str) -> Result<Value> {
    validate_id(app)?;
    let conn = db.connect()?;
    let mut stmt = conn.prepare(
        "SELECT id,name,role,created_at,expires_at,revoked_at FROM app_access
        WHERE app_id=?1 ORDER BY created_at DESC LIMIT 100",
    )?;
    let items = stmt.query_map([app], |row| Ok(json!({"id":row.get::<_,String>(0)?,
        "name":row.get::<_,String>(1)?,"role":row.get::<_,String>(2)?,"createdAt":row.get::<_,String>(3)?,
        "expiresAt":row.get::<_,String>(4)?,"revokedAt":row.get::<_,Option<String>>(5)?})))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(items))
}

pub fn revoke(services: &Services, id: &str) -> Result<Value> {
    validate_id(id)?;
    if services.db.connect()?.execute(
        "UPDATE app_access SET revoked_at=?1 WHERE id=?2",
        params![now(), id],
    )? != 1
    {
        return Err(Error::NotFound);
    }
    let conn = services.db.connect()?;
    let mut stmt = conn
        .prepare("SELECT object_id FROM app_access_executions WHERE access_id=?1 AND kind='job'")?;
    let jobs = stmt
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for job in jobs {
        // Finished jobs may already have expired from the bounded event journal.
        if let Err(error) = services.jobs.cancel(&job) {
            if !matches!(error, Error::NotFound) {
                return Err(error);
            }
        }
    }
    Ok(json!({"revoked":true}))
}

pub(super) fn ensure_active(services: &Services) -> Result<()> {
    let Principal::Shared(grant) = &services.principal else {
        return Ok(());
    };
    let active: bool = services.db.connect()?.query_row(
        "SELECT EXISTS(SELECT 1 FROM app_access WHERE id=?1 AND revoked_at IS NULL AND expires_at>?2)",
        params![grant.id,now()],|row| row.get(0))?;
    if active {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}

pub(super) fn owns(services: &Services, kind: &str, id: &str) -> Result<bool> {
    let Principal::Shared(grant) = &services.principal else {
        return Ok(true);
    };
    Ok(services.db.connect()?.query_row(
        "SELECT EXISTS(SELECT 1 FROM app_access_executions
        WHERE access_id=?1 AND kind=?2 AND object_id=?3)",
        params![grant.id, kind, id],
        |row| row.get(0),
    )?)
}

pub(super) fn remember(services: &Services, kind: &str, id: &str) -> Result<()> {
    let Principal::Shared(grant) = &services.principal else {
        return Ok(());
    };
    validate_id(id)?;
    services.db.connect()?.execute(
        "INSERT OR IGNORE INTO app_access_executions VALUES (?1,?2,?3)",
        params![grant.id, kind, id],
    )?;
    Ok(())
}
