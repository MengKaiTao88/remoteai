use super::{
    bindings::{render, resolve},
    NodeAction, RuntimeContext,
};
use crate::{
    error::{Error, Result},
    model::{validate_id, ResourceKind},
    resources,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub(super) fn evaluate(
    context: &RuntimeContext<'_>,
    action: &NodeAction,
    values: &mut Value,
) -> Result<Value> {
    match action {
        NodeAction::KnowledgeWrite {
            knowledge_id,
            document_name,
            text,
        } => {
            let name = format!("{}.txt", render(document_name, values)?);
            let document = crate::knowledge::import_document_controlled(
                &context.services.db,
                context.services.embedder.as_ref(),
                crate::knowledge::ImportDocument {
                    knowledge_id: knowledge_id.clone(),
                    name,
                    content_base64: STANDARD.encode(render(text, values)?),
                    chunk: Default::default(),
                },
                &context.control,
            )?;
            Ok(json!(document))
        }
        NodeAction::KnowledgeDelete {
            knowledge_id,
            document_ids,
        } => delete_documents(context, knowledge_id, resolve(document_ids, values)?),
        NodeAction::Intent {
            model,
            query,
            intents,
        } => intent(context, model, render(query, values)?, intents),
        NodeAction::Repeat { workflow_id, count } => {
            super::loops::repeat(context, workflow_id, resolve(count, values)?, values)
        }
        NodeAction::Break | NodeAction::Continue => Err(Error::Workflow),
        _ => Err(Error::Workflow),
    }
}

fn delete_documents(context: &RuntimeContext<'_>, knowledge: &str, ids: Value) -> Result<Value> {
    if resources::get(&context.services.db, knowledge)?.kind != ResourceKind::Knowledge {
        return Err(Error::Invalid);
    }
    let ids: Vec<String> = serde_json::from_value(ids).map_err(|_| Error::Invalid)?;
    if ids.is_empty() || ids.len() > 100 {
        return Err(Error::Limit);
    }
    let mut connection = context.services.db.connect()?;
    let transaction = connection.transaction()?;
    for id in &ids {
        validate_id(id)?;
        if transaction
            .query_row(
                "SELECT 1 FROM documents WHERE id=?1 AND knowledge_id=?2",
                params![id, knowledge],
                |_| Ok(()),
            )
            .optional()?
            .is_none()
        {
            return Err(Error::NotFound);
        }
    }
    context.control.check()?;
    for id in &ids {
        transaction.execute("DELETE FROM documents WHERE id=?1", [id])?;
    }
    transaction.commit()?;
    Ok(json!({"deleted":ids.len()}))
}

fn intent(
    context: &RuntimeContext<'_>,
    model: &str,
    query: String,
    intents: &[String],
) -> Result<Value> {
    let messages = vec![
        json!({"role":"system","content":format!(
        "Classify the user text into exactly one of these intent labels: {}. Return only JSON {{\"intent\":\"label\"}}. Use 其他 if no label matches.",
        json!(intents))}),
        json!({"role":"user","content":query}),
    ];
    let completion = context.services.proxy.complete(
        crate::proxy::CompletionRequest {
            model,
            messages: &messages,
            temperature: 0.0,
            tools: &[],
        },
        &context.control,
    )?;
    let output: Value =
        serde_json::from_str(completion.content.trim()).map_err(|_| Error::Workflow)?;
    let label = output["intent"].as_str().ok_or(Error::Workflow)?;
    if label != "其他" && !intents.iter().any(|intent| intent == label) {
        return Err(Error::Workflow);
    }
    Ok(json!({"intent":label}))
}
