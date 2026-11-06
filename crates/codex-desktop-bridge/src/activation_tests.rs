use super::tests;
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn delayed_activation_is_reconciled_by_reading_without_replaying_writes() {
    let fixture = tests::fixture(false).await;
    fixture.connected.store(false, Ordering::SeqCst);
    let client = tests::client(&fixture).await;
    client
        .request(json!({"operation":"read", "threadId":tests::THREAD}))
        .await
        .unwrap();
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 0);
    client
        .request(json!({"operation":"resume", "threadId":tests::THREAD}))
        .await
        .unwrap();
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 1);
    assert!(fixture.connected.load(Ordering::SeqCst));
    client
        .request(json!({"operation":"resume", "threadId":tests::THREAD}))
        .await
        .unwrap();
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 0);
    client.close().await;
}
