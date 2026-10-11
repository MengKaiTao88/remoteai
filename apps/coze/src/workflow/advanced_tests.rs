use super::*;
use crate::{
    api::Services,
    database::Database,
    model::{ResourceInput, ResourceKind},
    resources,
};
use serde_json::{json, Value};

fn interactive_graph() -> Value {
    json!({"nodes":[
        {"id":"start","name":"开始","type":"start"},
        {"id":"create","name":"创建会话","type":"conversation","operation":"create",
            "input":{"title":"确认订单"}},
        {"id":"ask","name":"确认","type":"input","prompt":"请确认 {{input.product}}",
            "fields":[{"name":"answer","description":"选择","kind":"string","required":true}],
            "choices":["同意","取消"]},
        {"id":"append","name":"记录","type":"conversation","operation":"append","input":{
            "conversationId":"{{create.output.conversationId}}","role":"user","content":"{{ask.output.answer}}"}},
        {"id":"end","name":"结束","type":"end","value":"{{ask.output.answer}}"}],
        "edges":[{"source":"start","target":"create"},{"source":"create","target":"ask"},
            {"source":"ask","target":"append"},{"source":"append","target":"end"}]})
}

fn save(services: &Services, draft: Value) -> crate::model::Resource {
    resources::save(
        &services.db,
        ResourceInput {
            id: None,
            kind: ResourceKind::Workflow,
            name: "审批".into(),
            description: String::new(),
            draft,
            revision: None,
        },
    )
    .unwrap()
}

#[test]
fn paused_workflow_survives_restart_without_repeating_side_effects() {
    let (directory, services) = super::tests::fixture();
    let resource = save(&services, interactive_graph());
    let result = run(
        &services,
        RunRequest {
            resource_id: resource.id.clone(),
            input: json!({"product":"书籍"}),
            published: false,
        },
    )
    .unwrap();
    assert_eq!(result["status"], "paused");
    assert_eq!(result["interaction"]["prompt"], "请确认 书籍");
    let id = result["id"].as_str().unwrap().to_owned();
    let interaction_id = result["interaction"]["id"].as_str().unwrap().to_owned();
    let services = Services::new(
        Database::open(directory.path()).unwrap(),
        services.embedder.clone(),
        services.proxy.clone(),
    );
    assert_eq!(
        list_runs(&services.db, &resource.id).unwrap()[0]["status"],
        "paused"
    );
    assert!(resume(
        &services,
        ResumeRequest {
            run_id: id.clone(),
            interaction_id: interaction_id.clone(),
            input: json!({"answer":"伪造"})
        }
    )
    .is_err());
    let result = resume(
        &services,
        ResumeRequest {
            run_id: id.clone(),
            interaction_id: interaction_id.clone(),
            input: json!({"answer":"同意"}),
        },
    )
    .unwrap();
    assert_eq!(result["status"], "completed");
    assert_eq!(result["output"], "同意");
    assert_eq!(result["trace"].as_array().unwrap().len(), 5);
    assert!(resume(
        &services,
        ResumeRequest {
            run_id: id,
            interaction_id: interaction_id.clone(),
            input: json!({"answer":"同意"})
        }
    )
    .is_err());
    let count: usize = services
        .db
        .connect()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM workflow_conversations", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
    let count: usize = services
        .db
        .connect()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM workflow_messages", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn resumed_run_uses_snapshot_after_draft_changed() {
    let (_directory, services) = super::tests::fixture();
    let resource = save(&services, interactive_graph());
    let result = run(
        &services,
        RunRequest {
            resource_id: resource.id.clone(),
            input: json!({"product":"书籍"}),
            published: false,
        },
    )
    .unwrap();
    let mut changed = interactive_graph();
    changed["nodes"][4]["value"] = json!("错误的新版本");
    resources::save(
        &services.db,
        ResourceInput {
            id: Some(resource.id),
            kind: resource.kind,
            name: resource.name,
            description: resource.description,
            draft: changed,
            revision: Some(resource.revision),
        },
    )
    .unwrap();
    let resumed = resume(
        &services,
        ResumeRequest {
            run_id: result["id"].as_str().unwrap().into(),
            interaction_id: result["interaction"]["id"].as_str().unwrap().into(),
            input: json!({"answer":"取消"}),
        },
    )
    .unwrap();
    assert_eq!(resumed["output"], "取消");
}

#[test]
fn concurrent_replies_claim_a_paused_run_once() {
    let (_directory, services) = super::tests::fixture();
    let resource = save(&services, interactive_graph());
    let result = run(
        &services,
        RunRequest {
            resource_id: resource.id,
            input: json!({"product":"书籍"}),
            published: false,
        },
    )
    .unwrap();
    let id = result["id"].as_str().unwrap().to_owned();
    let interaction_id = result["interaction"]["id"].as_str().unwrap().to_owned();
    let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let services = services.clone();
            let gate = gate.clone();
            let id = id.clone();
            let interaction_id = interaction_id.clone();
            std::thread::spawn(move || {
                gate.wait();
                resume(
                    &services,
                    ResumeRequest {
                        run_id: id,
                        interaction_id: interaction_id.clone(),
                        input: json!({"answer":"同意"}),
                    },
                )
                .is_ok()
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(
        handles
            .into_iter()
            .map(|handle| usize::from(handle.join().unwrap()))
            .sum::<usize>(),
        1
    );
    let count: usize = services
        .db
        .connect()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM workflow_messages", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn mcp_cannot_resume_a_draft_run_or_disabled_publication() {
    let (_directory, services) = super::tests::fixture();
    let resource = save(&services, interactive_graph());
    let result = run(
        &services,
        RunRequest {
            resource_id: resource.id.clone(),
            input: json!({"product":"书籍"}),
            published: false,
        },
    )
    .unwrap();
    assert!(matches!(
        resume_published(
            &services,
            ResumeRequest {
                run_id: result["id"].as_str().unwrap().into(),
                interaction_id: result["interaction"]["id"].as_str().unwrap().into(),
                input: json!({"answer":"同意"})
            }
        ),
        Err(crate::error::Error::Unpublished)
    ));
    resources::publish(&services.db, &resource.id, resource.revision, true).unwrap();
    let result = run(
        &services,
        RunRequest {
            resource_id: resource.id.clone(),
            input: json!({"product":"书籍"}),
            published: true,
        },
    )
    .unwrap();
    resources::publish(&services.db, &resource.id, resource.revision, false).unwrap();
    assert!(matches!(
        resume_published(
            &services,
            ResumeRequest {
                run_id: result["id"].as_str().unwrap().into(),
                interaction_id: result["interaction"]["id"].as_str().unwrap().into(),
                input: json!({"answer":"同意"})
            }
        ),
        Err(crate::error::Error::Unpublished)
    ));
}

#[test]
fn paused_publication_keeps_child_revision_after_republication() {
    let (_directory, services) = super::tests::fixture();
    let mut child_graph = json!({"nodes":[{"id":"start","name":"开始","type":"start"},
        {"id":"end","name":"结束","type":"end","value":"old"}],
        "edges":[{"source":"start","target":"end"}]});
    let child = save(&services, child_graph.clone());
    resources::publish(&services.db, &child.id, child.revision, true).unwrap();
    let mut parent_graph = interactive_graph();
    parent_graph["nodes"][3] = json!({"id":"append","name":"子流程","type":"subworkflow",
        "workflow_id":child.id,"input":{}});
    parent_graph["nodes"][4]["value"] = json!("{{append.output}}");
    let parent = save(&services, parent_graph);
    resources::publish(&services.db, &parent.id, parent.revision, true).unwrap();
    let run = run(
        &services,
        RunRequest {
            resource_id: parent.id,
            input: json!({"product":"书籍"}),
            published: true,
        },
    )
    .unwrap();
    child_graph["nodes"][1]["value"] = json!("new");
    let changed = resources::save(
        &services.db,
        ResourceInput {
            id: Some(child.id),
            kind: child.kind,
            name: child.name,
            description: child.description,
            draft: child_graph,
            revision: Some(child.revision),
        },
    )
    .unwrap();
    resources::publish(&services.db, &changed.id, changed.revision, true).unwrap();
    let result = resume(
        &services,
        ResumeRequest {
            run_id: run["id"].as_str().unwrap().into(),
            interaction_id: run["interaction"]["id"].as_str().unwrap().into(),
            input: json!({"answer":"同意"}),
        },
    )
    .unwrap();
    assert_eq!(result["output"], "old");
}

#[test]
fn upstream_json_fixture_preserves_typed_references() {
    let value: Value = serde_json::from_str(include_str!("fixtures/upstream_json.json")).unwrap();
    let graph = import_canvas(&value).unwrap();
    let (_directory, services) = super::tests::fixture();
    let person = json!({"int":42,"string":"你好","bool":true});
    let output = execute(
        &RuntimeContext::new(&services, false),
        &graph,
        json!({"person":person}),
        &mut vec![],
    )
    .unwrap();
    assert_eq!(output, json!({"output":person}));
}

#[test]
fn upstream_input_fixture_pauses_and_resumes_with_nested_values() {
    let value: Value = serde_json::from_str(include_str!("fixtures/upstream_input.json")).unwrap();
    let graph = import_canvas(&value).unwrap();
    let (_directory, services) = super::tests::fixture();
    let resource = save(&services, json!(graph));
    let result = run(
        &services,
        RunRequest {
            resource_id: resource.id,
            input: json!({}),
            published: false,
        },
    )
    .unwrap();
    assert_eq!(result["status"], "paused");
    let result = resume(
        &services,
        ResumeRequest {
            run_id: result["id"].as_str().unwrap().into(),
            interaction_id: result["interaction"]["id"].as_str().unwrap().into(),
            input: json!({"input":"文本","obj":{"field1":"嵌套"},"inputArr":[1.5,2.5]}),
        },
    )
    .unwrap();
    assert_eq!(
        result["output"],
        json!({"input":"文本","field1":"嵌套","inputArr":[1.5,2.5]})
    );
}

#[test]
fn upstream_unknown_nodes_and_missing_references_are_rejected() {
    let mut value: Value =
        serde_json::from_str(include_str!("fixtures/upstream_json.json")).unwrap();
    value["nodes"][2]["type"] = json!("999");
    assert!(matches!(
        import_canvas(&value),
        Err(crate::error::Error::WorkflowImport(_))
    ));
    value["nodes"][2]["type"] = json!("58");
    value["nodes"][2]["data"]["inputs"]["inputParameters"][0]["input"]["value"]["content"]
        ["blockID"] = json!("missing");
    assert!(import_canvas(&value).is_err());
}

#[test]
fn aggregate_skips_inactive_branch_and_variables_remain_typed() {
    let value = json!({"nodes":[{"id":"start","name":"开始","type":"start"},
        {"id":"set","name":"赋值","type":"variable","variable_name":"total","value":{"count":7}},
        {"id":"end","name":"结束","type":"end","value":"{{variables.total}}"}],
        "edges":[{"source":"start","target":"set"},{"source":"set","target":"end"}]});
    let (_directory, services) = super::tests::fixture();
    assert_eq!(
        execute(
            &RuntimeContext::new(&services, false),
            &serde_json::from_value(value).unwrap(),
            json!({}),
            &mut vec![]
        )
        .unwrap(),
        json!({"count":7})
    );
    let aggregate = json!({"nodes":[{"id":"start","name":"开始","type":"start"},
        {"id":"merge","name":"合并","type":"aggregate","values":["{{missing.output}}",{"count":7}]},
        {"id":"end","name":"结束","type":"end","value":"{{merge.output}}"}],
        "edges":[{"source":"start","target":"merge"},{"source":"merge","target":"end"}]});
    assert_eq!(
        execute(
            &RuntimeContext::new(&services, false),
            &serde_json::from_value(aggregate).unwrap(),
            json!({}),
            &mut vec![]
        )
        .unwrap(),
        json!({"count":7})
    );
}
