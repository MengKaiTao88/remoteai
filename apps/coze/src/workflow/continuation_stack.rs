//! Durable continuations save every leaf result, including inside a nested call or loop.
use super::{
    bindings::resolve, checkpoint::Checkpoint, loops::Signal, Node, NodeAction, RuntimeContext,
};
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Instant;

const MAX_DEPTH: usize = 8;
const MAX_ITERATIONS: usize = 100;
const MAX_TRACE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
pub(super) struct Frame {
    child: Checkpoint,
    mode: Mode,
    traces: Vec<Value>,
    trace_bytes: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Mode {
    Call,
    Loop {
        items: Vec<Value>,
        index: usize,
        results: Vec<Value>,
        output_bytes: usize,
    },
}

pub(super) enum Advance {
    Progress(Option<Value>),
    Paused,
    Complete(Signal),
}

/// Advance at most one leaf with side effects, so the caller can persist before any later effect.
pub(super) fn advance(context: &RuntimeContext<'_>, state: &mut Checkpoint) -> Result<Advance> {
    context.control.check()?;
    if context.depth > MAX_DEPTH || Instant::now() > context.deadline {
        return Err(Error::Limit);
    }
    let order: Vec<_> = state.graph.order()?.into_iter().cloned().collect();
    let Some(node) = order.get(state.cursor) else {
        return Ok(Advance::Complete(state.signal));
    };
    if !state.enabled(node) {
        state.cursor += 1;
        return Ok(Advance::Progress(None));
    }
    if state.frame.is_some() {
        return advance_frame(context, node, state);
    }
    match &node.action {
        NodeAction::Subworkflow { workflow_id, input } => {
            let graph = super::loops::graph(context, workflow_id)?;
            let child = Checkpoint::new(graph, resolve(input, &state.values)?, context.published)?;
            state.frame = Some(Box::new(Frame::new(child, Mode::Call)));
            Ok(Advance::Progress(None))
        }
        NodeAction::Loop { workflow_id, items } => begin_loop(
            context,
            node,
            state,
            (workflow_id, resolve(items, &state.values)?),
        ),
        NodeAction::Repeat { workflow_id, count } => {
            let count = resolve(count, &state.values)?
                .as_u64()
                .ok_or(Error::Workflow)?;
            if count > MAX_ITERATIONS as u64 {
                return Err(Error::Limit);
            }
            begin_loop(
                context,
                node,
                state,
                (workflow_id, json!((0..count).collect::<Vec<_>>())),
            )
        }
        NodeAction::Break | NodeAction::Continue => {
            state.signal = if matches!(node.action, NodeAction::Break) {
                Signal::Break
            } else {
                Signal::Continue
            };
            state.complete(node, Value::Null, 0)?;
            state.cursor = order.len();
            Ok(Advance::Progress(state.trace.last().cloned()))
        }
        _ => leaf(context, node, state),
    }
}

fn leaf(context: &RuntimeContext<'_>, node: &Node, state: &mut Checkpoint) -> Result<Advance> {
    if super::continuation::step(context, node, state)? {
        return Ok(Advance::Paused);
    }
    Ok(Advance::Progress(state.trace.last().cloned()))
}

fn begin_loop(
    context: &RuntimeContext<'_>,
    node: &Node,
    state: &mut Checkpoint,
    source: (&str, Value),
) -> Result<Advance> {
    let items: Vec<Value> = serde_json::from_value(source.1).map_err(|_| Error::Workflow)?;
    if items.len() > MAX_ITERATIONS {
        return Err(Error::Limit);
    }
    if items.is_empty() {
        state.complete(node, json!([]), 0)?;
        return Ok(Advance::Progress(state.trace.last().cloned()));
    }
    let graph = super::loops::graph(context, source.0)?;
    let mut child = Checkpoint::new(graph, json!({"item":items[0],"index":0}), context.published)?;
    child.values["variables"] = state.values["variables"].clone();
    state.frame = Some(Box::new(Frame::new(
        child,
        Mode::Loop {
            items,
            index: 0,
            results: vec![],
            output_bytes: 0,
        },
    )));
    Ok(Advance::Progress(None))
}

fn advance_frame(
    context: &RuntimeContext<'_>,
    node: &Node,
    state: &mut Checkpoint,
) -> Result<Advance> {
    let mut frame = state.frame.take().ok_or(Error::Workflow)?;
    let child_context = RuntimeContext {
        services: context.services,
        depth: context.depth + 1,
        deadline: context.deadline,
        published: context.published,
        control: context.control.clone(),
    };
    let result = advance(&child_context, &mut frame.child);
    let outcome = match result {
        Ok(Advance::Complete(signal)) => return finish_frame(node, state, *frame, signal),
        Ok(Advance::Paused) => {
            state.interaction = frame.child.interaction.clone();
            if let Some(interaction) = state.interaction.as_mut() {
                let mut path = vec![json!(node.id)];
                if let Some(existing) = interaction["path"].as_array() {
                    path.extend(existing.iter().cloned());
                }
                interaction["path"] = json!(path);
            }
            Ok(Advance::Paused)
        }
        Ok(progress) => Ok(progress),
        Err(error) => {
            state
                .trace
                .push(json!({"nodeId":node.id,"name":node.name,"status":"failed",
                "error":error.to_string(),"children":frame.child.trace}));
            Err(error)
        }
    };
    state.frame = Some(frame);
    outcome
}

fn finish_frame(
    node: &Node,
    state: &mut Checkpoint,
    mut frame: Frame,
    signal: Signal,
) -> Result<Advance> {
    frame.trace_bytes += json!(frame.child.trace).to_string().len();
    if frame.trace_bytes > MAX_TRACE_BYTES {
        return Err(Error::Limit);
    }
    frame.traces.push(json!({"trace":frame.child.trace}));
    match &mut frame.mode {
        Mode::Call => {
            if signal != Signal::Completed {
                return Err(Error::Workflow);
            }
            let output = frame.child.output.clone().ok_or(Error::Workflow)?;
            complete_frame(node, state, output, frame.traces)
        }
        Mode::Loop {
            items,
            index,
            results,
            output_bytes,
        } => {
            state.values["variables"] = frame.child.values["variables"].clone();
            if signal == Signal::Completed {
                let output = frame.child.output.clone().ok_or(Error::Workflow)?;
                *output_bytes += output.to_string().len();
                if *output_bytes > MAX_TRACE_BYTES {
                    return Err(Error::Limit);
                }
                results.push(output);
            }
            *index += 1;
            if signal == Signal::Break || *index == items.len() {
                return complete_frame(node, state, json!(results), frame.traces);
            }
            let mut child = Checkpoint::new(
                frame.child.graph.clone(),
                json!({"item":items[*index],"index":index}),
                state.published,
            )?;
            child.values["variables"] = state.values["variables"].clone();
            frame.child = child;
            state.frame = Some(Box::new(frame));
            Ok(Advance::Progress(None))
        }
    }
}

fn complete_frame(
    node: &Node,
    state: &mut Checkpoint,
    output: Value,
    traces: Vec<Value>,
) -> Result<Advance> {
    state.complete(node, output, 0)?;
    if let Some(trace) = state.trace.last_mut() {
        trace["children"] = json!(traces);
    }
    Ok(Advance::Progress(state.trace.last().cloned()))
}

/// Locate the leaf that owns the current question without replaying any preceding nodes.
pub(super) fn respond(state: &mut Checkpoint, input: Value) -> Result<()> {
    if let Some(frame) = state.frame.as_mut() {
        respond(&mut frame.child, input)?;
        state.interaction = None;
        return Ok(());
    }
    let node = state
        .graph
        .order()?
        .get(state.cursor)
        .cloned()
        .cloned()
        .ok_or(Error::Workflow)?;
    super::continuation::validate_response(&node.action, &input)?;
    state.complete(&node, input, 0)
}

impl Frame {
    fn new(child: Checkpoint, mode: Mode) -> Self {
        Self {
            child,
            mode,
            traces: vec![],
            trace_bytes: 0,
        }
    }
}
