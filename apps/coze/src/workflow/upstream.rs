//! Strict adapters for upstream canvas nodes with equivalent local execution semantics.
mod values;

use super::{graph::Edge, Graph, InputField, InputKind, Node, NodeAction};
use crate::error::{Error, Result};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Import a native graph or an upstream canvas. Unknown behavior is rejected before saving.
pub fn import_canvas(value: &Value) -> Result<Graph> {
    if value.to_string().len() > 8 * 1024 * 1024 {
        return Err(Error::Limit);
    }
    if let Ok(graph) = serde_json::from_value::<Graph>(value.clone()) {
        graph.order()?;
        return Ok(graph);
    }
    let nodes = value["nodes"].as_array().ok_or(Error::Workflow)?;
    let index: HashMap<_, _> = nodes
        .iter()
        .map(|node| Ok((text(node, "id")?, text(node, "type")?)))
        .collect::<Result<_>>()?;
    let start = nodes
        .iter()
        .find(|node| node["type"] == "1")
        .ok_or(Error::Workflow)?;
    let graph = Graph {
        inputs: fields(&start["data"]["outputs"])?,
        nodes: nodes
            .iter()
            .map(|node| convert_node(node, &index))
            .collect::<Result<_>>()?,
        edges: value["edges"]
            .as_array()
            .ok_or(Error::Workflow)?
            .iter()
            .map(convert_edge)
            .collect::<Result<_>>()?,
    };
    graph.order()?;
    Ok(graph)
}

fn convert_node(node: &Value, index: &HashMap<&str, &str>) -> Result<Node> {
    if node
        .get("blocks")
        .and_then(Value::as_array)
        .is_some_and(|blocks| !blocks.is_empty())
    {
        return Err(unsupported("嵌套画布"));
    }
    let kind = text(node, "type")?;
    let inputs = &node["data"]["inputs"];
    let params = values::parameters(&inputs["inputParameters"], index)?;
    let action = action(kind, inputs, &params, index)?;
    Ok(Node {
        id: text(node, "id")?.to_owned(),
        name: node["data"]["nodeMeta"]["title"]
            .as_str()
            .unwrap_or("节点")
            .to_owned(),
        x: node["meta"]["position"]["x"].as_f64().unwrap_or(0.0) as f32,
        y: node["meta"]["position"]["y"].as_f64().unwrap_or(0.0) as f32,
        action,
    })
}

fn action(
    kind: &str,
    inputs: &Value,
    params: &Value,
    index: &HashMap<&str, &str>,
) -> Result<NodeAction> {
    match kind {
        "1" => Ok(NodeAction::Start),
        "2" => Ok(NodeAction::End {
            value: if inputs["terminatePlan"] == "useAnswerContent" {
                json!(values::template(
                    &values::typed(&inputs["content"], index)?,
                    params
                )?)
            } else {
                params.clone()
            },
        }),
        "3" => llm(inputs, params, index),
        "5" => Ok(NodeAction::Code {
            code: text(inputs, "code")?.to_owned(),
            input: params.clone(),
            language: match inputs["language"].as_u64() {
                Some(3) => crate::code_runtime::Language::Python,
                Some(5) => crate::code_runtime::Language::Typescript,
                _ => return Err(unsupported("代码语言")),
            },
            entrypoint: true,
        }),
        "13" => Ok(NodeAction::Output {
            value: json!(values::template(
                &values::typed(&inputs["content"], index)?,
                params
            )?),
        }),
        "30" => {
            let schema: Value =
                serde_json::from_str(text(inputs, "outputSchema")?).map_err(|_| Error::Workflow)?;
            Ok(NodeAction::Input {
                prompt: "请填写信息后继续。".into(),
                fields: fields(&schema)?,
                choices: vec![],
            })
        }
        "18" if inputs["answer_type"] == "text" && inputs["extra_output"] != true => {
            Ok(NodeAction::Input {
                prompt: values::template(&inputs["question"], params)?,
                fields: vec![InputField {
                    name: "USER_RESPONSE".into(),
                    description: "回答".into(),
                    kind: InputKind::String,
                    required: true,
                }],
                choices: vec![],
            })
        }
        "32" => aggregate(inputs, index),
        "19" => Ok(NodeAction::Break),
        "29" => Ok(NodeAction::Continue),
        "58" => Ok(NodeAction::JsonStringify {
            value: params.get("input").cloned().ok_or(Error::Workflow)?,
        }),
        "59" => Ok(NodeAction::JsonParse {
            text: text(params, "input")?.to_owned(),
        }),
        _ => Err(unsupported(
            if kind.bytes().all(|byte| byte.is_ascii_digit()) && kind.len() < 8 {
                kind
            } else {
                "未知类型"
            },
        )),
    }
}

fn llm(inputs: &Value, params: &Value, index: &HashMap<&str, &str>) -> Result<NodeAction> {
    let settings = values::parameters(&inputs["llmParam"], index)?;
    if settings["enableChatHistory"] == true
        || settings["responseFormat"] == 1
        || inputs["fcParam"]
            .as_object()
            .is_some_and(|value| !value.is_empty())
    {
        return Err(unsupported("大模型历史、工具或结构化输出"));
    }
    let model = settings
        .get("modelName")
        .or_else(|| settings.get("modleName"))
        .and_then(Value::as_str)
        .ok_or(Error::Workflow)?
        .to_owned();
    Ok(NodeAction::Llm {
        model,
        prompt: values::template(&settings["prompt"], params)?,
        system: values::template(settings.get("systemPrompt").unwrap_or(&json!("")), params)?,
        temperature: settings["temperature"].as_f64().unwrap_or(0.7) as f32,
    })
}

fn aggregate(inputs: &Value, index: &HashMap<&str, &str>) -> Result<NodeAction> {
    let groups = inputs["mergeGroups"]
        .as_array()
        .ok_or(Error::Workflow)?
        .iter()
        .map(|group| {
            let values = group["variables"]
                .as_array()
                .ok_or(Error::Workflow)?
                .iter()
                .map(|value| values::typed(value, index))
                .collect::<Result<Vec<_>>>()?;
            Ok((text(group, "name")?.to_owned(), values))
        })
        .collect::<Result<_>>()?;
    Ok(NodeAction::AggregateGroups { groups })
}

fn fields(value: &Value) -> Result<Vec<InputField>> {
    let Some(fields) = value.as_array() else {
        return if value.is_null() {
            Ok(vec![])
        } else {
            Err(Error::Workflow)
        };
    };
    fields
        .iter()
        .map(|field| {
            Ok(InputField {
                name: text(field, "name")?.to_owned(),
                description: field["description"].as_str().unwrap_or("").to_owned(),
                kind: match text(field, "type")? {
                    "string" => InputKind::String,
                    "integer" => InputKind::Integer,
                    "float" | "number" => InputKind::Number,
                    "boolean" => InputKind::Boolean,
                    "object" => InputKind::Object,
                    "list" | "array" => InputKind::Array,
                    _ => return Err(unsupported("输入字段类型")),
                },
                required: field["required"].as_bool().unwrap_or(false),
            })
        })
        .collect()
}

fn convert_edge(edge: &Value) -> Result<Edge> {
    if edge["sourcePortID"]
        .as_str()
        .is_some_and(|port| !port.is_empty())
    {
        return Err(unsupported("多出口分支"));
    }
    Ok(Edge {
        source: text(edge, "sourceNodeID")?.to_owned(),
        target: text(edge, "targetNodeID")?.to_owned(),
        port: None,
    })
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Error::Workflow)
}

fn unsupported(reason: &str) -> Error {
    Error::WorkflowImport(reason.into())
}
