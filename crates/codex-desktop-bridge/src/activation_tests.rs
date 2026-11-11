use super::tests;
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn long_history_above_the_old_transport_limit_keeps_messages_and_model_settings() {
    let fixture = tests::fixture(false).await;
    fixture
        .output_bytes
        .store(17 * 1024 * 1024, Ordering::SeqCst);
    let client = tests::client(&fixture).await;
    let read = client
        .request(json!({"operation":"read","threadId":tests::THREAD}))
        .await
        .unwrap();
    assert_eq!(
        read["thread"]["turns"][0]["items"][0]["content"][0]["text"],
        "hello"
    );
    assert_eq!(
        read["thread"]["turns"][0]["items"][2]["aggregatedOutput"]
            .as_str()
            .unwrap()
            .len(),
        17 * 1024 * 1024
    );
    let settings = client.model_settings(tests::THREAD).await.unwrap();
    assert_eq!(
        settings["selection"],
        json!({"model":"model-a","effort":"high"})
    );
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 0);
    client.close().await;
}

#[tokio::test]
async fn older_completed_turn_hydration_is_not_reported_as_a_completion_now() {
    let fixture = tests::fixture(false).await;
    let client = tests::client(&fixture).await;
    let mut events = client.subscribe();
    let first = json!({"id":tests::THREAD,"sequence":1,"turns":[]});
    client.accept(&first).await.unwrap();
    let _ = events.recv().await.unwrap();
    client
        .accept(&json!({"id":tests::THREAD,"sequence":2,"turns":[{
        "id":"old","status":"completed","startedAt":1700000000000u64,
        "messages":[{"id":"answer","kind":"agentMessage","text":"Saved answer"}]}]}))
        .await
        .unwrap();
    let event = events.recv().await.unwrap();
    assert_eq!(event["method"], "thread/started");
    assert_eq!(
        event["params"]["thread"]["turns"][0]["items"][0]["text"],
        "Saved answer"
    );
    assert!(event["params"]["thread"]["turns"][0]["completedAt"].is_null());
    assert!(events.try_recv().is_err());
    client.close().await;
}

#[tokio::test]
async fn unloaded_saved_history_waits_for_hydration_without_posting_activation() {
    let fixture = tests::fixture(false).await;
    fixture.connected.store(false, Ordering::SeqCst);
    fixture.hydration_reads.store(2, Ordering::SeqCst);
    let client = tests::client(&fixture).await;
    let result = client
        .request(json!({"operation":"read", "threadId":tests::THREAD}))
        .await
        .unwrap();
    assert_eq!(result["thread"]["turns"][0]["id"], "turn-1");
    assert_eq!(result["thread"]["status"]["type"], "notLoaded");
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 0);
    assert!(!fixture.connected.load(Ordering::SeqCst));
    client.close().await;
}

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
