use super::*;
use serde_json::json;
use std::sync::atomic::Ordering;

fn start(cwd: Option<&str>) -> Value {
    json!({"operation":"start","cwd":cwd,"title":"Creation fixture","access":"read-only"})
}

#[tokio::test]
async fn independent_creation_waits_for_owner_and_sends_nothing_until_explicit_delivery() {
    let fixture = tests::fixture(false).await;
    fixture.creation_wait.store(2, Ordering::SeqCst);
    let client = tests::client(&fixture).await;
    let result = client.request(start(None)).await.unwrap();
    assert_eq!(result["thread"]["id"], tests::THREAD);
    assert_ne!(result["thread"]["status"]["type"], "notLoaded");
    assert_eq!(fixture.creation_wait.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.creations.lock().await.len(), 1);
    assert_eq!(
        fixture.creations.lock().await[0]["project"],
        "local|independent"
    );
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 0);
    fixture.permission_confirmed.store(false, Ordering::SeqCst);
    let send = json!({"operation":"send","threadId":tests::THREAD,"text":"test"});
    assert!(matches!(
        client.request(send.clone()).await,
        Err(Error::Stale)
    ));
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 0);
    fixture.permission_confirmed.store(true, Ordering::SeqCst);
    client.request(send).await.unwrap();
    assert_eq!(
        client.model_settings(tests::THREAD).await.unwrap()["access"],
        "read-only"
    );
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.creations.lock().await.len(), 1);
    client.close().await;
}

#[tokio::test]
async fn new_chat_can_save_model_and_send_when_native_effort_is_unset() {
    let fixture = tests::fixture(false).await;
    fixture.empty_without_effort.store(true, Ordering::SeqCst);
    let client = tests::client(&fixture).await;
    client.request(start(None)).await.unwrap();

    let settings = client.model_settings(tests::THREAD).await.unwrap();
    assert_eq!(settings["threadId"], tests::THREAD);
    assert!(settings["selection"].is_null());
    assert_eq!(settings["access"], "danger-full-access");
    let access = client
        .set_access_settings(tests::THREAD, "read-only")
        .await
        .unwrap();
    assert_eq!(access["access"], "read-only");

    let selection = json!({"model":"model-b","effort":"low"});
    let saved = client
        .set_model_settings(tests::THREAD, &selection)
        .await
        .unwrap();
    assert_eq!(saved["selection"], selection);
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 0);
    let send = json!({"operation":"send","threadId":tests::THREAD,"text":"First message",
        "model":"model-b","effort":"low"});
    client.request(send).await.unwrap();
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.creations.lock().await.len(), 1);
    client.close().await;
}

#[tokio::test]
async fn saved_project_creation_resolves_membership_and_rejects_unknown_or_invalid_requests() {
    let fixture = tests::fixture(false).await;
    let client = tests::client(&fixture).await;
    client.request(start(Some("C:\\fixture"))).await.unwrap();
    assert_eq!(
        fixture.creations.lock().await[0]["project"],
        "local|fixture"
    );
    assert!(matches!(
        client.request(start(Some("C:\\missing"))).await,
        Err(Error::Invalid)
    ));
    for (key, invalid) in [
        ("title", json!("")),
        ("access", json!("invalid")),
        ("cwd", json!(42)),
    ] {
        let mut request = start(None);
        request[key] = invalid;
        assert!(matches!(client.request(request).await, Err(Error::Invalid)));
    }
    assert_eq!(fixture.creations.lock().await.len(), 1);
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 0);
    client.close().await;
}

#[tokio::test]
async fn uncertain_creation_is_never_automatically_replayed_or_followed_by_a_send() {
    let fixture = tests::fixture(true).await;
    let client = tests::client(&fixture).await;
    assert!(matches!(
        client.request(start(None)).await,
        Err(Error::UnknownWrite)
    ));
    assert_eq!(fixture.creations.lock().await.len(), 1);
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 0);
    client.close().await;
}

#[tokio::test]
async fn slow_attachment_preserves_the_created_chat_identity_for_recovery() {
    let fixture = tests::fixture(false).await;
    fixture.connected.store(false, Ordering::SeqCst);
    let client = tests::client(&fixture).await;
    let result = client.request(start(None)).await.unwrap();
    assert_eq!(result["thread"]["id"], tests::THREAD);
    assert_eq!(result["thread"]["status"]["type"], "notLoaded");
    let send = json!({"operation":"send","threadId":tests::THREAD,"text":"test"});
    assert!(matches!(
        client.request(send.clone()).await,
        Err(Error::Disconnected)
    ));
    fixture.connected.store(true, Ordering::SeqCst);
    client.request(send).await.unwrap();
    assert_eq!(fixture.creations.lock().await.len(), 1);
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 1);
    client.close().await;
}
