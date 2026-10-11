use super::*;
use crate::{
    database::Database,
    embedding::Embedder,
    error::{Error, Result},
    knowledge::{
        documents::{index, PreparedDocument},
        list_documents, read_chunks, ChunkOptions,
    },
    model::{ResourceInput, ResourceKind},
    resources,
};
use serde_json::json;

struct FixedEmbedder;
impl Embedder for FixedEmbedder {
    fn encode(&self, _text: &str, _query: bool) -> Result<Vec<f32>> {
        Ok(vec![1.0, 0.0])
    }
    fn model_id(&self) -> &str {
        "source-test"
    }
}

struct BrokenEmbedder;
impl Embedder for BrokenEmbedder {
    fn encode(&self, _text: &str, _query: bool) -> Result<Vec<f32>> {
        Err(Error::Embedding)
    }
    fn model_id(&self) -> &str {
        "broken-test"
    }
}

fn knowledge(db: &Database) -> String {
    resources::save(
        db,
        ResourceInput {
            id: None,
            revision: None,
            kind: ResourceKind::Knowledge,
            name: "网页资料".into(),
            description: String::new(),
            draft: json!({}),
        },
    )
    .unwrap()
    .id
}

fn prepared(id: &str, content: &str) -> PreparedDocument {
    let mut source = storage::SourceInfo::new("web", "text/html");
    source.url = Some("https://example.com/reference".into());
    PreparedDocument {
        knowledge_id: id.into(),
        name: "参考资料".into(),
        bytes: content.as_bytes().to_vec(),
        text: content.into(),
        chunk: ChunkOptions::default(),
        source: Some(source),
        replacing: None,
    }
}

#[test]
fn html_import_uses_visible_text_and_decodes_entities() {
    let html = "<html><head><title>产品 &amp; 说明</title><style>secret</style></head><body>\
        <nav>广告</nav><h1>使用指南</h1><p>价格 &lt; 100</p><script>steal()</script>\
        <div hidden>隐藏信息</div><table><tr><td>功能</td><td>知识库</td></tr></table></body></html>";
    let (title, text) = web::extract_html(html).unwrap();
    assert_eq!(title, "产品 & 说明");
    assert!(text.contains("价格 < 100"));
    assert!(text.contains("知识库"));
    assert!(!text.contains("secret") && !text.contains("广告") && !text.contains("steal"));
    assert!(!text.contains("隐藏信息"));
}

#[test]
fn web_fetch_rejects_local_special_and_credential_destinations() {
    for address in [
        "127.0.0.1",
        "10.1.2.3",
        "169.254.169.254",
        "100.64.1.2",
        "192.0.0.2",
        "198.18.0.1",
        "224.0.0.1",
        "::1",
        "::ffff:8.8.8.8",
        "2001:db8::1",
        "2002:7f00:1::",
    ] {
        assert!(!fetch::public_ip(address.parse().unwrap()), "{address}");
    }
    assert!(fetch::public_ip("8.8.8.8".parse().unwrap()));
    assert!(fetch::public_ip("2606:4700:4700::1111".parse().unwrap()));
    assert!(fetch::validate_url("http://example.com").is_err());
    assert!(fetch::validate_url("https://user:pass@example.com").is_err());
}

#[test]
fn source_refresh_is_atomic_and_preserves_document_identity() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let id = knowledge(&db);
    let document = index(&db, &FixedEmbedder, prepared(&id, "第一版内容")).unwrap();
    let hash: String = db
        .connect()
        .unwrap()
        .query_row(
            "SELECT source_hash FROM documents WHERE id=?1",
            [&document.id],
            |row| row.get(0),
        )
        .unwrap();
    let mut replacement = prepared(&id, "第二版内容");
    replacement.replacing = Some((document.id.clone(), hash.clone()));
    assert!(index(&db, &BrokenEmbedder, replacement).is_err());
    assert_eq!(
        read_chunks(&db, &document.id).unwrap()[0]["text"],
        "第一版内容"
    );
    let mut replacement = prepared(&id, "第二版内容");
    replacement.replacing = Some((document.id.clone(), hash.clone()));
    assert_eq!(
        index(&db, &FixedEmbedder, replacement).unwrap().id,
        document.id
    );
    assert_eq!(list_documents(&db, &id).unwrap().len(), 1);
    assert_eq!(
        read_chunks(&db, &document.id).unwrap()[0]["text"],
        "第二版内容"
    );
    assert_eq!(list_sources(&db, &id).unwrap()[0].kind, "web");
    let mut stale = prepared(&id, "过期覆盖");
    stale.replacing = Some((document.id.clone(), hash));
    assert!(matches!(
        index(&db, &FixedEmbedder, stale),
        Err(Error::Conflict)
    ));
    crate::knowledge::delete_document(&db, &document.id).unwrap();
    assert!(list_sources(&db, &id).unwrap().is_empty());
}

#[test]
fn image_import_calls_local_vision_and_preserves_original_for_preview() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}/v1", server.server_addr());
    let worker = std::thread::spawn(move || {
        let mut request = server.recv().unwrap();
        let mut body = String::new();
        request.as_reader().read_to_string(&mut body).unwrap();
        let body: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(request.url(), "/v1/chat/completions");
        assert_eq!(body["messages"][0]["content"][1]["type"], "image_url");
        request
            .respond(
                tiny_http::Response::from_string(
                    json!({"choices":[{"message":{
            "content":"照片显示猫躺在窗台上，标签文字为：小橘。"}}]})
                    .to_string(),
                )
                .with_header(
                    tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
                ),
            )
            .unwrap();
    });
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let id = knowledge(&db);
    let content = STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture");
    let proxy = crate::proxy::ModelProxy::new(&address, "local-test".into()).unwrap();
    let document = import_media(
        &db,
        &FixedEmbedder,
        &proxy,
        ImportMediaDocument {
            knowledge_id: id,
            name: "小猫.png".into(),
            content_base64: content.clone(),
            model: "vision".into(),
            chunk: ChunkOptions::default(),
        },
    )
    .unwrap();
    worker.join().unwrap();
    assert!(read_chunks(&db, &document.id).unwrap()[0]["text"]
        .as_str()
        .unwrap()
        .contains("小橘"));
    let source = document_source(&db, &document.id).unwrap();
    assert_eq!(source.kind, "image");
    assert_eq!(source.content_base64, Some(content));
}
