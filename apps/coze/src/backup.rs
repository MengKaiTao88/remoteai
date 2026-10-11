//! Consistent full backups include original files, indices, releases and conversation state.
use crate::{
    api::Services,
    database::Database,
    error::{Error, Result},
};
use rusqlite::{backup::Backup, Connection, DatabaseName, OpenFlags};
use std::{collections::BTreeMap, io::Read, path::Path, time::Duration};
use tiny_http::{Header, Method, Request, Response};

const MAX_BACKUP_BYTES: u64 = 512 * 1024 * 1024;

pub fn handle(services: &Services, mut request: Request) {
    let result = if request.method() == &Method::Get {
        return download(services, request);
    } else if request.method() == &Method::Post {
        restore_request(services, &mut request)
    } else {
        Err(Error::Invalid)
    };
    match result {
        Ok(()) => crate::server::respond(request, 200, b"{}".to_vec(), "application/json"),
        Err(error) => crate::server::respond(
            request,
            error.status(),
            serde_json::json!({"error":error.to_string()})
                .to_string()
                .into_bytes(),
            "application/json",
        ),
    }
}

fn download(services: &Services, request: Request) {
    let result = (|| {
        let _lease = services.maintenance.read().map_err(|_| Error::Conflict)?;
        let temporary = tempfile::tempdir()?;
        let path = temporary.path().join("backup.sqlite3");
        export(&services.db, &path)?;
        let file = std::fs::File::open(path)?;
        Ok::<_, Error>((temporary, file))
    })();
    match result {
        Ok((_temporary, file)) => {
            let mut response = Response::from_file(file);
            for (key, value) in [
                ("Content-Type", "application/octet-stream"),
                (
                    "Content-Disposition",
                    "attachment; filename=remoteai-coze.coze",
                ),
                ("Cache-Control", "no-store"),
                ("X-Content-Type-Options", "nosniff"),
            ] {
                if let Ok(header) = Header::from_bytes(key, value) {
                    response.add_header(header);
                }
            }
            if let Err(error) = request.respond(response) {
                eprintln!("Backup download disconnected: {error}");
            }
        }
        Err(error) => crate::server::respond(
            request,
            error.status(),
            serde_json::json!({"error":error.to_string()})
                .to_string()
                .into_bytes(),
            "application/json",
        ),
    }
}

fn restore_request(services: &Services, request: &mut Request) -> Result<()> {
    let _lease = services
        .maintenance
        .try_write()
        .map_err(|_| Error::Conflict)?;
    let temporary = tempfile::tempdir()?;
    let path = temporary.path().join("restore.sqlite3");
    let mut file = std::fs::File::create(&path)?;
    let copied = std::io::copy(
        &mut request.as_reader().take(MAX_BACKUP_BYTES + 1),
        &mut file,
    )?;
    if copied > MAX_BACKUP_BYTES {
        return Err(Error::Limit);
    }
    file.sync_all()?;
    drop(file);
    restore(&services.db, &path)
}

pub fn export(db: &Database, path: &Path) -> Result<()> {
    let source = db.connect()?;
    source.backup(DatabaseName::Main, path, None)?;
    Ok(())
}

pub fn restore(db: &Database, path: &Path) -> Result<()> {
    let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    source.pragma_update(None, "trusted_schema", false)?;
    let mut destination = db.connect()?;
    validate(&source, &destination)?;
    // Prepare all recovery changes in a private copy before replacing live data.
    let temporary = tempfile::tempdir()?;
    source.backup(
        DatabaseName::Main,
        temporary.path().join("coze.sqlite3"),
        None,
    )?;
    let prepared = Database::open(temporary.path())?.connect()?;
    prepared.execute(
        "UPDATE app_access SET revoked_at=?1 WHERE revoked_at IS NULL",
        [crate::model::now()],
    )?;
    // SQLite backup commits atomically into the existing DB; no live WAL files are renamed.
    let backup = Backup::new(&prepared, &mut destination)?;
    backup.run_to_completion(128, Duration::from_millis(10), None)?;
    drop(backup);
    Ok(())
}

fn validate(source: &Connection, destination: &Connection) -> Result<()> {
    let version: u32 = source.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let current: u32 = destination.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != current || schema(source)? != schema(destination)? {
        return Err(Error::Invalid);
    }
    let integrity: String = source.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if integrity != "ok" || source.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(Error::Invalid);
    }
    Ok(())
}

fn schema(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let mut statement = conn.prepare(
        "SELECT type || ':' || name,sql FROM sqlite_master
        WHERE sql IS NOT NULL ORDER BY name",
    )?;
    let values = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_backup_restores_rows_and_rejects_foreign_schema() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let db = Database::open(&temp.path().join("data"))?;
        let id = uuid::Uuid::new_v4().to_string();
        db.connect()?.execute(
            "INSERT INTO resources VALUES (?1,'knowledge','资料','','{}',1,NULL,0,'now')",
            [&id],
        )?;
        let path = temp.path().join("backup");
        export(&db, &path)?;
        db.connect()?.execute("DELETE FROM resources", [])?;
        restore(&db, &path)?;
        assert_eq!(crate::resources::get(&db, &id)?.name, "资料");
        Connection::open(&path)?
            .execute_batch("CREATE VIEW hostile AS SELECT * FROM resources;")?;
        assert!(matches!(restore(&db, &path), Err(Error::Invalid)));
        assert_eq!(crate::resources::get(&db, &id)?.name, "资料");
        Ok(())
    }

    #[test]
    fn validation_includes_every_user_defined_schema_object() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let db = Database::open(&temp.path().join("data"))?;
        let path = temp.path().join("backup");
        export(&db, &path)?;
        Connection::open(&path)?.execute_batch("CREATE VIEW sqliteMirror AS SELECT 1 AS value;")?;
        assert!(matches!(restore(&db, &path), Err(Error::Invalid)));
        Ok(())
    }
}
