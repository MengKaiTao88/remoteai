use super::*;
use serde_json::json;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn native_catalog_exposes_real_models_and_supported_efforts() {
    let fixture = tests::fixture(false).await;
    let client = tests::client(&fixture).await;
    let catalog = client
        .request(json!({"operation":"models", "cacheOnly":true}))
        .await
        .unwrap();
    assert_eq!(catalog["data"][0]["model"], "model-a");
    assert_eq!(catalog["data"][1]["displayName"], "Model B");
    assert_eq!(
        catalog["data"][0]["supportedReasoningEfforts"][1]["reasoningEffort"],
        "high"
    );
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 0);
    client.close().await;
}

#[tokio::test]
async fn explicit_model_selection_is_confirmed_and_published_to_all_viewers() {
    let fixture = tests::fixture(false).await;
    let client = tests::client(&fixture).await;
    let mut events = client.subscribe();
    let selection = json!({"model":"model-b", "effort":"low"});
    let result = client
        .set_model_settings(tests::THREAD, &selection)
        .await
        .unwrap();
    assert_eq!(result["selection"], selection);
    assert_eq!(result["liveUpdate"], "nextTurn");
    assert_eq!(
        client.model_settings(tests::THREAD).await.unwrap()["selection"],
        selection
    );
    let mut published = false;
    while let Ok(event) = events.try_recv() {
        if event["method"] == "bridge/modelSettings" {
            assert_eq!(event["params"]["selection"], selection);
            published = true;
        }
    }
    assert!(published);
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 1);
    client.close().await;
}

#[tokio::test]
async fn unsupported_model_or_effort_never_changes_the_native_session() {
    let fixture = tests::fixture(false).await;
    let client = tests::client(&fixture).await;
    for selection in [
        json!({"model":"unknown", "effort":"low"}),
        json!({"model":"model-b", "effort":"high"}),
    ] {
        assert!(matches!(
            client.set_model_settings(tests::THREAD, &selection).await,
            Err(Error::Invalid)
        ));
    }
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 0);
    client.close().await;
}

#[tokio::test]
async fn queued_send_applies_its_model_once_before_submitting() {
    let fixture = tests::fixture(false).await;
    let client = tests::client(&fixture).await;
    let request = json!({"operation":"send", "threadId":tests::THREAD, "text":"hello",
        "model":"model-b", "effort":"low"});
    client.request(request.clone()).await.unwrap();
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 2);
    client.request(request).await.unwrap();
    assert_eq!(fixture.posts.load(Ordering::SeqCst), 3);
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 2);
    client.close().await;
}

#[tokio::test]
async fn unconfirmed_native_model_changes_never_submit_a_message() {
    let fixture = tests::fixture(false).await;
    fixture.model_confirmed.store(false, Ordering::SeqCst);
    let client = tests::client(&fixture).await;
    let request = json!({"operation":"send", "threadId":tests::THREAD, "text":"hello",
        "model":"model-b", "effort":"low"});
    assert!(matches!(client.request(request).await, Err(Error::Stale)));
    assert_eq!(fixture.sends.load(Ordering::SeqCst), 0);
    client.close().await;
}

#[tokio::test]
async fn native_model_updates_notify_viewers_and_ignore_stale_snapshots() {
    let fixture = tests::fixture(false).await;
    let client = tests::client(&fixture).await;
    let mut events = client.subscribe();
    let mut state = json!({"id":tests::THREAD, "connected":true, "sequence":1,
        "latestModel":"model-a", "latestReasoningEffort":"high", "turns":[], "requests":[]});
    client.accept(&state).await.unwrap();
    while events.try_recv().is_ok() {}
    let stale = state.clone();
    state["sequence"] = json!(2);
    state["latestModel"] = json!("model-b");
    state["latestReasoningEffort"] = json!("low");
    client.accept(&state).await.unwrap();
    let event = events.try_recv().unwrap();
    assert_eq!(event["method"], "bridge/modelSettings");
    assert_eq!(
        event["params"]["selection"],
        json!({"model":"model-b","effort":"low"})
    );
    assert!(event["params"]["revision"].as_u64().unwrap() > 0);
    client.accept(&stale).await.unwrap();
    assert!(events.try_recv().is_err());
    client.close().await;
}
