use remoteai_coze::embedding::{encode_vector, similarity, Embedder, LocalEmbedder};

#[test]
#[ignore = "requires the separately downloaded model; CI runs this explicitly after preparing assets"]
fn multilingual_semantics_work_without_any_network_or_api_key() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("dist/models");
    let embedder = LocalEmbedder::new(&root);
    let query = embedder.encode("怎样更改登录密码？", true).unwrap();
    let relevant = embedder
        .encode("在账户设置中选择安全，然后重置您的密码。", false)
        .unwrap();
    let irrelevant = embedder
        .encode("今天的晚餐是番茄意大利面和蔬菜沙拉。", false)
        .unwrap();
    assert_eq!(query.len(), 384);
    assert!(
        similarity(&query, &encode_vector(&relevant))
            > similarity(&query, &encode_vector(&irrelevant))
    );
}
