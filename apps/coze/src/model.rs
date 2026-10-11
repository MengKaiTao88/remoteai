use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    App,
    Agent,
    Workflow,
    Knowledge,
    Prompt,
    Table,
    Plugin,
}

impl ResourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::App => "app",
            Self::Agent => "agent",
            Self::Workflow => "workflow",
            Self::Knowledge => "knowledge",
            Self::Prompt => "prompt",
            Self::Table => "table",
            Self::Plugin => "plugin",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub kind: ResourceKind,
    pub name: String,
    pub description: String,
    pub draft: Value,
    pub revision: u64,
    pub published_revision: Option<u64>,
    pub mcp_enabled: bool,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceInput {
    pub id: Option<String>,
    pub kind: ResourceKind,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub draft: Value,
    pub revision: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub knowledge_id: String,
    pub name: String,
    pub chunks: usize,
    pub bytes: usize,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub chunk_id: String,
    pub document_id: String,
    pub document_name: String,
    pub text: String,
    pub score: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub citations: Vec<Citation>,
}

pub fn validate_id(id: &str) -> crate::error::Result<()> {
    uuid::Uuid::parse_str(id).map_err(|_| crate::error::Error::Invalid)?;
    Ok(())
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
