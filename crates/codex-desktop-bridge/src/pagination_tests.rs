use super::tests::{client, fixture};
use serde_json::json;

#[tokio::test]
async fn cumulative_gateway_rows_produce_disjoint_pages_and_a_terminal_cursor() {
    let fixture = fixture(false).await;
    *fixture.sessions.lock().await = (0..5)
        .map(|index| {
            json!({"id":format!("00000000-0000-4000-8000-{index:012}"),
            "title":format!("Chat {index}"),"cwd":"C:/fixture","recency":100-index})
        })
        .collect();
    let client = client(&fixture).await;
    let mut cursor = None;
    let mut ids = Vec::new();
    for expected_size in [2, 2, 1] {
        let response = client
            .request(json!({"operation":"list","limit":2,"cursor":cursor}))
            .await
            .unwrap();
        let page = response["data"].as_array().unwrap();
        assert_eq!(page.len(), expected_size);
        ids.extend(
            page.iter()
                .map(|row| row["id"].as_str().unwrap().to_owned()),
        );
        cursor = response["nextCursor"].as_str().map(str::to_owned);
    }
    assert!(
        cursor.is_none(),
        "The cumulative prefix must not create an endless cursor"
    );
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(
        unique.len(),
        5,
        "Older pages must not repeat the first chats"
    );
    let exhausted = client
        .request(json!({"operation":"list","limit":2,"cursor":"5"}))
        .await
        .unwrap();
    assert_eq!(exhausted["data"], json!([]));
    assert!(exhausted["nextCursor"].is_null());
    client.close().await;
}
