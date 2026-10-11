use super::*;
use crate::{
    api::Services,
    database::Database,
    embedding::Embedder,
    error::{Error, Result},
    jobs::JobControl,
    model::{ResourceInput, ResourceKind},
    proxy::ModelProxy,
    resources,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

struct CancellingEmbedder(JobControl);
impl Embedder for CancellingEmbedder {
    fn encode(&self, _text: &str, _query: bool) -> Result<Vec<f32>> {
        self.0.cancel();
        Ok(vec![1.0, 0.0])
    }
    fn model_id(&self) -> &str {
        "cancel-fixture"
    }
}

struct FixedEmbedder;
impl Embedder for FixedEmbedder {
    fn encode(&self, _text: &str, _query: bool) -> Result<Vec<f32>> {
        Ok(vec![1.0, 0.0])
    }
    fn model_id(&self) -> &str {
        "fixed-fixture"
    }
}

fn knowledge(db: &Database) -> String {
    resources::save(
        db,
        ResourceInput {
            id: None,
            revision: None,
            kind: ResourceKind::Knowledge,
            name: "取消导入测试".into(),
            description: String::new(),
            draft: json!({}),
        },
    )
    .unwrap()
    .id
}

#[test]
fn cancelling_during_embedding_does_not_commit_partial_documents() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let id = knowledge(&db);
    let control = JobControl::detached();
    let result = import_document_controlled(
        &db,
        &CancellingEmbedder(control.clone()),
        ImportDocument {
            knowledge_id: id.clone(),
            name: "文档.md".into(),
            content_base64: STANDARD.encode("知识内容".repeat(300)),
            chunk: ChunkOptions::default(),
        },
        &control,
    );
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(list_documents(&db, &id).unwrap().is_empty());
}

#[test]
fn cancelling_an_image_job_interrupts_active_model_request_without_saving() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let address = format!("http://{}/v1", server.server_addr());
    let (arrived, arrival) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let listener = std::thread::spawn(move || {
        let request = server
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        arrived.send(()).unwrap();
        released.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(request);
    });
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open(directory.path()).unwrap();
    let id = knowledge(&db);
    let services = Services::new(
        db.clone(),
        Arc::new(FixedEmbedder),
        ModelProxy::new(&address, "test".into()).unwrap(),
    );
    let job = start_import(
        &services,
        ImportTask::Media(sources::ImportMediaDocument {
            knowledge_id: id.clone(),
            name: "图片.png".into(),
            content_base64: STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture"),
            model: "vision".into(),
            chunk: ChunkOptions::default(),
        }),
    )
    .unwrap();
    let job_id = job["id"].as_str().unwrap();
    arrival.recv_timeout(Duration::from_secs(5)).unwrap();
    services.jobs.cancel(job_id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let state = services.jobs.status(job_id, 0).unwrap();
        if state["status"] != "running" {
            assert_eq!(state["status"], "cancelled");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "visual request did not cancel promptly"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(list_documents(&db, &id).unwrap().is_empty());
    release.send(()).unwrap();
    listener.join().unwrap();
}
