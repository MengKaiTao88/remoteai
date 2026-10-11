//! Local agent planning, tool use and conversation persistence.
mod history;
mod runtime;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tool_tests;
mod tools;

use crate::{
    error::{Error, Result},
    model::validate_id,
};
pub use history::{conversations, initialize, messages};
pub use runtime::{chat, start};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Agent {
    pub model: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub knowledge_ids: Vec<String>,
    #[serde(default)]
    pub tool_ids: Vec<String>,
    #[serde(default)]
    pub writable_table_ids: Vec<String>,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_steps")]
    pub max_steps: usize,
    #[serde(default = "default_memory")]
    pub memory_turns: usize,
}

fn default_temperature() -> f32 {
    0.7
}
fn default_steps() -> usize {
    8
}
fn default_memory() -> usize {
    20
}

pub fn validate(value: &Value) -> Result<()> {
    let agent: Agent = serde_json::from_value(value.clone()).map_err(|_| Error::Invalid)?;
    if agent.model.trim().is_empty()
        || agent.model.len() > 200
        || agent.prompt.len() > 100_000
        || agent.knowledge_ids.len() > 20
        || agent.tool_ids.len() > 20
        || !(0.0..=2.0).contains(&agent.temperature)
        || !(1..=20).contains(&agent.max_steps)
        || agent.memory_turns > 40
        || agent.writable_table_ids.len() > 10
    {
        return Err(Error::Invalid);
    }
    let mut unique = HashSet::new();
    for id in &agent.tool_ids {
        validate_id(id)?;
        if !unique.insert(id) {
            return Err(Error::Invalid);
        }
    }
    for id in &agent.knowledge_ids {
        validate_id(id)?;
    }
    for id in &agent.writable_table_ids {
        if !agent.tool_ids.contains(id) {
            return Err(Error::Invalid);
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRequest {
    pub agent_id: String,
    pub conversation_id: Option<String>,
    pub message: String,
    #[serde(default)]
    pub published: bool,
}
