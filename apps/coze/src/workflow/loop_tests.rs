use super::*;
use crate::{
    model::{ResourceInput, ResourceKind},
    resources,
};
use serde_json::json;

#[test]
fn loop_continue_skips_one_iteration_and_break_stops_later_effects() {
    let (_directory, services) = super::tests::fixture();
    let body = json!({"nodes":[
        {"id":"start","name":"开始","type":"start"},
        {"id":"skip","name":"跳过一","type":"condition","left":"{{input.item}}","right":1},
        {"id":"continue","name":"继续","type":"continue"},
        {"id":"stop","name":"停止于三","type":"condition","left":"{{input.item}}","right":3},
        {"id":"break","name":"终止","type":"break"},
        {"id":"sum","name":"累加","type":"code","input":{"sum":"{{variables.total}}","item":"{{input.item}}"},
            "code":"return input.sum + input.item;"},
        {"id":"set","name":"保存","type":"variable","variable_name":"total","value":"{{sum.output}}"},
        {"id":"end","name":"完成","type":"end","value":"{{input.item}}"}],
        "edges":[{"source":"start","target":"skip"},{"source":"skip","target":"continue","port":true},
            {"source":"skip","target":"stop","port":false},{"source":"stop","target":"break","port":true},
            {"source":"stop","target":"sum","port":false},{"source":"sum","target":"set"},
            {"source":"set","target":"end"}]});
    let child = resources::save(
        &services.db,
        ResourceInput {
            id: None,
            kind: ResourceKind::Workflow,
            name: "循环体".into(),
            description: String::new(),
            draft: body,
            revision: None,
        },
    )
    .unwrap();
    let graph:Graph = serde_json::from_value(json!({"nodes":[
        {"id":"start","name":"开始","type":"start"},
        {"id":"set","name":"初始化","type":"variable","variable_name":"total","value":0},
        {"id":"loop","name":"循环","type":"loop","workflow_id":child.id,"items":[1,2,3,4]},
        {"id":"end","name":"结束","type":"end","value":{"items":"{{loop.output}}","sum":"{{variables.total}}"}}],
        "edges":[{"source":"start","target":"set"},{"source":"set","target":"loop"},{"source":"loop","target":"end"}]})).unwrap();
    assert_eq!(
        execute(
            &RuntimeContext::new(&services, false),
            &graph,
            json!({}),
            &mut vec![]
        )
        .unwrap(),
        json!({"items":[2],"sum":2})
    );
}

#[test]
fn repeat_enforces_count_and_exposes_zero_based_index() {
    let (_directory, services) = super::tests::fixture();
    let child = resources::save(
        &services.db,
        ResourceInput {
            id: None,
            kind: ResourceKind::Workflow,
            name: "计数".into(),
            description: String::new(),
            revision: None,
            draft: json!({"nodes":[
            {"id":"start","name":"开始","type":"start"},
            {"id":"end","name":"结束","type":"end","value":"{{input.index}}"}],
            "edges":[{"source":"start","target":"end"}]}),
        },
    )
    .unwrap();
    let mut graph = json!({"nodes":[{"id":"start","name":"开始","type":"start"},
        {"id":"repeat","name":"循环","type":"repeat","workflow_id":child.id,"count":3},
        {"id":"end","name":"结束","type":"end","value":"{{repeat.output}}"}],
        "edges":[{"source":"start","target":"repeat"},{"source":"repeat","target":"end"}]});
    assert_eq!(
        execute(
            &RuntimeContext::new(&services, false),
            &serde_json::from_value(graph.clone()).unwrap(),
            json!({}),
            &mut vec![]
        )
        .unwrap(),
        json!([0, 1, 2])
    );
    graph["nodes"][1]["count"] = json!(101);
    assert!(execute(
        &RuntimeContext::new(&services, false),
        &serde_json::from_value(graph).unwrap(),
        json!({}),
        &mut vec![]
    )
    .is_err());
}
