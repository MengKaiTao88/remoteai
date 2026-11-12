use super::*;
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn reading_permissions_reports_the_owner_without_writing_settings() {
    let fixture = tests::fixture(false).await;
    let client = tests::client(&fixture).await;
    assert_eq!(
        client.model_settings(tests::THREAD).await.unwrap()["access"],
        "danger-full-access"
    );
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 0);
    client.close().await;
}

#[tokio::test]
async fn explicit_permission_changes_require_confirmed_authoritative_state() {
    let fixture = tests::fixture(false).await;
    let client = tests::client(&fixture).await;
    for access in ["read-only", "workspace-write", "danger-full-access"] {
        let result = client
            .set_access_settings(tests::THREAD, access)
            .await
            .unwrap();
        assert_eq!(result["access"], access);
    }
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 3);
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 0);
    fixture.permission_confirmed.store(false, Ordering::SeqCst);
    assert!(matches!(
        client.set_access_settings(tests::THREAD, "read-only").await,
        Err(Error::Stale)
    ));
    assert_eq!(
        client.model_settings(tests::THREAD).await.unwrap()["access"],
        "danger-full-access"
    );
    let posts = fixture.posts.load(Ordering::SeqCst);
    assert!(matches!(
        client.set_access_settings(tests::THREAD, "invalid").await,
        Err(Error::Invalid)
    ));
    fixture.connected.store(false, Ordering::SeqCst);
    assert!(matches!(
        client.set_access_settings(tests::THREAD, "read-only").await,
        Err(Error::Disconnected)
    ));
    assert_eq!(fixture.posts.load(Ordering::SeqCst), posts);
    client.close().await;
}

#[tokio::test]
async fn permission_only_updates_publish_even_when_model_and_turns_are_unchanged() {
    let fixture = tests::fixture(false).await;
    let client = tests::client(&fixture).await;
    let mut events = client.subscribe();
    let first = json!({"id":tests::THREAD,"sequence":1,"turns":[],"requests":[],
        "model":"model-a","effort":"high","permissionMode":"auto-review"});
    client.accept(&first).await.unwrap();
    while events.try_recv().is_ok() {}
    let mut next = first;
    next["sequence"] = json!(2);
    next["permissionMode"] = json!("full-access");
    client.accept(&next).await.unwrap();
    let event = events.try_recv().unwrap();
    assert_eq!(event["method"], "bridge/modelSettings");
    assert_eq!(event["params"]["access"], "danger-full-access");
    assert!(super::models::access(&json!({"permissionMode":"custom"})).is_none());
    next["sequence"] = json!(3);
    next["permissionUpdate"] = json!("nextTurn");
    client.accept(&next).await.unwrap();
    assert_eq!(
        events.try_recv().unwrap()["params"]["accessUpdate"],
        "nextTurn"
    );
    next["sequence"] = json!(4);
    next.as_object_mut().unwrap().remove("permissionUpdate");
    client.accept(&next).await.unwrap();
    assert!(events.try_recv().unwrap()["params"]
        .get("accessUpdate")
        .is_none());
    client.close().await;
}
