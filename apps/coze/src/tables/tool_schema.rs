//! Describe real table fields to the model without including row contents in tool metadata.
use super::{get_schema, ColumnKind};
use crate::{database::Database, error::Result};
use serde_json::{json, Map, Value};

const SCHEMA_SAMPLE_ROWS: usize = 100;

pub(crate) fn query_schema(db: &Database, id: &str) -> Result<Value> {
    let columns = get_schema(db, id)?.columns;
    let mut properties = Map::new();
    for column in &columns {
        let kind = match column.kind {
            ColumnKind::String | ColumnKind::Time => json!(["string", "null"]),
            ColumnKind::Integer => json!(["integer", "null"]),
            ColumnKind::Number => json!(["number", "null"]),
            ColumnKind::Boolean => json!(["boolean", "null"]),
            ColumnKind::Json => Value::Null,
        };
        let schema = if kind.is_null() {
            json!({})
        } else {
            json!({"type":kind})
        };
        properties.insert(column.name.clone(), schema);
    }
    if columns.is_empty() {
        properties = infer_fields(db, id)?;
    }
    Ok(json!({"type":"object","properties":{"filter":{
        "type":"object","description":"Exact equality by column name. All supplied fields must match. \
            Omit filter or use {} to list rows. Values are literal values, not comparison operators.",
        "properties":properties,"additionalProperties":columns.is_empty()}},
        "additionalProperties":false}))
}

fn infer_fields(db: &Database, id: &str) -> Result<Map<String, Value>> {
    // Schemaless imports can contain mixed value types. Discover names from a bounded sample,
    // but keep values unconstrained and permit fields outside that sample.
    let conn = db.connect()?;
    let mut statement = conn.prepare(
        "SELECT DISTINCT field.key FROM
         (SELECT value FROM table_rows WHERE table_id=?1 ORDER BY updated_at DESC LIMIT ?2) AS sample,
         json_each(sample.value) AS field ORDER BY field.key LIMIT 100",
    )?;
    let names = statement.query_map(rusqlite::params![id, SCHEMA_SAMPLE_ROWS], |row| {
        row.get::<_, String>(0)
    })?;
    names.map(|name| Ok((name?, json!({})))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::*, resources, tables};

    #[test]
    fn query_tools_describe_imported_and_defined_columns_without_row_values() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        let table = resources::save(
            &db,
            ResourceInput {
                id: None,
                kind: ResourceKind::Table,
                name: "Lookup".into(),
                description: String::new(),
                draft: json!({}),
                revision: None,
            },
        )
        .unwrap();
        tables::write(
            &db,
            &table.id,
            None,
            json!({"code":"VM_SECRET","value":"hidden"}),
        )
        .unwrap();
        let schema = query_schema(&db, &table.id).unwrap();
        let filter = &schema["properties"]["filter"];
        assert!(filter["properties"].get("code").is_some());
        assert!(filter["properties"].get("value").is_some());
        assert!(!schema.to_string().contains("hidden"));
        assert!(!schema.to_string().contains("VM_SECRET"));
        tables::save_schema(
            &db,
            tables::SchemaInput {
                table_id: table.id.clone(),
                revision: 0,
                columns: ["code", "value"]
                    .map(|name| tables::Column {
                        name: name.into(),
                        kind: ColumnKind::String,
                        required: true,
                    })
                    .to_vec(),
            },
        )
        .unwrap();
        let schema = query_schema(&db, &table.id).unwrap();
        assert_eq!(
            schema["properties"]["filter"]["additionalProperties"],
            false
        );
        assert_eq!(
            schema["properties"]["filter"]["properties"]["code"]["type"],
            json!(["string", "null"])
        );
    }
}
