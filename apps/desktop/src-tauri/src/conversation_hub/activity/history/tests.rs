use super::*;
use serde_json::{json, Value};
use std::io::Write;

const ROOT: &str = "00000000-0000-4000-8000-000000000001";
const LEAF: &str = "00000000-0000-4000-8000-000000000002";
const PHYSICAL: &str = "00000000-0000-4000-8000-000000000003";
const LEAF_PHYSICAL: &str = "00000000-0000-4000-8000-000000000004";

fn record(owner: &str, turn: &str, response: &str) -> Value {
    json!({ "type": "token_usage_record", "payload": {
        "thread_id": owner, "turn_id": turn, "response_id": response,
        "thread_token_usage": { "total_tokens": 1000000 },
        "usage": { "input_tokens": 90, "cached_input_tokens": 60, "output_tokens": 10 }
    } })
}

fn command(owner: &str, turn: &str, id: &str, status: &str, exit: Option<i64>) -> Value {
    json!({ "type": "event_msg", "payload": {
        "type": "item_completed", "thread_id": owner, "turn_id": turn, "item": {
            "type": "CommandExecution", "id": id, "status": status, "exit_code": exit,
            "aggregated_output": "large output is not needed for the statistic"
        }
    } })
}

fn write_lines(records: &[Value]) -> String {
    records.iter().map(|value| format!("{value}\n")).collect()
}

#[test]
fn fork_excludes_its_parent_but_keeps_its_own_rotated_compressed_history() {
    let folder = tempfile::tempdir().unwrap();
    let home = folder.path();
    let sessions = home.join("sessions");
    let archived = home.join("archived_sessions");
    fs::create_dir(&sessions).unwrap();
    fs::create_dir(&archived).unwrap();
    let parent = write_lines(&[
        json!({"type":"session_meta", "payload":{"id":ROOT}}),
        record(ROOT, "turn-old", "response-a"),
        record(ROOT, "turn-old", "response-b"),
        command(ROOT, "turn-old", "tool-a", "completed", Some(0)),
        command(ROOT, "turn-old", "tool-b", "completed", Some(1)),
    ]);
    let after_fork = write_lines(&[record(ROOT, "do-not-follow", "response-extra")]);
    let parent_path = archived.join(format!("rollout-{ROOT}_{PHYSICAL}.jsonl.zst"));
    let archive = zstd::stream::encode_all(format!("{parent}{after_fork}").as_bytes(), 1).unwrap();
    fs::write(&parent_path, archive).unwrap();

    let old_leaf = write_lines(&[
        json!({"type":"session_meta", "payload":{"id":LEAF,
            "history_base":{"thread_id":PHYSICAL,"end_byte_offset":parent.len()}}}),
        record(LEAF, "turn-old", "response-b"),
        command(LEAF, "turn-old", "tool-own", "completed", Some(0)),
    ]);
    let old_leaf_path = archived.join(format!("rollout-{LEAF}_{LEAF_PHYSICAL}.jsonl.zst"));
    let ignored = write_lines(&[record(LEAF, "after-cutoff", "response-after-cutoff")]);
    fs::write(
        &old_leaf_path,
        zstd::stream::encode_all(format!("{old_leaf}{ignored}").as_bytes(), 1).unwrap(),
    )
    .unwrap();

    let mut child = write_lines(&[
        json!({"type":"session_meta", "payload":{"id":LEAF,
            "history_base":{"thread_id":LEAF_PHYSICAL,"end_byte_offset":old_leaf.len()}}}),
        record(LEAF, "turn-old", "response-b"),
        record(ROOT, "foreign", "foreign-response"),
        record(LEAF, "turn-new", "response-c"),
        record(LEAF, "turn-new", "response-c"),
        command(LEAF, "turn-new", "tool-c", "failed", None),
        command(LEAF, "turn-new", "tool-c", "failed", None),
        command(LEAF, "turn-new", "tool-d", "declined", Some(0)),
        command(LEAF, "turn-new", "tool-e", "completed", None),
    ]);
    let pending = record(LEAF, "turn-third", "response-d").to_string();
    let mid = pending.len() / 2;
    child.push_str(&pending[..mid]);
    let child_path = sessions.join(format!("rollout-{LEAF}.jsonl"));
    fs::write(&child_path, child).unwrap();
    let connection = Connection::open(home.join("state_5.sqlite")).unwrap();
    connection
        .execute(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO threads VALUES (?1, ?2)",
            [LEAF, child_path.to_str().unwrap()],
        )
        .unwrap();

    let leaf = Uuid::parse_str(LEAF).unwrap();
    let first = refresh(home, leaf, None).unwrap();
    assert_eq!(
        first.totals(),
        ActivityTotals {
            turns: Some(2),
            steps: Some(2),
            total_tokens: Some(200),
            input_tokens: Some(180),
            cached_input_tokens: Some(120),
            successful_command_count: 1,
            completed_command_count: 2
        }
    );
    let mut tail = fs::OpenOptions::new()
        .append(true)
        .open(&child_path)
        .unwrap();
    writeln!(tail, "{}", &pending[mid..]).unwrap();
    writeln!(
        tail,
        "{}",
        command(LEAF, "turn-third", "tool-a", "completed", Some(0))
    )
    .unwrap();
    drop(tail);
    let after = refresh(home, leaf, Some(first)).unwrap();
    assert_eq!(
        after.totals(),
        ActivityTotals {
            turns: Some(3),
            steps: Some(3),
            total_tokens: Some(300),
            input_tokens: Some(270),
            cached_input_tokens: Some(180),
            successful_command_count: 2,
            completed_command_count: 3
        }
    );

    fs::remove_file(old_leaf_path).unwrap();
    assert!(
        refresh(home, leaf, None).is_none(),
        "an incomplete chain cannot claim whole-chat totals"
    );
}

#[test]
fn never_substitutes_inherited_or_partial_usage_for_the_current_chat() {
    let mut activity = Activity::default();
    let mut no_cache = record(LEAF, "turn", "one");
    no_cache["payload"]["usage"]["cached_input_tokens"] = Value::Null;
    let mut known = record(LEAF, "turn", "two");
    known["payload"]["usage"]["total_tokens"] = json!(105);
    let foreign = record(ROOT, "other", "three");
    let source = write_lines(&[no_cache, known, foreign]);
    read_records(source.as_bytes(), LEAF, &mut activity).unwrap();
    let got = activity.totals();
    assert_eq!((got.turns, got.steps), (Some(1), Some(2)));
    assert_eq!(got.total_tokens, Some(205));
    assert_eq!(got.input_tokens, Some(180));
    assert_eq!(got.cached_input_tokens, None);

    let mut unmeasured = record(LEAF, "turn2", "four");
    unmeasured["payload"]["usage"] = Value::Null;
    read_records(write_lines(&[unmeasured]).as_bytes(), LEAF, &mut activity).unwrap();
    let got = activity.totals();
    assert_eq!((got.turns, got.steps), (Some(2), Some(3)));
    assert_eq!(got.total_tokens, None);
    assert_eq!(got.input_tokens, None);
}

#[test]
fn only_the_indexed_conversations_own_valid_rollout_is_counted() {
    let folder = tempfile::tempdir().unwrap();
    let home = folder.path();
    let leaf = Uuid::parse_str(LEAF).unwrap();
    let outside = home.join(format!("rollout-{LEAF}.jsonl"));
    fs::write(
        &outside,
        write_lines(&[
            json!({"type":"session_meta", "payload":{"id":LEAF}}),
            record(LEAF, "turn", "response"),
        ]),
    )
    .unwrap();
    let db = Connection::open(home.join("state_5.sqlite")).unwrap();
    db.execute(
        "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO threads VALUES (?1, ?2)",
        [LEAF, outside.to_str().unwrap()],
    )
    .unwrap();
    assert!(refresh(home, leaf, None).is_none());
    let sessions = home.join("sessions");
    fs::create_dir(&sessions).unwrap();
    let inside = sessions.join(format!("rollout-{LEAF}.jsonl"));
    fs::write(
        &inside,
        write_lines(&[
            json!({"type":"session_meta", "payload":{"id":ROOT}}),
            record(ROOT, "turn", "response"),
        ]),
    )
    .unwrap();
    db.execute(
        "UPDATE threads SET rollout_path = ?1",
        [inside.to_str().unwrap()],
    )
    .unwrap();
    assert!(refresh(home, leaf, None).is_none());
}
