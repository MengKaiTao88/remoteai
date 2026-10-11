use super::*;
use crate::{
    api::Services,
    database::Database,
    model::{Resource, ResourceInput, ResourceKind},
    resources,
};
use serde_json::{json, Value};

fn save(services: &Services, draft: Value) -> Resource {
    resources::save(
        &services.db,
        ResourceInput {
            id: None,
            kind: ResourceKind::Workflow,
            name: "嵌套交互".into(),
            description: String::new(),
            draft,
            revision: None,
        },
    )
    .unwrap()
}

fn child_graph() -> Value {
    json!({"nodes":[{"id":"start","name":"开始","type":"start"},
        {"id":"create","name":"创建","type":"conversation","operation":"create","input":{"title":"只创建一次"}},
        {"id":"ask","name":"询问","type":"input","prompt":"请回复","fields":[
            {"name":"answer","description":"回答","kind":"string","required":true}]},
        {"id":"end","name":"结束","type":"end","value":"{{ask.output.answer}}"}],
        "edges":[{"source":"start","target":"create"},{"source":"create","target":"ask"},{"source":"ask","target":"end"}]})
}

fn reply(services: &Services, run: &Value, answer: &str) -> Value {
    resume(
        services,
        ResumeRequest {
            run_id: run["id"].as_str().unwrap().into(),
            interaction_id: run["interaction"]["id"].as_str().unwrap().into(),
            input: json!({"answer":answer}),
        },
    )
    .unwrap()
}

fn created(services: &Services) -> usize {
    services
        .db
        .connect()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM workflow_conversations", [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn nested_call_resumes_child_then_parent_across_restarts_without_replaying_effects() {
    let (directory, services) = super::tests::fixture();
    let child = save(&services, child_graph());
    let parent = save(
        &services,
        json!({"nodes":[{"id":"start","name":"开始","type":"start"},
        {"id":"create","name":"创建","type":"conversation","operation":"create","input":{"title":"父级"}},
        {"id":"call","name":"子流程","type":"subworkflow","workflow_id":child.id,"input":{}},
        {"id":"ask","name":"父级询问","type":"input","prompt":"请确认","fields":[
            {"name":"answer","description":"回答","kind":"string","required":true}]},
        {"id":"end","name":"结束","type":"end","value":{"child":"{{call.output}}","parent":"{{ask.output.answer}}"}}],
        "edges":[{"source":"start","target":"create"},{"source":"create","target":"call"},
            {"source":"call","target":"ask"},{"source":"ask","target":"end"}]}),
    );
    let first = run(
        &services,
        RunRequest {
            resource_id: parent.id,
            input: json!({}),
            published: false,
        },
    )
    .unwrap();
    assert_eq!(first["status"], "paused");
    assert_eq!(first["interaction"]["path"], json!(["call"]));
    assert_eq!(created(&services), 2);
    let services = Services::new(
        Database::open(directory.path()).unwrap(),
        services.embedder.clone(),
        services.proxy.clone(),
    );
    let second = reply(&services, &first, "子流程回答");
    assert_eq!(second["status"], "paused");
    assert_eq!(second["interaction"]["prompt"], "请确认");
    let services = Services::new(
        Database::open(directory.path()).unwrap(),
        services.embedder.clone(),
        services.proxy.clone(),
    );
    let result = reply(&services, &second, "父流程回答");
    assert_eq!(result["status"], "completed");
    assert_eq!(
        result["output"],
        json!({"child":"子流程回答","parent":"父流程回答"})
    );
    assert_eq!(created(&services), 2);
}

#[test]
fn loop_retains_iteration_and_frozen_child_graph_across_multiple_questions() {
    let (directory, services) = super::tests::fixture();
    let mut body = child_graph();
    body["nodes"][2]["prompt"] = json!("请回复 {{input.item}}，上一条 {{variables.latest}}");
    body["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"set","name":"记录变量","type":"variable",
        "variable_name":"latest","value":"{{ask.output.answer}}"}));
    body["edges"][2]["target"] = json!("set");
    body["edges"]
        .as_array_mut()
        .unwrap()
        .push(json!({"source":"set","target":"end"}));
    let child = save(&services, body.clone());
    let parent = save(
        &services,
        json!({"nodes":[{"id":"start","name":"开始","type":"start"},
        {"id":"set","name":"初始化","type":"variable","variable_name":"latest","value":"初始"},
        {"id":"loop","name":"批处理","type":"loop","workflow_id":child.id,"items":["甲","乙"]},
        {"id":"end","name":"结束","type":"end","value":{"results":"{{loop.output}}","latest":"{{variables.latest}}"}}],
        "edges":[{"source":"start","target":"set"},{"source":"set","target":"loop"},{"source":"loop","target":"end"}]}),
    );
    let first = run(
        &services,
        RunRequest {
            resource_id: parent.id,
            input: json!({}),
            published: false,
        },
    )
    .unwrap();
    assert_eq!(first["interaction"]["prompt"], "请回复 甲，上一条 初始");
    assert_eq!(created(&services), 1);
    body["nodes"][2]["prompt"] = json!("新的草稿");
    resources::save(
        &services.db,
        ResourceInput {
            id: Some(child.id),
            kind: child.kind,
            name: child.name,
            description: child.description,
            draft: body,
            revision: Some(child.revision),
        },
    )
    .unwrap();
    let mut stale = super::checkpoint::load(&services.db, first["id"].as_str().unwrap()).unwrap();
    super::continuation_stack::respond(&mut stale, json!({"answer":"过期回复"})).unwrap();
    let second = reply(&services, &first, "一");
    assert_eq!(second["interaction"]["prompt"], "请回复 乙，上一条 一");
    assert_eq!(created(&services), 2);
    assert!(matches!(
        resume(
            &services,
            ResumeRequest {
                run_id: first["id"].as_str().unwrap().into(),
                interaction_id: first["interaction"]["id"].as_str().unwrap().into(),
                input: json!({"answer":"过期回复"})
            }
        ),
        Err(crate::error::Error::Conflict)
    ));
    assert!(matches!(
        super::checkpoint::claim(
            &services.db,
            first["id"].as_str().unwrap(),
            &stale,
            first["interaction"]["id"].as_str().unwrap()
        ),
        Err(crate::error::Error::Conflict)
    ));
    let services = Services::new(
        Database::open(directory.path()).unwrap(),
        services.embedder.clone(),
        services.proxy.clone(),
    );
    let result = reply(&services, &second, "二");
    assert_eq!(result["status"], "completed");
    assert_eq!(
        result["output"],
        json!({"results":["一","二"],"latest":"二"})
    );
    assert_eq!(created(&services), 2);
}

#[test]
fn repeat_nested_questions_preserve_continue_and_break_semantics() {
    let (_directory, services) = super::tests::fixture();
    let leaf = save(&services, child_graph());
    let body = save(
        &services,
        json!({"nodes":[{"id":"start","name":"开始","type":"start"},
        {"id":"call","name":"提问","type":"subworkflow","workflow_id":leaf.id,"input":{}},
        {"id":"skip","name":"跳过","type":"condition","left":"{{call.output}}","right":"skip"},
        {"id":"continue","name":"继续","type":"continue"},
        {"id":"stop","name":"停止","type":"condition","left":"{{call.output}}","right":"stop"},
        {"id":"break","name":"终止","type":"break"},
        {"id":"end","name":"结束","type":"end","value":"{{call.output}}"}],
        "edges":[{"source":"start","target":"call"},{"source":"call","target":"skip"},
            {"source":"skip","target":"continue","port":true},{"source":"skip","target":"stop","port":false},
            {"source":"stop","target":"break","port":true},{"source":"stop","target":"end","port":false}]}),
    );
    let parent = save(
        &services,
        json!({"nodes":[{"id":"start","name":"开始","type":"start"},
        {"id":"repeat","name":"循环","type":"repeat","workflow_id":body.id,"count":5},
        {"id":"end","name":"结束","type":"end","value":"{{repeat.output}}"}],
        "edges":[{"source":"start","target":"repeat"},{"source":"repeat","target":"end"}]}),
    );
    let first = run(
        &services,
        RunRequest {
            resource_id: parent.id,
            input: json!({}),
            published: false,
        },
    )
    .unwrap();
    assert_eq!(first["interaction"]["path"], json!(["repeat", "call"]));
    let second = reply(&services, &first, "skip");
    assert_eq!(second["status"], "paused");
    let third = reply(&services, &second, "go");
    assert_eq!(third["status"], "paused");
    let result = reply(&services, &third, "stop");
    assert_eq!(result["status"], "completed");
    assert_eq!(result["output"], json!(["go"]));
    assert_eq!(created(&services), 3);
}
