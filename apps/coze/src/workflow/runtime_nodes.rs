use super::{
    bindings::{render, resolve},
    Node, NodeAction, RuntimeContext,
};
use crate::{error::Result, knowledge};
use serde_json::{json, Value};

pub(super) fn evaluate(
    context: &RuntimeContext<'_>,
    node: &Node,
    values: &mut Value,
) -> Result<Value> {
    match &node.action {
        NodeAction::KnowledgeWrite { .. }
        | NodeAction::KnowledgeDelete { .. }
        | NodeAction::Intent { .. }
        | NodeAction::Repeat { .. }
        | NodeAction::Break
        | NodeAction::Continue => super::advanced_nodes::evaluate(context, &node.action, values),
        NodeAction::Input { .. }
        | NodeAction::Output { .. }
        | NodeAction::Variable { .. }
        | NodeAction::Aggregate { .. }
        | NodeAction::AggregateGroups { .. }
        | NodeAction::Start
        | NodeAction::End { .. }
        | NodeAction::JsonStringify { .. }
        | NodeAction::JsonParse { .. }
        | NodeAction::Template { .. }
        | NodeAction::Condition { .. } => super::runtime_values::evaluate(&node.action, values),
        NodeAction::Conversation { .. }
        | NodeAction::TableQuery { .. }
        | NodeAction::TableWrite { .. }
        | NodeAction::TableUpdate { .. }
        | NodeAction::TableDelete { .. }
        | NodeAction::Sql { .. }
        | NodeAction::Nl2sql { .. } => super::runtime_data::evaluate(context, &node.action, values),
        NodeAction::Plugin { plugin_id, input } => crate::plugins::invoke(
            &context.services.db,
            plugin_id,
            resolve(input, values)?,
            context.published,
        ),
        NodeAction::Code {
            code,
            input,
            language,
            entrypoint,
        } => super::code::execute_node(
            (*language, *entrypoint),
            code,
            resolve(input, values)?,
            &context.control,
        ),
        NodeAction::Llm {
            model,
            prompt,
            system,
            temperature,
        } => super::engine::llm(context, model, (system, prompt, *temperature), values),
        NodeAction::Knowledge {
            knowledge_ids,
            query,
            limit,
        } => search(
            context,
            knowledge::SearchRequest {
                knowledge_ids: knowledge_ids.clone(),
                query: render(query, values)?,
                limit: *limit,
            },
        ),
        NodeAction::Http { url, method, body } => {
            super::http::request(&render(url, values)?, *method, &resolve(body, values)?)
        }
        NodeAction::Subworkflow { workflow_id, input } => {
            super::engine::subworkflow(context, workflow_id, resolve(input, values)?)
        }
        NodeAction::Loop { items, workflow_id } => {
            super::loops::run(context, workflow_id, resolve(items, values)?, values)
        }
    }
}

fn search(context: &RuntimeContext<'_>, request: knowledge::SearchRequest) -> Result<Value> {
    let found = knowledge::search(
        &context.services.db,
        context.services.embedder.as_ref(),
        request,
    )?;
    Ok(
        json!({"text":found.iter().map(|item| item.text.as_str()).collect::<Vec<_>>().join("\n\n"),"citations":found}),
    )
}
