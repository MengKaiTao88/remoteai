use super::projection;
use serde_json::json;

#[test]
fn indexed_history_and_live_snapshots_share_unix_seconds() {
    for timestamp in [1_793_894_000.25, 1_793_894_000_250.0] {
        let turn = projection::turn(&json!({"id":"turn", "status":"completed",
            "startedAt":timestamp, "messages":[]}));
        assert_eq!(turn["startedAt"], 1_793_894_000.25);
        assert!(turn["completedAt"].is_null());
        assert!(turn["durationMs"].is_null());
    }
}

#[test]
fn preserves_authoritative_completion_and_rejects_invalid_timestamps() {
    let turn = projection::turn(&json!({"startedAt":-1,"completedAt":1_793_894_003_000u64,
        "durationMs":2750}));
    assert!(turn["startedAt"].is_null());
    assert_eq!(turn["completedAt"], 1_793_894_003.0);
    assert_eq!(turn["durationMs"], 2750);
}
