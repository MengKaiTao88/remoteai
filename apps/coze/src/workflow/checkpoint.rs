use super::{Graph, Node, NodeAction};
use crate::{
    database::Database,
    error::{Error, Result},
    model::now,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
 state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_conversations (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL
 REFERENCES workflow_conversations(id) ON DELETE CASCADE,
 role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_messages_conversation
 ON workflow_messages(conversation_id, created_at);
";

/// Apply additive migrations and stop interrupted runs without replaying uncertain side effects.
pub fn initialize(db: &Database) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    tx.execute_batch(SCHEMA)?;
    tx.execute(
        "UPDATE runs SET status='interrupted',error=?1,finished_at=?2
        WHERE status='running'",
        params!["运行已中断，请检查已完成的步骤后重新运行。", now()],
    )?;
    tx.commit()?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Checkpoint {
    pub graph: Graph,
    pub published: bool,
    pub values: Value,
    pub activated: HashMap<String, Option<bool>>,
    pub cursor: usize,
    pub trace: Vec<Value>,
    pub output: Option<Value>,
    pub output_bytes: usize,
    pub interaction: Option<Value>,
    pub revisions: Option<BTreeMap<String, u64>>,
    #[serde(default)]
    pub frame: Option<Box<super::continuation_stack::Frame>>,
    #[serde(default)]
    pub signal: super::loops::Signal,
}

impl Checkpoint {
    pub fn new(graph: Graph, input: Value, published: bool) -> Result<Self> {
        graph.order()?;
        super::inputs::validate_input(&graph.inputs, &input)?;
        if input.to_string().len() > 1024 * 1024 {
            return Err(Error::Limit);
        }
        Ok(Self {
            graph,
            published,
            values: json!({"input":input,"variables":{}}),
            activated: HashMap::new(),
            cursor: 0,
            trace: Vec::new(),
            output: None,
            output_bytes: 0,
            interaction: None,
            revisions: None,
            frame: None,
            signal: super::loops::Signal::Completed,
        })
    }

    pub fn enabled(&self, node: &Node) -> bool {
        matches!(node.action, NodeAction::Start)
            || self
                .graph
                .edges
                .iter()
                .filter(|edge| edge.target == node.id)
                .any(|edge| {
                    self.activated
                        .get(&edge.source)
                        .is_some_and(|port| edge.port.is_none() || edge.port == *port)
                })
    }

    pub fn complete(&mut self, node: &Node, value: Value, duration: u128) -> Result<()> {
        let bytes = value.to_string().len();
        self.output_bytes += bytes;
        if bytes > 1024 * 1024 || self.output_bytes > 8 * 1024 * 1024 {
            return Err(Error::Limit);
        }
        let port = matches!(node.action, NodeAction::Condition { .. })
            .then(|| value.as_bool())
            .flatten();
        self.activated.insert(node.id.clone(), port);
        if matches!(node.action, NodeAction::End { .. }) {
            self.output = Some(value.clone());
        }
        self.trace.push(
            json!({"nodeId":node.id,"name":node.name,"status":"completed",
            "output":value,"durationMs":duration}),
        );
        self.values[&node.id] = json!({"output":value});
        self.cursor += 1;
        self.interaction = None;
        Ok(())
    }
}

pub(super) fn store(db: &Database, id: &str, checkpoint: &Checkpoint, status: &str) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    let state = serde_json::to_string(checkpoint).map_err(|_| Error::Workflow)?;
    tx.execute(
        "INSERT INTO workflow_checkpoints(run_id,state) VALUES (?1,?2)
        ON CONFLICT(run_id) DO UPDATE SET state=excluded.state",
        params![id, state],
    )?;
    tx.execute(
        "UPDATE runs SET status=?1,trace=?2 WHERE id=?3",
        params![status, json!(checkpoint.trace).to_string(), id],
    )?;
    tx.commit()?;
    Ok(())
}

pub(super) fn load(db: &Database, id: &str) -> Result<Checkpoint> {
    let text: String = db
        .connect()?
        .query_row(
            "SELECT state FROM workflow_checkpoints
        WHERE run_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    serde_json::from_str(&text).map_err(|_| Error::Workflow)
}

pub(super) fn claim(db: &Database, id: &str, state: &Checkpoint, interaction: &str) -> Result<()> {
    let mut conn = db.connect()?;
    let tx = conn.transaction()?;
    if tx.execute(
        "UPDATE runs SET status='running' WHERE id=?1 AND status='paused'
         AND EXISTS(SELECT 1 FROM workflow_checkpoints WHERE run_id=?1
             AND json_extract(state,'$.interaction.id')=?2)",
        params![id, interaction],
    )? != 1
    {
        return Err(Error::Conflict);
    }
    tx.execute(
        "UPDATE workflow_checkpoints SET state=?1 WHERE run_id=?2",
        params![
            serde_json::to_string(state).map_err(|_| Error::Workflow)?,
            id
        ],
    )?;
    tx.commit()?;
    Ok(())
}
