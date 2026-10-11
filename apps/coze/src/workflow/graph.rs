use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Graph {
    #[serde(default)]
    pub inputs: Vec<super::InputField>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(flatten)]
    pub action: NodeAction,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum NodeAction {
    /// Wait for a typed user response and persist the continuation before returning.
    Input {
        prompt: String,
        #[serde(default)]
        fields: Vec<super::InputField>,
        #[serde(default)]
        choices: Vec<String>,
    },
    Output {
        value: Value,
    },
    Variable {
        variable_name: String,
        value: Value,
    },
    Aggregate {
        values: Vec<Value>,
    },
    AggregateGroups {
        groups: std::collections::BTreeMap<String, Vec<Value>>,
    },
    Conversation {
        operation: super::conversations::Operation,
        #[serde(default)]
        input: Value,
    },
    Plugin {
        plugin_id: String,
        input: Value,
    },
    TableQuery {
        table_id: String,
        filter: Value,
    },
    TableWrite {
        table_id: String,
        value: Value,
    },
    TableDelete {
        table_id: String,
        row_id: String,
    },
    Sql {
        table_ids: Vec<String>,
        sql: String,
    },
    Nl2sql {
        table_ids: Vec<String>,
        model: String,
        question: String,
    },
    TableUpdate {
        table_id: String,
        row_id: String,
        value: Value,
    },
    KnowledgeWrite {
        knowledge_id: String,
        document_name: String,
        text: String,
    },
    KnowledgeDelete {
        knowledge_id: String,
        document_ids: Value,
    },
    Intent {
        model: String,
        query: String,
        intents: Vec<String>,
    },
    Break,
    Continue,
    Repeat {
        workflow_id: String,
        count: Value,
    },
    Code {
        code: String,
        input: Value,
        #[serde(default)]
        language: crate::code_runtime::Language,
        #[serde(default)]
        entrypoint: bool,
    },
    Start,
    End {
        value: Value,
    },
    Template {
        template: String,
    },
    Llm {
        model: String,
        prompt: String,
        #[serde(default)]
        system: String,
        #[serde(default = "default_temperature")]
        temperature: f32,
    },
    Knowledge {
        knowledge_ids: Vec<String>,
        query: String,
        #[serde(default = "default_limit")]
        limit: usize,
    },
    Condition {
        left: Value,
        right: Value,
        #[serde(default)]
        operator: Operator,
    },
    Http {
        url: String,
        #[serde(default)]
        method: HttpMethod,
        #[serde(default)]
        body: Value,
    },
    JsonParse {
        text: String,
    },
    JsonStringify {
        value: Value,
    },
    Subworkflow {
        workflow_id: String,
        input: Value,
    },
    Loop {
        items: Value,
        workflow_id: String,
    },
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    #[default]
    Equal,
    NotEqual,
    Contains,
    Greater,
    Less,
    Empty,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    #[default]
    Get,
    Post,
    Put,
    Delete,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edge {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub port: Option<bool>,
}

fn default_limit() -> usize {
    6
}

fn default_temperature() -> f32 {
    0.7
}

pub fn validate_value(value: &Value) -> Result<()> {
    let graph: Graph = serde_json::from_value(value.clone()).map_err(|_| Error::Workflow)?;
    graph.order()?;
    Ok(())
}

impl Graph {
    /// Validate the entire graph before executing any node with external effects.
    pub fn order(&self) -> Result<Vec<&Node>> {
        super::inputs::validate_fields(&self.inputs)?;
        let nodes = self.indexed_nodes()?;
        let start = self.start_node()?;
        let counts = self.incoming_counts(&nodes)?;
        if counts
            .iter()
            .any(|(id, count)| *count == 0 && *id != start.id)
        {
            return Err(Error::Workflow);
        }
        self.sort_nodes(&nodes, start, counts)
    }

    fn indexed_nodes(&self) -> Result<HashMap<&str, &Node>> {
        if self.nodes.len() < 2 || self.nodes.len() > 200 || self.edges.len() > 800 {
            return Err(Error::Workflow);
        }
        let nodes: HashMap<_, _> = self
            .nodes
            .iter()
            .map(|node| (node.id.as_str(), node))
            .collect();
        if nodes.len() != self.nodes.len() || self.nodes.iter().any(|node| !valid_node(node)) {
            return Err(Error::Workflow);
        }
        for node in &self.nodes {
            super::validation::validate_action(&node.action)?;
        }
        Ok(nodes)
    }

    fn start_node(&self) -> Result<&Node> {
        let starts: Vec<_> = self
            .nodes
            .iter()
            .filter(|node| matches!(node.action, NodeAction::Start))
            .collect();
        if starts.len() != 1
            || !self
                .nodes
                .iter()
                .any(|node| matches!(node.action, NodeAction::End { .. }))
        {
            return Err(Error::Workflow);
        }
        Ok(starts[0])
    }

    fn incoming_counts<'a>(
        &'a self,
        nodes: &HashMap<&'a str, &Node>,
    ) -> Result<HashMap<&'a str, usize>> {
        let mut counts: HashMap<_, usize> = nodes.keys().map(|id| (*id, 0)).collect();
        let mut unique = HashSet::new();
        for edge in &self.edges {
            let source = nodes.get(edge.source.as_str()).ok_or(Error::Workflow)?;
            let target = nodes.get(edge.target.as_str()).ok_or(Error::Workflow)?;
            if edge.port.is_some() != matches!(source.action, NodeAction::Condition { .. })
                || matches!(
                    source.action,
                    NodeAction::End { .. } | NodeAction::Break | NodeAction::Continue
                )
                || matches!(target.action, NodeAction::Start)
                || !unique.insert((&edge.source, &edge.target, edge.port))
            {
                return Err(Error::Workflow);
            }
            *counts
                .get_mut(edge.target.as_str())
                .ok_or(Error::Workflow)? += 1;
        }
        Ok(counts)
    }

    fn sort_nodes<'a>(
        &'a self,
        nodes: &HashMap<&str, &'a Node>,
        start: &'a Node,
        mut counts: HashMap<&str, usize>,
    ) -> Result<Vec<&'a Node>> {
        let mut pending = VecDeque::from([start]);
        let mut ordered = Vec::new();
        while let Some(node) = pending.pop_front() {
            ordered.push(node);
            for edge in self.edges.iter().filter(|edge| edge.source == node.id) {
                let count = counts
                    .get_mut(edge.target.as_str())
                    .ok_or(Error::Workflow)?;
                *count -= 1;
                if *count == 0 {
                    pending.push_back(nodes[edge.target.as_str()]);
                }
            }
        }
        if ordered.len() != self.nodes.len() {
            return Err(Error::Workflow);
        }
        Ok(ordered)
    }
}
fn valid_node(node: &Node) -> bool {
    !node.id.is_empty()
        && node.id.len() < 100
        && node.id != "input"
        && node.id != "variables"
        && node
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        && node.x.is_finite()
        && node.y.is_finite()
}
