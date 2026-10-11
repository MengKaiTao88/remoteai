use super::NodeAction;
use crate::{
    error::{Error, Result},
    model::validate_id,
};

pub(super) fn validate_action(action: &NodeAction) -> Result<()> {
    match action {
        NodeAction::Input {
            prompt,
            fields,
            choices,
        } => {
            super::inputs::validate_fields(fields)?;
            if prompt.len() > 100_000
                || choices.len() > 50
                || choices
                    .iter()
                    .any(|choice| choice.is_empty() || choice.len() > 2000)
            {
                return Err(Error::Workflow);
            }
        }
        NodeAction::Variable { variable_name, .. }
            if variable_name.is_empty()
                || variable_name.len() > 100
                || !variable_name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_') =>
        {
            return Err(Error::Workflow);
        }
        NodeAction::Aggregate { values } if values.is_empty() || values.len() > 100 => {
            return Err(Error::Workflow);
        }
        NodeAction::AggregateGroups { groups } => {
            if groups.is_empty()
                || groups.len() > 100
                || groups.iter().any(|(name, values)| {
                    name.is_empty() || name.len() > 100 || values.is_empty() || values.len() > 100
                })
            {
                return Err(Error::Workflow);
            }
        }
        NodeAction::Llm {
            model,
            prompt,
            system,
            temperature,
        } => {
            if model.trim().is_empty()
                || model.len() > 200
                || prompt.len() + system.len() > 100_000
                || !temperature.is_finite()
                || !(0.0..=2.0).contains(temperature)
            {
                return Err(Error::Workflow);
            }
        }
        NodeAction::Knowledge {
            knowledge_ids,
            query,
            limit,
        } => {
            if knowledge_ids.is_empty()
                || knowledge_ids.len() > 20
                || query.trim().is_empty()
                || !(1..=20).contains(limit)
            {
                return Err(Error::Workflow);
            }
            for id in knowledge_ids {
                validate_id(id)?;
            }
        }
        NodeAction::Plugin { plugin_id, .. } => validate_id(plugin_id)?,
        NodeAction::Sql { table_ids, .. } | NodeAction::Nl2sql { table_ids, .. } => {
            if table_ids.is_empty() || table_ids.len() > 20 {
                return Err(Error::Workflow);
            }
            for id in table_ids {
                validate_id(id)?;
            }
        }
        NodeAction::TableQuery { table_id, .. }
        | NodeAction::TableWrite { table_id, .. }
        | NodeAction::TableUpdate { table_id, .. }
        | NodeAction::TableDelete { table_id, .. } => validate_id(table_id)?,
        NodeAction::Loop { workflow_id, .. }
        | NodeAction::Repeat { workflow_id, .. }
        | NodeAction::Subworkflow { workflow_id, .. } => validate_id(workflow_id)?,
        NodeAction::KnowledgeWrite { knowledge_id, .. }
        | NodeAction::KnowledgeDelete { knowledge_id, .. } => {
            validate_id(knowledge_id)?;
        }
        NodeAction::Intent {
            model,
            query,
            intents,
        } => {
            if model.trim().is_empty()
                || query.len() > 100_000
                || intents.is_empty()
                || intents.len() > 50
                || intents
                    .iter()
                    .any(|intent| intent.is_empty() || intent.len() > 500)
            {
                return Err(Error::Workflow);
            }
        }
        NodeAction::Code { code, .. } if code.len() > 100_000 => return Err(Error::Limit),
        NodeAction::Http { url, .. } if !url.starts_with("https://") || url.len() > 8000 => {
            return Err(Error::Workflow)
        }
        _ => {}
    }
    Ok(())
}
