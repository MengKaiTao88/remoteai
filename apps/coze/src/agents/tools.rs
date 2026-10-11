use super::Agent;
use crate::{
    api::Services,
    error::{Error, Result},
    jobs::JobControl,
    knowledge,
    model::ResourceKind,
    proxy::ToolCall,
    resources, tables, workflow,
};
use serde_json::{json, Value};

#[derive(Clone, Copy)]
enum Operation {
    Invoke,
    Query,
    Write,
    Delete,
}

pub(super) struct Tool {
    id: String,
    name: String,
    kind: ResourceKind,
    operation: Operation,
    pub spec: Value,
}

pub(super) fn returns_citations(tools: &[Tool], call: &ToolCall) -> bool {
    tools
        .iter()
        .any(|tool| tool.name == call.function.name && tool.kind == ResourceKind::Knowledge)
}

pub(super) fn prepare(services: &Services, agent: &Agent) -> Result<Vec<Tool>> {
    let mut tools = Vec::new();
    for id in &agent.tool_ids {
        let (resource, body) = resources::published(&services.db, id)?;
        let schema = match resource.kind {
            ResourceKind::Workflow => workflow::schema(
                &serde_json::from_value::<workflow::Graph>(body).map_err(|_| Error::Workflow)?,
            ),
            ResourceKind::Knowledge => {
                json!({"type":"object","properties":{"query":{"type":"string"}},
                "required":["query"],"additionalProperties":false})
            }
            ResourceKind::Table => {
                json!({"type":"object","properties":{"filter":{"type":"object"}}})
            }
            ResourceKind::Plugin => json!({"type":"object","additionalProperties":true}),
            _ => return Err(Error::Invalid),
        };
        let name = format!("coze_{}", id.replace('-', ""));
        tools.push(make_tool(id,&name,resource.kind,json!({"name":name,
            "description":format!("{}: {}{}",resource.name,resource.description,
                if resource.kind == ResourceKind::Knowledge { " Cite reference numbers as [1], [2], etc." } else { "" }),
            "parameters":schema})));
        if resource.kind == ResourceKind::Table && agent.writable_table_ids.contains(id) {
            tools.extend(table_mutations(id, &name, &resource.name));
        }
    }
    if tools.len() > 32 {
        return Err(Error::Limit);
    }
    Ok(tools)
}

fn make_tool(id: &str, name: &str, kind: ResourceKind, function: Value) -> Tool {
    Tool {
        id: id.into(),
        name: name.into(),
        kind,
        operation: if kind == ResourceKind::Table {
            Operation::Query
        } else {
            Operation::Invoke
        },
        spec: json!({"type":"function","function":function}),
    }
}

fn table_mutations(id: &str, name: &str, title: &str) -> Vec<Tool> {
    [
        (
            "write",
            Operation::Write,
            json!({"type":"object","properties":{
        "id":{"type":"string","description":"Existing row ID to update; omit to insert"},
        "value":{"type":"object"}},"required":["value"]}),
        ),
        (
            "delete",
            Operation::Delete,
            json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}),
        ),
    ]
    .into_iter()
    .map(|(suffix, operation, schema)| {
        let name = format!("{name}_{suffix}");
        Tool {
            id: id.into(),
            name: name.clone(),
            kind: ResourceKind::Table,
            operation,
            spec: json!({"type":"function","function":{"name":name,
                    "description":format!("{suffix} a row in {title}"),"parameters":schema}}),
        }
    })
    .collect()
}

pub(super) fn invoke(
    services: &Services,
    tools: &[Tool],
    call: &ToolCall,
    control: &JobControl,
) -> Result<Value> {
    control.check()?;
    let tool = tools
        .iter()
        .find(|tool| tool.name == call.function.name)
        .ok_or(Error::Invalid)?;
    let input: Value =
        serde_json::from_str(&call.function.arguments).map_err(|_| Error::Invalid)?;
    if !input.is_object() {
        return Err(Error::Invalid);
    }
    control
        .emit(json!({"type":"tool_start","id":call.id,"name":call.function.name,"input":input}))?;
    let output = match tool.kind {
        ResourceKind::Workflow => workflow::run_controlled(
            services,
            workflow::RunRequest {
                resource_id: tool.id.clone(),
                input,
                published: true,
            },
            control,
        )?,
        ResourceKind::Plugin => crate::plugins::invoke(&services.db, &tool.id, input, true)?,
        ResourceKind::Knowledge => json!(knowledge::search(
            &services.db,
            services.embedder.as_ref(),
            knowledge::SearchRequest {
                knowledge_ids: vec![tool.id.clone()],
                query: input["query"].as_str().ok_or(Error::Invalid)?.into(),
                limit: 6
            }
        )?),
        ResourceKind::Table => table(services, tool, &input)?,
        _ => return Err(Error::Invalid),
    };
    control.check()?;
    if output.to_string().len() > 256 * 1024 {
        return Err(Error::Limit);
    }
    Ok(output)
}

fn table(services: &Services, tool: &Tool, input: &Value) -> Result<Value> {
    match tool.operation {
        Operation::Query => tables::query(
            &services.db,
            &tool.id,
            input.get("filter").unwrap_or(&json!({})),
        ),
        Operation::Write => tables::write(
            &services.db,
            &tool.id,
            input["id"].as_str(),
            input["value"].clone(),
        ),
        Operation::Delete => tables::delete(
            &services.db,
            &tool.id,
            input["id"].as_str().ok_or(Error::Invalid)?,
        ),
        Operation::Invoke => Err(Error::Invalid),
    }
}
