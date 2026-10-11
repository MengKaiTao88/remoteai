use super::*;
use crate::{
    model::{ResourceInput, ResourceKind},
    resources,
};

fn make(db: &Database, kind: ResourceKind, draft: Value) -> Result<crate::model::Resource> {
    resources::save(
        db,
        ResourceInput {
            id: None,
            kind,
            name: "测试".into(),
            description: String::new(),
            draft,
            revision: None,
        },
    )
}

fn graph(child: Option<&str>, text: &str) -> Value {
    let middle = match child {
        Some(id) => json!({"id":"middle","name":"子工作流","type":"subworkflow",
            "workflow_id":id,"input":{}}),
        None => json!({"id":"middle","name":"模板","type":"template","template":text}),
    };
    json!({"inputs":[],"nodes":[{"id":"start","name":"开始","type":"start"},middle,
        {"id":"end","name":"结束","type":"end","value":"{{middle.output}}"}],
        "edges":[{"source":"start","target":"middle"},{"source":"middle","target":"end"}]})
}

#[test]
fn release_pins_transitive_dependencies_and_preserves_draft_on_rollback() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let db = Database::open(temp.path())?;
    let leaf = make(&db, ResourceKind::Workflow, graph(None, "原始"))?;
    resources::publish(&db, &leaf.id, 1, true)?;
    let child = make(&db, ResourceKind::Workflow, graph(Some(&leaf.id), ""))?;
    resources::publish(&db, &child.id, 1, true)?;
    let changed = resources::save(
        &db,
        ResourceInput {
            id: Some(leaf.id.clone()),
            kind: leaf.kind,
            name: leaf.name,
            description: leaf.description,
            draft: graph(None, "改动"),
            revision: Some(1),
        },
    )?;
    resources::publish(&db, &leaf.id, changed.revision, true)?;
    let parent = make(&db, ResourceKind::Workflow, graph(Some(&child.id), ""))?;
    resources::publish(&db, &parent.id, 1, true)?;
    let pins = snapshot(&db, &parent.id)?;
    assert_eq!(pins.get(&leaf.id), Some(&1));
    assert_eq!(
        resources::published(&db.with_revisions(pins), &leaf.id)?.1["nodes"][1]["template"],
        "原始"
    );
    assert!(matches!(
        resources::delete(&db, &leaf.id, 2),
        Err(Error::DependencyInUse)
    ));
    activate(&db, &leaf.id, 1, 2)?;
    assert_eq!(
        resources::get(&db, &leaf.id)?.draft["nodes"][1]["template"],
        "改动"
    );
    assert_eq!(
        resources::published(&db, &leaf.id)?.1["nodes"][1]["template"],
        "原始"
    );
    Ok(())
}

#[test]
fn missing_dependency_rolls_back_entire_publication() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let db = Database::open(temp.path())?;
    let child = make(&db, ResourceKind::Workflow, graph(None, "text"))?;
    let parent = make(&db, ResourceKind::Workflow, graph(Some(&child.id), ""))?;
    assert!(matches!(
        resources::publish(&db, &parent.id, 1, true),
        Err(Error::Dependency)
    ));
    assert!(resources::get(&db, &parent.id)?
        .published_revision
        .is_none());
    assert_eq!(list(&db, &parent.id)?, json!([]));
    Ok(())
}
