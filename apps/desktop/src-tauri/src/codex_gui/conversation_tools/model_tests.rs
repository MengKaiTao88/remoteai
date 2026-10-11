use super::*;
use protocol::{Create, Tool};

fn args(overrides: Value, metadata: Value) -> Create {
    let mut arguments = json!({"requestId":"create-model", "message":"hello"});
    arguments
        .as_object_mut()
        .unwrap()
        .extend(overrides.as_object().unwrap().clone());
    let tool = protocol::parse(
        &json!({"name":"gui_create_conversation", "arguments":arguments,
        "_meta":{"x-codex-turn-metadata":metadata}}),
    )
    .unwrap();
    let Tool::Mutate(Mutation::Create(args)) = tool else {
        panic!("not create")
    };
    args
}

fn metadata() -> Value {
    json!({"thread_id":"caller", "model":"caller-model", "reasoning_effort":"high"})
}

#[test]
fn defaults_follow_the_calling_turn_and_overrides_are_independent() {
    for (overrides, model, effort) in [
        (json!({}), "caller-model", Effort::High),
        (json!({"model":"other-model"}), "other-model", Effort::High),
        (json!({"effort":"low"}), "caller-model", Effort::Low),
        (
            json!({"model":"other-model", "effort":"ultra"}),
            "other-model",
            Effort::Ultra,
        ),
    ] {
        let actual = selection::resolve(&args(overrides, metadata())).unwrap();
        assert_eq!(
            actual,
            ModelSelection {
                model: model.into(),
                effort
            }
        );
    }
    let other = args(
        json!({}),
        json!({"model":"another-caller", "reasoning_effort":"medium"}),
    );
    assert_eq!(selection::resolve(&other).unwrap().model, "another-caller");
    assert_eq!(
        selection::resolve(&args(json!({}), metadata())).unwrap(),
        selection()
    );
}

#[test]
fn missing_or_invalid_context_requires_explicit_choices_without_draft_fallback() {
    for metadata in [
        Value::Null,
        json!({"model":"caller-model"}),
        json!({"model":"caller-model", "reasoning_effort":"invalid"}),
    ] {
        for overrides in [
            json!({}),
            json!({"model":"explicit"}),
            json!({"effort":"low"}),
        ] {
            assert!(matches!(
                selection::resolve(&args(overrides, metadata.clone())),
                Err(Error::ModelContext)
            ));
        }
        let explicit = args(json!({"model":"explicit", "effort":"none"}), metadata);
        assert_eq!(
            selection::resolve(&explicit).unwrap(),
            ModelSelection {
                model: "explicit".into(),
                effort: Effort::None
            }
        );
    }
}

#[test]
fn model_arguments_are_validated_and_caller_context_cannot_be_supplied_as_an_argument() {
    for invalid in [
        json!({"model":""}),
        json!({"model":" model"}),
        json!({"model":"model "}),
        json!({"model":"model\nname"}),
        json!({"model":"x".repeat(201)}),
        json!({"model":42}),
        json!({"effort":"extreme"}),
        json!({"effort":4}),
        json!({"caller":metadata()}),
        json!({"access":"danger-full-access"}),
    ] {
        let mut arguments = json!({"requestId":"invalid-model", "message":"hello"});
        arguments
            .as_object_mut()
            .unwrap()
            .extend(invalid.as_object().unwrap().clone());
        assert!(
            protocol::parse(&json!({"name":"gui_create_conversation", "arguments":arguments}))
                .is_err()
        );
    }
    let tools: Value = serde_json::from_str(protocol::TOOLS).unwrap();
    let schema = &tools["tools"][0]["inputSchema"];
    assert_eq!(schema["required"], json!(["requestId", "message"]));
    assert_eq!(schema["properties"]["model"]["maxLength"], 200);
    for effort in schema["properties"]["effort"]["enum"].as_array().unwrap() {
        let create = args(
            json!({"model":"provider/model-v1", "effort":effort}),
            Value::Null,
        );
        assert!(selection::resolve(&create).is_ok());
    }
}

#[tokio::test]
async fn creation_prepares_the_inherited_or_explicit_model_with_workspace_permissions() {
    let root = tempfile::tempdir().unwrap();
    for overrides in [json!({}), json!({"model":"other-model", "effort":"low"})] {
        let create = args(overrides, metadata());
        let expected = selection::resolve(&create).unwrap();
        let prepared = operations::prepare_create(root.path().canonicalize().unwrap(), create)
            .await
            .unwrap();
        assert_eq!(prepared.params["model"], expected.model);
        assert_eq!(
            prepared.params["config"]["model_reasoning_effort"],
            json!(expected.effort)
        );
        assert_eq!(prepared.params["sandbox"], "workspace-write");
        assert_eq!(prepared.selection, expected);
    }
}

#[tokio::test]
async fn changed_explicit_choices_conflict_but_changed_caller_metadata_does_not_replay() {
    let root = tempfile::tempdir().unwrap();
    let journal = Journal::default();
    let original = args(json!({"model":"explicit", "effort":"low"}), metadata());
    assert!(matches!(
        journal
            .claim(root.path(), &Mutation::Create(original.clone()))
            .await
            .unwrap(),
        Claim::New(_)
    ));
    for changed in [
        args(json!({"model":"changed", "effort":"low"}), metadata()),
        args(json!({"model":"explicit", "effort":"high"}), metadata()),
    ] {
        assert!(matches!(
            journal.claim(root.path(), &Mutation::Create(changed)).await,
            Err(Error::RequestConflict)
        ));
    }
    let mut changed_caller = original;
    changed_caller.caller = None;
    assert!(matches!(
        Journal::default()
            .claim(root.path(), &Mutation::Create(changed_caller))
            .await
            .unwrap(),
        Claim::Existing(_)
    ));
}

#[test]
fn omitted_choices_preserve_existing_request_fingerprints() {
    let original = args(json!({}), metadata());
    let serialized = serde_json::to_string(&Mutation::Create(original)).unwrap();
    assert_eq!(
        serialized,
        r#"{"operation":"create","requestId":"create-model","message":"hello","cwd":null}"#
    );
}

#[tokio::test]
async fn storage_failure_keeps_the_created_thread_receipt_and_does_not_send() {
    let root = tempfile::tempdir().unwrap();
    let mutation = Mutation::Create(args(json!({}), metadata()));
    let journal = Journal::default();
    let Claim::New(mut entry) = journal.claim(root.path(), &mutation).await.unwrap() else {
        panic!("not new")
    };
    let mut save = saved_model();
    save.2 = Err(Error::Storage);
    let fake = Fake(Mutex::new(VecDeque::from([
        ("thread/start", json!({}), Ok(thread(false))),
        save,
    ])));
    assert!(matches!(
        operations::create(&fake, prepared(json!({})), &mut entry).await,
        Err(Error::Storage)
    ));
    let Claim::Existing(receipt) = journal.claim(root.path(), &mutation).await.unwrap() else {
        panic!("replayed")
    };
    assert_eq!(receipt["threadId"], "target");
    assert_eq!(receipt["status"], "unknown");
    assert!(fake.0.lock().await.is_empty());
}
