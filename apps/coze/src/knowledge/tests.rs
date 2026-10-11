use super::*;
use crate::{
    database::Database,
    embedding::Embedder,
    error::{Error, Result},
    model::{ResourceInput, ResourceKind},
    resources,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;

struct FixtureEmbedder;
impl Embedder for FixtureEmbedder {
    fn encode(&self, text: &str, _query: bool) -> Result<Vec<f32>> {
        Ok(if text.contains("猫") {
            vec![1.0, 0.0]
        } else {
            vec![0.0, 1.0]
        })
    }
    fn model_id(&self) -> &str {
        "fixture-v1"
    }
}

struct BrokenEmbedder;
impl Embedder for BrokenEmbedder {
    fn encode(&self, _text: &str, _query: bool) -> Result<Vec<f32>> {
        Err(Error::Embedding)
    }
    fn model_id(&self) -> &str {
        "broken"
    }
}

fn knowledge(db: &Database, name: &str) -> String {
    resources::save(
        db,
        ResourceInput {
            id: None,
            kind: ResourceKind::Knowledge,
            name: name.into(),
            description: String::new(),
            draft: json!({}),
            revision: None,
        },
    )
    .unwrap()
    .id
}

fn input(knowledge_id: &str, text: &str) -> ImportDocument {
    ImportDocument {
        knowledge_id: knowledge_id.into(),
        name: "中文.md".into(),
        content_base64: STANDARD.encode(text),
        chunk: ChunkOptions::default(),
    }
}

#[test]
fn unicode_chunks_preserve_overlap_without_losing_tail() {
    let original: String = (0..300)
        .map(|index| char::from_u32(0x4e00 + index).unwrap())
        .collect();
    let chunks = split(
        &original,
        ChunkOptions {
            size: 100,
            overlap: 20,
        },
    )
    .unwrap();
    assert_eq!(chunks.len(), 4);
    assert_eq!(
        chunks[0].chars().skip(80).collect::<String>(),
        chunks[1].chars().take(20).collect::<String>()
    );
    let reconstructed = chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            chunk
                .chars()
                .skip(if index == 0 { 0 } else { 20 })
                .collect::<String>()
        })
        .collect::<String>();
    assert_eq!(reconstructed, original);
    assert!(split(
        "text",
        ChunkOptions {
            size: 100,
            overlap: 60
        }
    )
    .is_err());
}

#[test]
fn imports_survive_restart_are_deduplicated_and_cascade_with_search_index() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let id = knowledge(&db, "宠物");
    let first = import_document(
        &db,
        &FixtureEmbedder,
        input(&id, "猫喜欢温暖的地方。猫会打呼噜。"),
    )
    .unwrap();
    let duplicate = import_document(
        &db,
        &FixtureEmbedder,
        input(&id, "猫喜欢温暖的地方。猫会打呼噜。"),
    )
    .unwrap();
    assert_eq!(first.id, duplicate.id);
    let db = Database::open(directory.path()).unwrap();
    assert_eq!(list_documents(&db, &id).unwrap().len(), 1);
    let matches = search(
        &db,
        &FixtureEmbedder,
        SearchRequest {
            knowledge_ids: vec![id.clone()],
            query: "猫".into(),
            limit: 6,
        },
    )
    .unwrap();
    assert_eq!(matches[0].document_name, "中文.md");
    assert!(matches[0].text.contains("呼噜"));
    delete_document(&db, &first.id).unwrap();
    let count: u32 = db
        .connect()
        .unwrap()
        .query_row("SELECT count(*) FROM chunk_search", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn failed_embedding_never_leaves_partial_documents_or_crosses_knowledge_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let cats = knowledge(&db, "猫");
    let dogs = knowledge(&db, "狗");
    assert!(import_document(&db, &BrokenEmbedder, input(&cats, "失败文档")).is_err());
    assert!(list_documents(&db, &cats).unwrap().is_empty());
    import_document(&db, &FixtureEmbedder, input(&cats, "猫喜欢阳光")).unwrap();
    import_document(&db, &FixtureEmbedder, input(&dogs, "狗喜欢散步")).unwrap();
    let matches = search(
        &db,
        &FixtureEmbedder,
        SearchRequest {
            knowledge_ids: vec![dogs],
            query: "猫".into(),
            limit: 6,
        },
    )
    .unwrap();
    assert!(matches.iter().all(|item| !item.text.contains("猫")));
}

#[test]
fn malformed_documents_and_paths_do_not_escape_parser() {
    assert!(parse::extract("document.pdf", b"not a pdf").is_err());
    assert!(parse::extract("file.exe", b"hello").is_err());
    assert!(parse::extract("empty.txt", b"  ").is_err());
}

#[test]
fn editing_a_chunk_replaces_its_index_and_rejects_stale_editors() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let id = knowledge(&db, "分段编辑");
    let document = import_document(&db, &FixtureEmbedder, input(&id, "猫喜欢阳光")).unwrap();
    let chunks = read_chunks(&db, &document.id).unwrap();
    let chunk = chunks[0]["id"].as_str().unwrap();
    update_chunk(
        &db,
        &FixtureEmbedder,
        ChunkUpdate {
            id: chunk.into(),
            text: "狗喜欢散步".into(),
            previous: "猫喜欢阳光".into(),
        },
    )
    .unwrap();
    assert!(matches!(
        update_chunk(
            &db,
            &FixtureEmbedder,
            ChunkUpdate {
                id: chunk.into(),
                text: "旧页面覆盖".into(),
                previous: "猫喜欢阳光".into()
            }
        ),
        Err(Error::Conflict)
    ));
    let found = search(
        &db,
        &FixtureEmbedder,
        SearchRequest {
            knowledge_ids: vec![id],
            query: "狗".into(),
            limit: 6,
        },
    )
    .unwrap();
    assert_eq!(found[0].text, "狗喜欢散步");
    let count: u32 = db
        .connect()
        .unwrap()
        .query_row("SELECT count(*) FROM chunk_search", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}
