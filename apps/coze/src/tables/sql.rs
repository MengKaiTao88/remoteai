//! SQL executes against an isolated, bounded snapshot, never the runtime's application database.
use super::{
    ensure,
    schema::{self, Column, ColumnKind},
};
use crate::{
    database::Database,
    error::{Error, Result},
    model::Message,
    proxy::ModelProxy,
    resources,
};
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    types::ValueRef,
    Connection,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    time::{Duration, Instant},
};

const MAX_ROWS: usize = 10_000;
const MAX_RESULT_ROWS: usize = 1000;
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlRequest {
    pub tables: Vec<String>,
    pub sql: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenerateSqlRequest {
    pub tables: Vec<String>,
    pub question: String,
    pub model: String,
}

#[derive(Serialize)]
struct SnapshotTable {
    alias: String,
    name: String,
    columns: Vec<Column>,
}

pub fn run_sql(db: &Database, input: SqlRequest) -> Result<Value> {
    let (conn, descriptions) = snapshot(db, &input.tables)?;
    let mut statement = prepare(&conn, &input.sql)?;
    let columns: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    let mut cursor = statement.query([]).map_err(|_| Error::Invalid)?;
    let mut rows = Vec::new();
    let mut bytes = 0;
    let mut truncated = false;
    while let Some(row) = cursor.next().map_err(|_| Error::Limit)? {
        if rows.len() == MAX_RESULT_ROWS {
            truncated = true;
            break;
        }
        let values = (0..columns.len())
            .map(|index| cell(row.get_ref(index)?))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        bytes += serde_json::to_vec(&values)
            .map_err(|_| Error::Invalid)?
            .len();
        if bytes > MAX_BYTES {
            return Err(Error::Limit);
        }
        rows.push(values);
    }
    Ok(json!({"columns":columns,"rows":rows,"truncated":truncated,"tables":descriptions}))
}

/// Generate and validate a query for review; the caller deliberately executes it afterward.
pub fn generate_sql(db: &Database, proxy: &ModelProxy, input: GenerateSqlRequest) -> Result<Value> {
    if input.question.trim().is_empty() || input.question.len() > 8000 {
        return Err(Error::Invalid);
    }
    let (conn, descriptions) = snapshot(db, &input.tables)?;
    let system = format!(
        "Translate the user's question into one read-only SQLite SELECT query. \
        Use only these tables and columns: {}. Table aliases are physical table names. \
        Quote identifiers with double quotes. Do not access schema metadata, extensions or files. \
        Include LIMIT 1000 for non-aggregate queries. Output SQL only, without markdown.",
        serde_json::to_string(&descriptions).map_err(|_| Error::Invalid)?
    );
    let messages = [
        Message {
            role: "system".into(),
            content: system,
            citations: vec![],
        },
        Message {
            role: "user".into(),
            content: input.question,
            citations: vec![],
        },
    ];
    let generated = proxy.chat(&input.model, &messages, 0.0)?;
    let sql = generated
        .trim()
        .strip_prefix("```sql")
        .or_else(|| generated.trim().strip_prefix("```"))
        .unwrap_or(generated.trim())
        .trim()
        .trim_end_matches("```")
        .trim()
        .to_owned();
    prepare(&conn, &sql)?;
    Ok(json!({"sql":sql,"tables":descriptions}))
}

fn prepare<'a>(conn: &'a Connection, sql: &str) -> Result<rusqlite::Statement<'a>> {
    let start = sql
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if !matches!(start.as_str(), "SELECT" | "WITH") || sql.len() > 32768 {
        return Err(Error::Invalid);
    }
    let statement = conn.prepare(sql).map_err(|_| Error::Invalid)?;
    if !statement.readonly() || statement.parameter_count() != 0 {
        return Err(Error::Invalid);
    }
    Ok(statement)
}

fn snapshot(db: &Database, tables: &[String]) -> Result<(Connection, Vec<SnapshotTable>)> {
    if tables.is_empty()
        || tables.len() > 8
        || tables.iter().collect::<HashSet<_>>().len() != tables.len()
    {
        return Err(Error::Invalid);
    }
    let mut conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    let mut descriptions = Vec::new();
    let mut size = 0;
    for (index, id) in tables.iter().enumerate() {
        ensure(db, id)?;
        let rows = records(db, id)?;
        size += rows
            .iter()
            .map(|(_, value)| value.to_string().len())
            .sum::<usize>();
        if size > MAX_BYTES {
            return Err(Error::Limit);
        }
        let columns = columns(db, id, &rows)?;
        let alias = format!("t{}", index + 1);
        populate(&mut conn, &alias, &columns, rows)?;
        descriptions.push(SnapshotTable {
            alias,
            name: resources::get(db, id)?.name,
            columns,
        });
    }
    restrict(
        &conn,
        descriptions
            .iter()
            .map(|table| table.alias.clone())
            .collect(),
    );
    Ok((conn, descriptions))
}

fn records(db: &Database, id: &str) -> Result<Vec<(String, Value)>> {
    let conn = db.connect()?;
    let mut statement =
        conn.prepare("SELECT id,value FROM table_rows WHERE table_id=?1 LIMIT ?2")?;
    let mut cursor = statement.query(rusqlite::params![id, MAX_ROWS + 1])?;
    let mut output = Vec::new();
    let mut bytes = 0;
    while let Some(row) = cursor.next()? {
        let text: String = row.get(1)?;
        bytes += text.len();
        if output.len() == MAX_ROWS || bytes > MAX_BYTES {
            return Err(Error::Limit);
        }
        output.push((
            row.get(0)?,
            serde_json::from_str(&text).map_err(|_| Error::Invalid)?,
        ));
    }
    Ok(output)
}

fn columns(db: &Database, id: &str, rows: &[(String, Value)]) -> Result<Vec<Column>> {
    let defined = super::get_schema(db, id)?.columns;
    if !defined.is_empty() {
        return Ok(defined);
    }
    let mut kinds = BTreeMap::new();
    for (_, value) in rows {
        for (name, value) in value.as_object().ok_or(Error::Invalid)? {
            let kind = match value {
                Value::Number(_) => ColumnKind::Number,
                Value::Bool(_) => ColumnKind::Boolean,
                Value::Array(_) | Value::Object(_) => ColumnKind::Json,
                _ => ColumnKind::String,
            };
            kinds.entry(name.clone()).or_insert(kind);
        }
    }
    let result: Vec<_> = kinds
        .into_iter()
        .map(|(name, kind)| Column {
            name,
            kind,
            required: false,
        })
        .collect();
    schema::validate_columns(&result)?;
    Ok(result)
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn populate(
    conn: &mut Connection,
    alias: &str,
    columns: &[Column],
    rows: Vec<(String, Value)>,
) -> Result<()> {
    let definitions: Vec<_> = columns
        .iter()
        .map(|column| {
            let kind = match column.kind {
                ColumnKind::Integer | ColumnKind::Boolean => "INTEGER",
                ColumnKind::Number => "REAL",
                _ => "TEXT",
            };
            format!("{} {}", quote(&column.name), kind)
        })
        .collect();
    let suffix = if definitions.is_empty() {
        String::new()
    } else {
        format!(",{}", definitions.join(","))
    };
    conn.execute_batch(&format!(
        "CREATE TABLE {} (_id TEXT PRIMARY KEY{})",
        quote(alias),
        suffix
    ))?;
    let tx = conn.transaction()?;
    let placeholders = vec!["?"; columns.len() + 1].join(",");
    {
        let mut insert = tx.prepare(&format!(
            "INSERT INTO {} VALUES ({})",
            quote(alias),
            placeholders
        ))?;
        for (id, value) in rows {
            let values = std::iter::once(rusqlite::types::Value::Text(id))
                .chain(columns.iter().map(|column| sql_value(&value[&column.name])));
            insert.execute(rusqlite::params_from_iter(values))?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn sql_value(value: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as SqlValue;
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(i64::from(*value)),
        Value::Number(value) => value
            .as_i64()
            .map(SqlValue::Integer)
            .unwrap_or_else(|| SqlValue::Real(value.as_f64().unwrap_or_default())),
        Value::String(value) => SqlValue::Text(value.clone()),
        _ => SqlValue::Text(value.to_string()),
    }
}

fn cell(value: ValueRef<'_>) -> rusqlite::Result<Value> {
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => json!(value),
        ValueRef::Real(value) => json!(value),
        ValueRef::Text(value) => json!(String::from_utf8_lossy(value)),
        ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidQuery),
    })
}

fn restrict(conn: &Connection, tables: HashSet<String>) {
    conn.set_limit(Limit::SQLITE_LIMIT_LENGTH, MAX_BYTES as i32);
    conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 32768);
    conn.set_limit(Limit::SQLITE_LIMIT_COLUMN, 128);
    conn.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 40);
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
    conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 100_000);
    conn.set_limit(Limit::SQLITE_LIMIT_COMPOUND_SELECT, 32);
    let start = Instant::now();
    let mut steps = 0;
    conn.progress_handler(
        1000,
        Some(move || {
            steps += 1000;
            steps > 2_000_000 || start.elapsed() > Duration::from_secs(2)
        }),
    );
    conn.authorizer(Some(move |context: AuthContext<'_>| match context.action {
        AuthAction::Select | AuthAction::Recursive => Authorization::Allow,
        AuthAction::Read { table_name, .. } if tables.contains(table_name) => Authorization::Allow,
        AuthAction::Function { function_name } if allowed_function(function_name) => {
            Authorization::Allow
        }
        _ => Authorization::Deny,
    }));
}

fn allowed_function(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "count"
            | "sum"
            | "avg"
            | "min"
            | "max"
            | "total"
            | "abs"
            | "round"
            | "coalesce"
            | "ifnull"
            | "nullif"
            | "length"
            | "lower"
            | "upper"
            | "trim"
            | "ltrim"
            | "rtrim"
            | "substr"
            | "substring"
            | "replace"
            | "instr"
            | "like"
            | "glob"
            | "date"
            | "datetime"
            | "strftime"
            | "julianday"
            | "unixepoch"
            | "typeof"
            | "json_extract"
            | "json_array_length"
            | "json_type"
            | "group_concat"
            | "row_number"
            | "rank"
            | "dense_rank"
            | "lag"
            | "lead"
    )
}
