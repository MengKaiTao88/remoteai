use super::{
    bindings::{render, resolve},
    graph::{Graph, Node, NodeAction, Operator},
    http,
};
use crate::{
    api::Services,
    error::{Error, Result},
    knowledge,
    model::{Message, ResourceKind},
    resources,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub struct RuntimeContext<'a> {
    pub services: &'a Services,
    pub depth: usize,
    pub deadline: Instant,
    pub published: bool,
}

pub fn execute(
    context: &RuntimeContext<'_>,
    graph: &Graph,
    input: Value,
    trace: &mut Vec<Value>,
) -> Result<Value> {
    if context.depth > 8 || input.to_string().len() > 1024 * 1024 {
        return Err(Error::Limit);
    }
    let order = graph.order()?;
    super::inputs::validate_input(&graph.inputs, &input)?;
    let mut values = json!({"input":input});
    let mut activated = HashMap::new();
    let mut output = None;
    let mut output_bytes = 0;
    for node in order {
        if Instant::now() > context.deadline {
            return Err(Error::Limit);
        }
        let enabled = matches!(node.action, NodeAction::Start)
            || graph
                .edges
                .iter()
                .filter(|edge| edge.target == node.id)
                .any(|edge| {
                    activated
                        .get(&edge.source)
                        .is_some_and(|port| edge.port.is_none() || edge.port == *port)
                });
        if !enabled {
            continue;
        }
        let started = Instant::now();
        let result = evaluate(context, node, &values).and_then(|value| {
            let size = value.to_string().len();
            output_bytes += size;
            if size > 1024 * 1024 || output_bytes > 8 * 1024 * 1024 {
                return Err(Error::Limit);
            }
            Ok(value)
        });
        let record = match &result {
            Ok(value) => {
                json!({"nodeId":node.id,"name":node.name,"status":"completed","output":value,
                "durationMs":started.elapsed().as_millis()})
            }
            Err(error) => {
                json!({"nodeId":node.id,"name":node.name,"status":"failed","error":error.to_string(),
                "durationMs":started.elapsed().as_millis()})
            }
        };
        trace.push(record);
        let value = result?;
        let port = matches!(node.action, NodeAction::Condition { .. })
            .then(|| value.as_bool())
            .flatten();
        activated.insert(node.id.clone(), port);
        if matches!(node.action, NodeAction::End { .. }) {
            output = Some(value.clone());
        }
        values[&node.id] = json!({"output":value});
    }
    output.ok_or(Error::Workflow)
}

fn evaluate(context: &RuntimeContext<'_>, node: &Node, values: &Value) -> Result<Value> {
    match &node.action {
        NodeAction::Plugin { plugin_id, input } => crate::plugins::invoke(
            &context.services.db,
            plugin_id,
            resolve(input, values)?,
            context.published,
        ),
        NodeAction::TableQuery { table_id, filter } => {
            crate::tables::query(&context.services.db, table_id, &resolve(filter, values)?)
        }
        NodeAction::TableWrite { table_id, value } => crate::tables::write(
            &context.services.db,
            table_id,
            None,
            resolve(value, values)?,
        ),
        NodeAction::TableDelete { table_id, row_id } => {
            crate::tables::delete(&context.services.db, table_id, &render(row_id, values)?)
        }
        NodeAction::Code { code, input } => super::code::execute(code, resolve(input, values)?),
        NodeAction::Start => Ok(values["input"].clone()),
        NodeAction::End { value } | NodeAction::JsonStringify { value } => {
            let value = resolve(value, values)?;
            Ok(if matches!(node.action, NodeAction::JsonStringify { .. }) {
                json!(value.to_string())
            } else {
                value
            })
        }
        NodeAction::Template { template } => Ok(json!(render(template, values)?)),
        NodeAction::JsonParse { text } => {
            serde_json::from_str(&render(text, values)?).map_err(|_| Error::Workflow)
        }
        NodeAction::Llm {
            model,
            prompt,
            system,
        } => llm(context, model, (system, prompt), values),
        NodeAction::Knowledge {
            knowledge_ids,
            query,
            limit,
        } => {
            let found = knowledge::search(
                &context.services.db,
                context.services.embedder.as_ref(),
                knowledge::SearchRequest {
                    knowledge_ids: knowledge_ids.clone(),
                    query: render(query, values)?,
                    limit: *limit,
                },
            )?;
            Ok(
                json!({"text":found.iter().map(|item| item.text.as_str()).collect::<Vec<_>>().join("\n\n"),"citations":found}),
            )
        }
        NodeAction::Condition {
            left,
            right,
            operator,
        } => condition(resolve(left, values)?, resolve(right, values)?, *operator),
        NodeAction::Http { url, method, body } => {
            http::request(&render(url, values)?, *method, &resolve(body, values)?)
        }
        NodeAction::Subworkflow { workflow_id, input } => {
            subworkflow(context, workflow_id, resolve(input, values)?)
        }
        NodeAction::Loop { items, workflow_id } => {
            run_loop(context, workflow_id, resolve(items, values)?)
        }
    }
}

fn llm(
    context: &RuntimeContext<'_>,
    model: &str,
    prompts: (&str, &str),
    values: &Value,
) -> Result<Value> {
    let messages = vec![
        Message {
            role: "system".into(),
            content: render(prompts.0, values)?,
            citations: vec![],
        },
        Message {
            role: "user".into(),
            content: render(prompts.1, values)?,
            citations: vec![],
        },
    ];
    Ok(json!(context.services.proxy.chat(model, &messages, 0.7)?))
}

fn condition(left: Value, right: Value, operator: Operator) -> Result<Value> {
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

fn subworkflow(context: &RuntimeContext<'_>, id: &str, input: Value) -> Result<Value> {
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
            ..*context
        },
        &graph,
        input,
        &mut Vec::new(),
    )
}

fn run_loop(context: &RuntimeContext<'_>, id: &str, items: Value) -> Result<Value> {
    let items = items.as_array().ok_or(Error::Workflow)?;
    if items.len() > 100 {
        return Err(Error::Limit);
    }
    let results = items
        .iter()
        .enumerate()
        .map(|(index, item)| subworkflow(context, id, json!({"item":item,"index":index})))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!(results))
}

impl<'a> RuntimeContext<'a> {
    pub fn new(services: &'a Services, published: bool) -> Self {
        Self {
            services,
            depth: 0,
            deadline: Instant::now() + Duration::from_secs(300),
            published,
        }
    }
}
