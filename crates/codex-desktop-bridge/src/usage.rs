use super::Client;
use serde_json::{json, Value};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn counter(value: &Value) -> Option<u64> {
    value.as_u64().filter(|count| *count <= MAX_SAFE_INTEGER)
}

pub(super) fn snapshot(view: &Value) -> Option<Value> {
    let usage = &view["tokenUsage"];
    let total = counter(&usage["total"]["totalTokens"])?;
    let last = counter(&usage["last"]["totalTokens"])?;
    let context = counter(&usage["contextTokens"]).unwrap_or(last);
    let window = counter(&usage["modelContextWindow"]).filter(|window| *window > 0);
    Some(
        json!({"total":{"totalTokens":total}, "last":{"totalTokens":last},
        "contextTokens":context, "modelContextWindow":window}),
    )
}

impl Client {
    pub(super) fn publish_usage(&self, previous: Option<&Value>, view: &Value) {
        let Some(usage) = snapshot(view) else { return };
        if previous.and_then(snapshot).as_ref() == Some(&usage) {
            return;
        }
        self.emit(json!({"method":"thread/tokenUsage/updated", "params":{
            "threadId":view["id"], "tokenUsage":usage}}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view() -> Value {
        json!({"id":super::super::tests::THREAD,"sequence":1,"turns":[],"tokenUsage":{
            "total":{"totalTokens":12_000_000},"last":{"totalTokens":250_000},
            "contextTokens":260_000,"modelContextWindow":475_000}})
    }

    #[test]
    fn projection_preserves_billing_context_and_capacity_separately() {
        let projected = super::super::projection::thread(&view());
        assert_eq!(projected["tokenUsage"]["total"]["totalTokens"], 12_000_000);
        assert_eq!(projected["tokenUsage"]["contextTokens"], 260_000);
        assert_eq!(projected["tokenUsage"]["modelContextWindow"], 475_000);
        assert!(snapshot(&json!({"contextUsage":{"usedTokens":42}})).is_none());
        assert!(snapshot(&json!({"tokenUsage":{"total":{"totalTokens":-1},
            "last":{"totalTokens":42}}}))
        .is_none());
    }

    #[tokio::test]
    async fn usage_updates_are_published_even_when_no_turn_body_changes() {
        let fixture = super::super::tests::fixture(false).await;
        let client = super::super::tests::client(&fixture).await;
        let mut events = client.subscribe();
        let first = view();
        client.accept(&first).await.unwrap();
        while events.try_recv().is_ok() {}
        let mut second = first.clone();
        second["sequence"] = json!(2);
        second["tokenUsage"]["contextTokens"] = json!(100_000);
        client.accept(&second).await.unwrap();
        let event = events.try_recv().unwrap();
        assert_eq!(event["method"], "thread/tokenUsage/updated");
        assert_eq!(event["params"]["tokenUsage"]["contextTokens"], 100_000);
        client.accept(&second).await.unwrap();
        assert!(events.try_recv().is_err());
        client.close().await;
    }
}
