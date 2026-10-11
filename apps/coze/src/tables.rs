use crate::{
    database::Database,
    error::{Error, Result},
    model::*,
    resources,
};
use rusqlite::params;
use serde_json::{json, Value};
mod import;
mod schema;
mod sql;
#[cfg(test)]
mod sql_tests;

pub use import::{import_rows, ImportRowsRequest};
pub(crate) use schema::validate_columns;
pub use schema::{get_schema, save_schema, Column, ColumnKind, SchemaInput, TableSchema, SCHEMA};
pub use sql::{generate_sql, run_sql, GenerateSqlRequest, SqlRequest};

fn ensure(db: &Database, id: &str) -> Result<()> {
    if resources::get(db, id)?.kind != ResourceKind::Table {
        return Err(Error::Invalid);
    }
    Ok(())
}

pub fn list_page(db: &Database, table: &str, offset: u64, limit: u64) -> Result<Value> {
    ensure(db, table)?;
    if !(1..=100).contains(&limit) || offset > 1_000_000 {
        return Err(Error::Invalid);
    }
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    let total: u64 = tx.query_row(
        "SELECT count(*) FROM table_rows WHERE table_id=?1",
        [table],
        |row| row.get(0),
    )?;
    let mut stmt = tx.prepare(
        "SELECT id,value FROM table_rows WHERE table_id=?1
        ORDER BY updated_at DESC,id LIMIT ?2 OFFSET ?3",
    )?;
    let items = stmt
        .query_map(params![table, limit, offset], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .map(|row| {
            let (id, text) = row?;
            let value: Value = serde_json::from_str(&text).map_err(|_| Error::Invalid)?;
            Ok(json!({"id":id,"value":value}))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"items":items,"total":total}))
}

pub fn query(db: &Database, id: &str, filter: &Value) -> Result<Value> {
    ensure(db, id)?;
    let filter = filter.as_object().ok_or(Error::Invalid)?;
    let conn = db.connect()?;
    let mut stmt =
        conn.prepare("SELECT id,value FROM table_rows WHERE table_id=?1 ORDER BY updated_at DESC")?;
    let mut rows = stmt.query([id])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        let text: String = row.get(1)?;
        let value: Value = serde_json::from_str(&text).map_err(|_| Error::Invalid)?;
        if filter
            .iter()
            .all(|(key, expected)| value.get(key) == Some(expected))
        {
            items.push(json!({"id":row.get::<_, String>(0)?,"value":value}));
        }
        if items.len() == 1000 {
            break;
        }
    }
    Ok(json!(items))
}

pub fn write(db: &Database, table: &str, id: Option<&str>, value: Value) -> Result<Value> {
    ensure(db, table)?;
    if !value.is_object() || value.to_string().len() > 100_000 {
        return Err(Error::Invalid);
    }
    let id = id
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    validate_id(&id)?;
    let mut conn = db.connect()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    schema::validate_row(&schema::read(&tx, table)?.columns, &value)?;
    let count = tx.execute(
        "INSERT INTO table_rows VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE
         SET value=excluded.value,updated_at=excluded.updated_at WHERE table_id=excluded.table_id",
        params![id, table, value.to_string(), now()],
    )?;
    if count != 1 {
        return Err(Error::Conflict);
    }
    tx.commit()?;
    Ok(json!({"id":id,"value":value}))
}

pub fn delete(db: &Database, table: &str, id: &str) -> Result<Value> {
    ensure(db, table)?;
    validate_id(id)?;
    let count = db.connect()?.execute(
        "DELETE FROM table_rows WHERE id=?1 AND table_id=?2",
        params![id, table],
    )?;
    if count != 1 {
        return Err(Error::NotFound);
    }
    Ok(json!({"deleted":true}))
}

/// Update an existing row; workflow update nodes must never turn a missing row into an insert.
pub fn update(db: &Database, table: &str, id: &str, value: Value) -> Result<Value> {
    ensure(db, table)?;
    validate_id(id)?;
    if !value.is_object() || value.to_string().len() > 100_000 {
        return Err(Error::Invalid);
    }
    let mut conn = db.connect()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    schema::validate_row(&schema::read(&tx, table)?.columns, &value)?;
    if tx.execute(
        "UPDATE table_rows SET value=?1,updated_at=?2 WHERE id=?3 AND table_id=?4",
        params![value.to_string(), now(), id, table],
    )? != 1
    {
        return Err(Error::NotFound);
    }
    tx.commit()?;
    Ok(json!({"id":id,"value":value}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_scoped_to_their_table_and_support_filtered_queries() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        let create = |name: &str| {
            resources::save(
                &db,
                ResourceInput {
                    id: None,
                    kind: ResourceKind::Table,
                    name: name.into(),
                    description: String::new(),
                    draft: json!({}),
                    revision: None,
                },
            )
            .unwrap()
            .id
        };
        let first = create("一");
        let second = create("二");
        let row = write(&db, &first, None, json!({"name":"Alice","age":30})).unwrap();
        let id = row["id"].as_str().unwrap();
        assert!(matches!(
            write(&db, &second, Some(id), json!({"name":"overwrite"})),
            Err(Error::Conflict)
        ));
        assert!(delete(&db, &second, id).is_err());
        assert_eq!(
            query(&db, &first, &json!({"age":30}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(query(&db, &first, &json!({"age":31}))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        delete(&db, &first, id).unwrap();
        assert!(query(&db, &first, &json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
    }
}
