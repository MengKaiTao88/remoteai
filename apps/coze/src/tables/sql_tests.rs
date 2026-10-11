use super::*;

fn table(db: &Database, name: &str) -> String {
    resources::save(
        db,
        ResourceInput {
            id: None,
            revision: None,
            kind: ResourceKind::Table,
            name: name.into(),
            description: String::new(),
            draft: json!({}),
        },
    )
    .unwrap()
    .id
}

#[test]
fn queries_join_aggregate_and_only_read_selected_tables() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let sales = table(&db, "销售");
    let clients = table(&db, "客户");
    write(&db, &sales, None, json!({"客户":"张三","金额":12})).unwrap();
    write(&db, &sales, None, json!({"客户":"张三","金额":8})).unwrap();
    write(&db, &clients, None, json!({"姓名":"张三","城市":"上海"})).unwrap();
    let result = run_sql(&db, SqlRequest { tables: vec![sales.clone(), clients],
        sql: "SELECT t2.城市, SUM(t1.金额) AS 总额 FROM t1 JOIN t2 ON t1.客户=t2.姓名 GROUP BY t2.城市".into() }).unwrap();
    assert_eq!(result["rows"][0][0], "上海");
    assert_eq!(result["rows"][0][1], 20.0);
    for sql in [
        "SELECT * FROM resources",
        "SELECT * FROM sqlite_master",
        "SELECT * FROM pragma_database_list",
        "SELECT load_extension('bad')",
        "DELETE FROM t1",
        "ATTACH DATABASE 'test.db' AS external",
        "WITH RECURSIVE a(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM a) SELECT max(x) FROM a",
    ] {
        assert!(
            run_sql(
                &db,
                SqlRequest {
                    tables: vec![sales.clone()],
                    sql: sql.into()
                }
            )
            .is_err(),
            "{sql}"
        );
    }
    assert_eq!(
        query(&db, &sales, &json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn schema_changes_validate_existing_rows_and_reject_stale_edits() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let id = table(&db, "结构");
    write(&db, &id, None, json!({"年龄":30})).unwrap();
    let columns = vec![Column {
        name: "年龄".into(),
        kind: ColumnKind::Integer,
        required: true,
    }];
    let saved = save_schema(
        &db,
        SchemaInput {
            table_id: id.clone(),
            revision: 0,
            columns: columns.clone(),
        },
    )
    .unwrap();
    assert_eq!(saved.revision, 1);
    assert!(write(&db, &id, None, json!({"年龄":"三十"})).is_err());
    assert!(write(&db, &id, None, json!({})).is_err());
    assert!(matches!(
        save_schema(
            &db,
            SchemaInput {
                table_id: id.clone(),
                revision: 0,
                columns
            }
        ),
        Err(Error::Conflict)
    ));
    assert!(save_schema(
        &db,
        SchemaInput {
            table_id: id.clone(),
            revision: 1,
            columns: vec![Column {
                name: "年龄".into(),
                kind: ColumnKind::Boolean,
                required: true
            }]
        }
    )
    .is_err());
    assert_eq!(get_schema(&db, &id).unwrap().revision, 1);
}

#[test]
fn table_import_rolls_back_all_records_if_one_row_violates_schema() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let id = table(&db, "批量导入");
    save_schema(
        &db,
        SchemaInput {
            table_id: id.clone(),
            revision: 0,
            columns: vec![Column {
                name: "数量".into(),
                kind: ColumnKind::Integer,
                required: true,
            }],
        },
    )
    .unwrap();
    assert!(import_rows(
        &db,
        ImportRowsRequest {
            table_id: id.clone(),
            name: "记录.csv".into(),
            content_base64: STANDARD.encode("数量\n3\ninvalid\n")
        }
    )
    .is_err());
    assert!(query(&db, &id, &json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    let result = import_rows(
        &db,
        ImportRowsRequest {
            table_id: id.clone(),
            name: "记录.csv".into(),
            content_base64: STANDARD.encode("数量\n3\n5\n"),
        },
    )
    .unwrap();
    assert_eq!(result["inserted"], 2);
    let first_page = list_page(&db, &id, 0, 1).unwrap();
    let second_page = list_page(&db, &id, 1, 1).unwrap();
    assert_eq!(first_page["total"], 2);
    assert_eq!(first_page["items"].as_array().unwrap().len(), 1);
    assert_ne!(first_page["items"][0]["id"], second_page["items"][0]["id"]);
    assert_eq!(
        query(&db, &id, &json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn row_update_is_scoped_and_never_inserts_missing_ids() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let first = table(&db, "一");
    let second = table(&db, "二");
    let row = write(&db, &first, None, json!({"v":1})).unwrap();
    let id = row["id"].as_str().unwrap();
    assert!(matches!(
        update(&db, &second, id, json!({"v":2})),
        Err(Error::NotFound)
    ));
    assert!(matches!(
        update(
            &db,
            &first,
            &uuid::Uuid::new_v4().to_string(),
            json!({"v":2})
        ),
        Err(Error::NotFound)
    ));
    update(&db, &first, id, json!({"v":2})).unwrap();
    assert_eq!(
        list_page(&db, &first, 0, 10).unwrap()["items"][0]["value"]["v"],
        2
    );
    assert_eq!(list_page(&db, &first, 0, 10).unwrap()["total"], 1);
}
