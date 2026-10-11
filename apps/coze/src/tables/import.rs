use super::{ensure, schema};
use crate::{
    database::Database,
    error::{Error, Result},
    model::now,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use calamine::{Data, Reader, Xlsx};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{collections::HashSet, io::Cursor};

const MAX_ROWS: usize = 10_000;
const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRowsRequest {
    pub table_id: String,
    pub name: String,
    pub content_base64: String,
}

pub fn import_rows(db: &Database, input: ImportRowsRequest) -> Result<Value> {
    ensure(db, &input.table_id)?;
    let bytes = STANDARD
        .decode(&input.content_base64)
        .map_err(|_| Error::Invalid)?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(Error::Limit);
    }
    let extension = input
        .name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let rows = match extension.as_str() {
        "csv" => csv(&bytes, b',')?,
        "tsv" => csv(&bytes, b'\t')?,
        "xlsx" => excel(&bytes)?,
        _ => return Err(Error::Format),
    };
    if rows.is_empty() {
        return Err(Error::EmptyDocument);
    }
    store(db, &input.table_id, rows)
}

fn store(db: &Database, table: &str, rows: Vec<Value>) -> Result<Value> {
    let mut conn = db.connect()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let columns = schema::read(&tx, table)?.columns;
    let created = now();
    for row in &rows {
        schema::validate_row(&columns, row)?;
        let value = row.to_string();
        if value.len() > 100_000 {
            return Err(Error::Limit);
        }
        tx.execute(
            "INSERT INTO table_rows VALUES (?1,?2,?3,?4)",
            params![uuid::Uuid::new_v4().to_string(), table, value, created],
        )?;
    }
    tx.commit()?;
    Ok(json!({"inserted":rows.len()}))
}

fn headers(values: impl Iterator<Item = String>) -> Result<Vec<String>> {
    let fields: Vec<_> = values
        .map(|value| value.trim_start_matches('\u{feff}').trim().to_owned())
        .collect();
    let mut names = HashSet::new();
    if fields.is_empty() || fields.len() > 100 {
        return Err(Error::Limit);
    }
    for field in &fields {
        if field.is_empty()
            || field.chars().count() > 64
            || field.chars().any(char::is_control)
            || field.eq_ignore_ascii_case("_id")
            || !names.insert(field.to_lowercase())
        {
            return Err(Error::Invalid);
        }
    }
    Ok(fields)
}

fn csv(bytes: &[u8], delimiter: u8) -> Result<Vec<Value>> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .from_reader(bytes);
    let fields = headers(
        reader
            .headers()
            .map_err(|_| Error::Format)?
            .iter()
            .map(str::to_owned),
    )?;
    let mut rows = Vec::new();
    for record in reader.records() {
        if rows.len() == MAX_ROWS {
            return Err(Error::Limit);
        }
        let record = record.map_err(|_| Error::Format)?;
        let row: Map<_, _> = fields
            .iter()
            .cloned()
            .zip(record.iter().map(guess_value))
            .collect();
        rows.push(Value::Object(row));
    }
    Ok(rows)
}

fn excel(bytes: &[u8]) -> Result<Vec<Value>> {
    let archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| Error::Format)?;
    if archive.decompressed_size().ok_or(Error::Limit)? > (MAX_BYTES * 2) as u128 {
        return Err(Error::Limit);
    }
    let mut workbook = Xlsx::new(Cursor::new(bytes)).map_err(|_| Error::Format)?;
    let sheet = workbook
        .worksheet_range_at(0)
        .ok_or(Error::EmptyDocument)?
        .map_err(|_| Error::Format)?;
    if sheet.height() > MAX_ROWS + 1 || sheet.width() > 100 {
        return Err(Error::Limit);
    }
    let mut source = sheet.rows();
    let fields = headers(
        source
            .next()
            .ok_or(Error::EmptyDocument)?
            .iter()
            .map(ToString::to_string),
    )?;
    let rows = source
        .filter(|row| row.iter().any(|value| !matches!(value, Data::Empty)))
        .map(|row| {
            fields
                .iter()
                .cloned()
                .zip(row.iter().map(excel_value))
                .collect::<Map<_, _>>()
        })
        .map(Value::Object)
        .collect();
    Ok(rows)
}

fn guess_value(text: &str) -> Value {
    if text.is_empty() {
        return Value::Null;
    }
    // Preserve identifiers such as 00123; only unambiguous JSON numbers and booleans become typed values.
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(|value| value.is_number() || value.is_boolean())
        .unwrap_or_else(|| Value::String(text.to_owned()))
}

fn excel_value(value: &Data) -> Value {
    match value {
        Data::Int(value) => json!(value),
        Data::Float(value) => json!(value),
        Data::Bool(value) => json!(value),
        Data::Empty => Value::Null,
        _ => Value::String(value.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_preserves_quoted_newlines_identifiers_and_numeric_types() {
        let rows = csv(
            "编号,金额,备注\n00123,12.5,\"第一行\n第二行\"\n".as_bytes(),
            b',',
        )
        .unwrap();
        assert_eq!(rows[0]["编号"], "00123");
        assert_eq!(rows[0]["金额"], 12.5);
        assert_eq!(rows[0]["备注"], "第一行\n第二行");
        assert!(csv(b"name,name\na,b", b',').is_err());
    }
}
