use super::NodeAction;
use crate::{
    error::{Error, Result},
    model::validate_id,
};

pub(super) fn validate_action(action: &NodeAction) -> Result<()> {
    match action {
        NodeAction::Llm {
            model,
            prompt,
            system,
        } => {
            if model.trim().is_empty() || model.len() > 200 || prompt.len() + system.len() > 100_000
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
        NodeAction::TableQuery { table_id, .. }
        | NodeAction::TableWrite { table_id, .. }
        | NodeAction::TableDelete { table_id, .. } => validate_id(table_id)?,
        NodeAction::Loop { workflow_id, .. } | NodeAction::Subworkflow { workflow_id, .. } => {
            validate_id(workflow_id)?
        }
        NodeAction::Code { code, .. } if code.len() > 100_000 => return Err(Error::Limit),
        NodeAction::Http { url, .. } if !url.starts_with("https://") || url.len() > 8000 => {
            return Err(Error::Workflow)
        }
        _ => {}
    }
    Ok(())
}
