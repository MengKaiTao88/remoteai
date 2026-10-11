use super::{
    bindings::render,
    graph::{Graph, NodeAction, Operator},
};
use crate::{
    api::Services,
    error::{Error, Result},
    model::ResourceKind,
    resources,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub struct RuntimeContext<'a> {
    pub services: &'a Services,
    pub depth: usize,
    pub deadline: Instant,
    pub published: bool,
    pub control: crate::jobs::JobControl,
}

pub fn execute(
    context: &RuntimeContext<'_>,
    graph: &Graph,
    input: Value,
    trace: &mut Vec<Value>,
) -> Result<Value> {
    let mut state = super::checkpoint::Checkpoint::new(graph.clone(), input, context.published)?;
    let result = execute_state(context, &mut state);
    trace.extend(state.trace);
    if result? != super::loops::Signal::Completed {
        return Err(Error::Workflow);
    }
    state.output.ok_or(Error::Workflow)
}

pub(super) fn execute_state(
    context: &RuntimeContext<'_>,
    state: &mut super::checkpoint::Checkpoint,
) -> Result<super::loops::Signal> {
    if context.depth > 8 {
        return Err(Error::Limit);
    }
    let order: Vec<_> = state.graph.order()?.into_iter().cloned().collect();
    // Nested input requires a continuation stack; reject before executing child side effects.
    if order
        .iter()
        .any(|node| matches!(node.action, NodeAction::Input { .. }))
    {
        return Err(Error::Workflow);
    }
    for node in order {
        context.control.check()?;
        if Instant::now() > context.deadline {
            return Err(Error::Limit);
        }
        if !state.enabled(&node) {
            continue;
        }
        match node.action {
            NodeAction::Break => return Ok(super::loops::Signal::Break),
            NodeAction::Continue => return Ok(super::loops::Signal::Continue),
            _ => {
                super::continuation::step(context, &node, state)?;
            }
        }
    }
    Ok(super::loops::Signal::Completed)
}

pub(super) use super::runtime_nodes::evaluate;

pub(super) fn llm(
    context: &RuntimeContext<'_>,
    model: &str,
    prompts: (&str, &str, f32),
    values: &Value,
) -> Result<Value> {
    let messages = [
        json!({"role":"system","content":render(prompts.0,values)?}),
        json!({"role":"user","content":render(prompts.1,values)?}),
    ];
    let completion = context.services.proxy.complete(
        crate::proxy::CompletionRequest {
            model,
            messages: &messages,
            temperature: prompts.2,
            tools: &[],
        },
        &context.control,
    )?;
    Ok(json!(completion.content))
}

pub(super) fn condition(left: Value, right: Value, operator: Operator) -> Result<Value> {
    let value = match operator {
        Operator::Equal => left == right,
        Operator::NotEqual => left != right,
        Operator::Contains => left
            .as_str()
            .ok_or(Error::Workflow)?
            .contains(right.as_str().ok_or(Error::Workflow)?),
        Operator::Greater => {
            left.as_f64().ok_or(Error::Workflow)? > right.as_f64().ok_or(Error::Workflow)?
        }
        Operator::Less => {
            left.as_f64().ok_or(Error::Workflow)? < right.as_f64().ok_or(Error::Workflow)?
        }
        Operator::Empty => {
            left.is_null()
                || left.as_str().is_some_and(str::is_empty)
                || left.as_array().is_some_and(Vec::is_empty)
        }
    };
    Ok(json!(value))
}

pub(super) fn subworkflow(context: &RuntimeContext<'_>, id: &str, input: Value) -> Result<Value> {
    let (resource, body) = if context.published {
        resources::published(&context.services.db, id)?
    } else {
        let resource = resources::get(&context.services.db, id)?;
        let draft = resource.draft.clone();
        (resource, draft)
    };
    if resource.kind != ResourceKind::Workflow {
        return Err(Error::Workflow);
    }
    let graph = serde_json::from_value(body).map_err(|_| Error::Workflow)?;
    execute(
        &RuntimeContext {
            depth: context.depth + 1,
            services: context.services,
            deadline: context.deadline,
            published: context.published,
            control: context.control.clone(),
        },
        &graph,
        input,
        &mut Vec::new(),
    )
}

impl<'a> RuntimeContext<'a> {
    pub fn new(services: &'a Services, published: bool) -> Self {
        Self {
            services,
            depth: 0,
            deadline: Instant::now() + Duration::from_secs(300),
            published,
            control: crate::jobs::JobControl::detached(),
        }
    }
}
