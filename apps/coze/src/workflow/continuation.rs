use super::{
    bindings::render,
    checkpoint::{self, Checkpoint},
    NodeAction, RuntimeContext,
};
use crate::{
    api::Services,
    error::{Error, Result},
    model::{now, validate_id},
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Instant;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeRequest {
    pub run_id: String,
    pub interaction_id: String,
    pub input: Value,
}

/// Continue the immutable graph snapshot. A single caller can claim a paused run.
pub fn resume(services: &Services, request: ResumeRequest) -> Result<Value> {
    resume_controlled(services, request, &crate::jobs::JobControl::detached())
}

/// MCP may only resume a published workflow whose external access remains enabled.
pub fn resume_published(services: &Services, request: ResumeRequest) -> Result<Value> {
    validate_id(&request.run_id)?;
    let state = checkpoint::load(&services.db, &request.run_id)?;
    if !state.published {
        return Err(Error::Unpublished);
    }
    let resource_id: String = services.db.connect()?.query_row(
        "SELECT resource_id FROM runs WHERE id=?1",
        [&request.run_id],
        |row| row.get(0),
    )?;
    let resource = crate::resources::get(&services.db, &resource_id)?;
    if !resource.mcp_enabled {
        return Err(Error::Unpublished);
    }
    resume(services, request)
}

pub fn resume_start(services: &Services, request: ResumeRequest) -> Result<Value> {
    let services = services.clone();
    services.jobs.clone().start(move |control| {
        let _lease = services.maintenance.read().map_err(|_| Error::Conflict)?;
        resume_controlled(&services, request, &control)
    })
}

fn resume_controlled(
    services: &Services,
    request: ResumeRequest,
    control: &crate::jobs::JobControl,
) -> Result<Value> {
    validate_id(&request.run_id)?;
    crate::collaboration_access::require_execution(services, "run", &request.run_id)?;
    let mut state = checkpoint::load(&services.db, &request.run_id)?;
    validate_id(&request.interaction_id)?;
    if state
        .interaction
        .as_ref()
        .and_then(|interaction| interaction["id"].as_str())
        != Some(request.interaction_id.as_str())
    {
        return Err(Error::Conflict);
    }
    super::continuation_stack::respond(&mut state, request.input)?;
    checkpoint::claim(
        &services.db,
        &request.run_id,
        &state,
        &request.interaction_id,
    )?;
    let scoped = state
        .revisions
        .as_ref()
        .map(|map| services.with_revisions(map.clone()))
        .unwrap_or_else(|| services.clone());
    drive(&scoped, &request.run_id, state, control)
}

pub(super) fn validate_response(action: &NodeAction, input: &Value) -> Result<()> {
    let NodeAction::Input {
        fields, choices, ..
    } = action
    else {
        return Err(Error::Workflow);
    };
    super::inputs::validate_input(fields, input)?;
    if input.to_string().len() > 1024 * 1024 {
        return Err(Error::Limit);
    }
    if !choices.is_empty()
        && !input
            .get("answer")
            .and_then(Value::as_str)
            .is_some_and(|answer| choices.iter().any(|choice| choice == answer))
    {
        return Err(Error::Invalid);
    }
    Ok(())
}

pub(super) fn drive(
    services: &Services,
    id: &str,
    mut state: Checkpoint,
    control: &crate::jobs::JobControl,
) -> Result<Value> {
    let mut context = RuntimeContext::new(services, state.published);
    context.control = control.clone();
    loop {
        let result = super::continuation_stack::advance(&context, &mut state);
        match result {
            Ok(super::continuation_stack::Advance::Paused) => {
                checkpoint::store(&services.db, id, &state, "paused")?;
                return Ok(response(id, "paused", &state, None));
            }
            Ok(super::continuation_stack::Advance::Progress(trace)) => {
                checkpoint::store(&services.db, id, &state, "running")?;
                if let Some(trace) = trace {
                    if let Err(error) =
                        control.emit(json!({"type":"node","runId":id,"trace":trace}))
                    {
                        return finish(services, id, &state, Some(error));
                    }
                }
            }
            Ok(super::continuation_stack::Advance::Complete(signal)) => {
                let error = (state.output.is_none() || signal != super::loops::Signal::Completed)
                    .then_some(Error::Workflow);
                return finish(services, id, &state, error);
            }
            Err(error) => return finish(services, id, &state, Some(error)),
        }
    }
}

pub(super) fn step(
    context: &RuntimeContext<'_>,
    node: &super::Node,
    state: &mut Checkpoint,
) -> Result<bool> {
    if Instant::now() > context.deadline {
        return Err(Error::Limit);
    }
    if let NodeAction::Input {
        prompt,
        fields,
        choices,
    } = &node.action
    {
        state.interaction = Some(
            json!({"id":uuid::Uuid::new_v4().to_string(),"nodeId":node.id,"prompt":render(prompt,&state.values)?,
            "fields":fields,"choices":choices}),
        );
        return Ok(true);
    }
    let started = Instant::now();
    match super::engine::evaluate(context, node, &mut state.values) {
        Ok(value) => state.complete(node, value, started.elapsed().as_millis())?,
        Err(error) => {
            state
                .trace
                .push(json!({"nodeId":node.id,"name":node.name,"status":"failed",
                "error":error.to_string(),"durationMs":started.elapsed().as_millis()}));
            return Err(error);
        }
    }
    Ok(false)
}

fn finish(
    services: &Services,
    id: &str,
    state: &Checkpoint,
    error: Option<Error>,
) -> Result<Value> {
    let status = if matches!(error, Some(Error::Cancelled)) {
        "cancelled"
    } else if error.is_some() {
        "failed"
    } else {
        "completed"
    };
    let error = error.map(|error| error.to_string());
    services.db.connect()?.execute(
        "UPDATE runs SET status=?1,output=?2,trace=?3,error=?4,
        finished_at=?5 WHERE id=?6",
        params![
            status,
            state.output.as_ref().map(Value::to_string),
            json!(state.trace).to_string(),
            error,
            now(),
            id
        ],
    )?;
    Ok(response(id, status, state, error))
}

fn response(id: &str, status: &str, state: &Checkpoint, error: Option<String>) -> Value {
    json!({"id":id,"status":status,"output":state.output,"trace":state.trace,
        "error":error,"interaction":state.interaction})
}
