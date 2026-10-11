use super::*;
use crate::{
    api::Services,
    embedding::Embedder,
    error::Result,
    model::{ResourceInput, ResourceKind},
    resources,
};
use serde_json::{json, Value};

struct FixedEmbedding;
impl Embedder for FixedEmbedding {
    fn encode(&self, _text: &str, _query: bool) -> Result<Vec<f32>> {
        Ok(vec![1.0, 0.0])
    }
    fn model_id(&self) -> &str {
        "workflow-fixture"
    }
}

fn resource(services: &Services, kind: ResourceKind) -> String {
    resources::save(
        &services.db,
        ResourceInput {
            id: None,
            kind,
            name: "节点测试".into(),
            description: String::new(),
            draft: json!({}),
            revision: None,
        },
    )
    .unwrap()
    .id
}

fn evaluate(services: &Services, action: Value) -> Result<Value> {
    let mut node = action;
    node["id"] = json!("node");
    node["name"] = json!("测试");
    super::engine::evaluate(
        &RuntimeContext::new(services, false),
        &serde_json::from_value(node).unwrap(),
        &mut json!({"input":{},"variables":{}}),
    )
}

#[test]
fn knowledge_write_indexes_text_and_batch_delete_cannot_cross_knowledge_bases() {
    let (_directory, mut services) = super::tests::fixture();
    services.embedder = std::sync::Arc::new(FixedEmbedding);
    let first = resource(&services, ResourceKind::Knowledge);
    let second = resource(&services, ResourceKind::Knowledge);
    let document = evaluate(
        &services,
        json!({"type":"knowledge_write","knowledge_id":first,
        "document_name":"退货说明","text":"购买图书后七天内可以申请退货。"}),
    )
    .unwrap();
    let foreign = evaluate(
        &services,
        json!({"type":"knowledge_write","knowledge_id":second,
        "document_name":"外部文档","text":"不得被其他知识库删除。"}),
    )
    .unwrap();
    let found = evaluate(
        &services,
        json!({"type":"knowledge","knowledge_ids":[first],"query":"如何退货？","limit":2}),
    )
    .unwrap();
    assert!(!found["citations"].as_array().unwrap().is_empty());
    assert!(evaluate(
        &services,
        json!({"type":"knowledge_delete","knowledge_id":first,
        "document_ids":[document["id"],foreign["id"]]})
    )
    .is_err());
    assert_eq!(
        crate::knowledge::list_documents(&services.db, &first)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        evaluate(
            &services,
            json!({"type":"knowledge_delete","knowledge_id":first,
        "document_ids":[document["id"]]})
        )
        .unwrap()["deleted"],
        1
    );
    assert!(crate::knowledge::list_documents(&services.db, &first)
        .unwrap()
        .is_empty());
    assert_eq!(
        crate::knowledge::list_documents(&services.db, &second)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn sql_and_update_nodes_use_only_selected_existing_records() {
    let (_directory, services) = super::tests::fixture();
    let table = resource(&services, ResourceKind::Table);
    let row = crate::tables::write(&services.db, &table, None, json!({"amount":2})).unwrap();
    evaluate(
        &services,
        json!({"type":"table_update","table_id":table,"row_id":row["id"],"value":{"amount":5}}),
    )
    .unwrap();
    let result = evaluate(
        &services,
        json!({"type":"sql","table_ids":[table],"sql":"SELECT sum(amount) FROM t1"}),
    )
    .unwrap();
    assert_eq!(result["rows"][0][0], 5.0);
    assert!(evaluate(
        &services,
        json!({"type":"sql","table_ids":[table],"sql":"SELECT * FROM resources"})
    )
    .is_err());
    assert!(evaluate(
        &services,
        json!({"type":"table_update","table_id":table,
        "row_id":uuid::Uuid::new_v4().to_string(),"value":{"amount":9}})
    )
    .is_err());
    assert_eq!(
        crate::tables::query(&services.db, &table, &json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn intent_node_uses_proxy_stream_and_rejects_labels_outside_its_schema() {
    let (_directory, mut services) = super::tests::fixture();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    services.proxy = crate::proxy::ModelProxy::new(
        &format!("http://{}/v1", server.server_addr()),
        "fixture".into(),
    )
    .unwrap();
    let worker = std::thread::spawn(move || {
        for label in ["退款", "未知标签"] {
            let request = server
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap()
                .unwrap();
            let data =
                json!({"choices":[{"delta":{"content":json!({"intent":label}).to_string()}}]});
            request
                .respond(
                    tiny_http::Response::from_string(format!("data: {data}\n\ndata: [DONE]\n\n"))
                        .with_header(
                            tiny_http::Header::from_bytes("Content-Type", "text/event-stream")
                                .unwrap(),
                        ),
                )
                .unwrap();
        }
    });
    let node =
        json!({"type":"intent","model":"fixture","query":"我想退货","intents":["退款","咨询"]});
    assert_eq!(
        evaluate(&services, node.clone()).unwrap(),
        json!({"intent":"退款"})
    );
    assert!(evaluate(&services, node).is_err());
    worker.join().unwrap();
}
