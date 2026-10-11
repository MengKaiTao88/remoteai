use super::ensure;
use crate::{
    database::Database,
    error::{Error, Result},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS table_schemas (
    table_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
    columns TEXT NOT NULL, revision INTEGER NOT NULL
);";

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnKind {
    String,
    Integer,
    Number,
    Boolean,
    Time,
    Json,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Column {
    pub name: String,
    pub kind: ColumnKind,
    #[serde(default)]
    pub required: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SchemaInput {
    pub table_id: String,
    pub columns: Vec<Column>,
    pub revision: u64,
}

#[derive(Serialize)]
pub struct TableSchema {
    pub columns: Vec<Column>,
    pub revision: u64,
}

pub fn get_schema(db: &Database, table: &str) -> Result<TableSchema> {
    ensure(db, table)?;
    read(&db.connect()?, table)
}

pub(super) fn read(conn: &rusqlite::Connection, table: &str) -> Result<TableSchema> {
    let value: Option<(String, u64)> = conn
        .query_row(
            "SELECT columns,revision FROM table_schemas WHERE table_id=?1",
            [table],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match value {
        Some((columns, revision)) => Ok(TableSchema {
            columns: serde_json::from_str(&columns).map_err(|_| Error::Invalid)?,
            revision,
        }),
        None => Ok(TableSchema {
            columns: Vec::new(),
            revision: 0,
        }),
    }
}

pub fn save_schema(db: &Database, input: SchemaInput) -> Result<TableSchema> {
    ensure(db, &input.table_id)?;
    validate_columns(&input.columns)?;
    let mut conn = db.connect()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if read(&tx, &input.table_id)?.revision != input.revision {
        return Err(Error::Conflict);
    }
    {
        let mut stmt = tx.prepare("SELECT value FROM table_rows WHERE table_id=?1")?;
        let rows = stmt.query_map([&input.table_id], |row| row.get::<_, String>(0))?;
        for row in rows {
            validate_row(
                &input.columns,
                &serde_json::from_str(&row?).map_err(|_| Error::Invalid)?,
            )?;
        }
    }
    tx.execute(
        "INSERT INTO table_schemas VALUES (?1,?2,?3) ON CONFLICT(table_id)
        DO UPDATE SET columns=excluded.columns,revision=excluded.revision",
        params![
            input.table_id,
            serde_json::to_string(&input.columns).map_err(|_| Error::Invalid)?,
            input.revision + 1
        ],
    )?;
    tx.commit()?;
    Ok(TableSchema {
        columns: input.columns,
        revision: input.revision + 1,
    })
}

pub(crate) fn validate_columns(columns: &[Column]) -> Result<()> {
    if columns.len() > 100 {
        return Err(Error::Limit);
    }
    let mut names = HashSet::new();
    for column in columns {
        if column.name.trim().is_empty()
            || column.name.chars().count() > 64
            || column.name.chars().any(char::is_control)
            || column.name.eq_ignore_ascii_case("_id")
            || !names.insert(column.name.to_lowercase())
        {
            return Err(Error::Invalid);
        }
    }
    Ok(())
}

pub(super) fn validate_row(columns: &[Column], value: &Value) -> Result<()> {
    let object = value.as_object().ok_or(Error::Invalid)?;
    if columns.is_empty() {
        return Ok(());
    }
    if object
        .keys()
        .any(|name| !columns.iter().any(|column| &column.name == name))
    {
        return Err(Error::Invalid);
    }
    for column in columns {
        let value = object.get(&column.name).unwrap_or(&Value::Null);
        if value.is_null() {
            if column.required {
                return Err(Error::Invalid);
            }
            continue;
        }
        if !matches_type(column.kind, value) {
            return Err(Error::Invalid);
        }
    }
    Ok(())
}

fn matches_type(kind: ColumnKind, value: &Value) -> bool {
    match kind {
        ColumnKind::String => value.is_string(),
        ColumnKind::Integer => value.is_i64(),
        ColumnKind::Number => value.is_number(),
        ColumnKind::Boolean => value.is_boolean(),
        ColumnKind::Time => value
            .as_str()
            .is_some_and(|text| chrono::DateTime::parse_from_rfc3339(text).is_ok()),
        ColumnKind::Json => true,
    }
}
