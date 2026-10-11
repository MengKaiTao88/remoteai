use super::{
    can_edit, can_run, editable_resource, permission::Output, references, require_execution,
    resource, storage, Permit,
};
use crate::{
    api::{Command, Services},
    error::{Error, Result},
    resources,
};
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::collections::HashSet;

pub fn authorize(services: &Services, command: &Command) -> Result<Permit> {
    if services.principal.is_owner() {
        return Ok(Permit::default());
    }
    storage::ensure_active(services)?;
    if matches!(&services.principal, super::Principal::Shared(grant) if grant.role == super::Role::Tool)
    {
        return Err(Error::Unauthorized);
    }
    let output = match command {
        Command::ListResources => Output::Resources,
        Command::Models | Command::AccessInfo => Output::Plain,
        Command::GetResource { id } => {
            resource(services, id)?;
            Output::Resource
        }
        Command::ListDocuments { id }
        | Command::ListDocumentSources { id }
        | Command::TableRows { id }
        | Command::TableRowsPage { id, .. }
        | Command::TableSchema { id } => {
            resource(services, id)?;
            Output::Plain
        }
        Command::ReadChunks { id } | Command::DocumentSource { id } => {
            document(services, id)?;
            Output::Plain
        }
        Command::Search(input) => {
            all_resources(services, &input.knowledge_ids)?;
            Output::Plain
        }
        Command::Runs { id } => {
            resource(services, id)?;
            Output::History("run")
        }
        Command::Conversations { id } => {
            resource(services, id)?;
            Output::History("conversation")
        }
        Command::Messages { id } => {
            require_execution(services, "conversation", id)?;
            Output::Plain
        }
        Command::JobStatus { id, .. } => {
            require_execution(services, "job", id)?;
            Output::JobStatus
        }
        Command::JobCancel { id } => {
            require_execution(services, "job", id)?;
            Output::Plain
        }
        Command::Run(input) | Command::RunStart(input) => {
            executable(services, &input.resource_id, input.published)?;
            if matches!(command, Command::RunStart(_)) {
                Output::Job
            } else {
                Output::Execution
            }
        }
        Command::Chat(input) | Command::ChatStart(input) => {
            executable(services, &input.agent_id, input.published)?;
            conversation(services, input.conversation_id.as_deref())?;
            if matches!(command, Command::ChatStart(_)) {
                Output::Job
            } else {
                Output::Execution
            }
        }
        Command::RunApp(input) => {
            executable(services, &input.app_id, input.published)?;
            conversation(services, input.conversation_id.as_deref())?;
            Output::Execution
        }
        Command::ResumeRun(input) | Command::ResumeRunStart(input) => {
            can_run(services, true)?;
            require_execution(services, "run", &input.run_id)?;
            if matches!(command, Command::ResumeRunStart(_)) {
                Output::Job
            } else {
                Output::Execution
            }
        }
        command => edit_command(services, command)?,
    };
    Ok(Permit::new(output))
}

fn edit_command(services: &Services, command: &Command) -> Result<Output> {
    can_edit(services)?;
    match command {
        Command::SaveResource(input) => {
            editable_resource(services, input.id.as_deref().ok_or(Error::Unauthorized)?)?;
            references(services, &input.draft)?;
        }
        Command::ImportWorkflow { .. } => {}
        Command::ImportDocument(input) | Command::ImportDocumentStart(input) => {
            resource(services, &input.knowledge_id)?
        }
        Command::ImportWebDocument(input) | Command::ImportWebDocumentStart(input) => {
            resource(services, &input.knowledge_id)?
        }
        Command::ImportMediaDocument(input) | Command::ImportMediaDocumentStart(input) => {
            resource(services, &input.knowledge_id)?
        }
        Command::DeleteDocument { id }
        | Command::RefreshWebDocument { id }
        | Command::RefreshWebDocumentStart { id } => document(services, id)?,
        Command::UpdateChunk(input) => {
            let doc: Option<String> = services
                .db
                .connect()?
                .query_row(
                    "SELECT document_id FROM chunks WHERE id=?1",
                    [&input.id],
                    |row| row.get(0),
                )
                .optional()?;
            document(services, &doc.ok_or(Error::Unauthorized)?)?;
        }
        Command::SaveTableSchema(input) => resource(services, &input.table_id)?,
        Command::SaveTableRow { table_id, .. } | Command::DeleteTableRow { table_id, .. } => {
            resource(services, table_id)?
        }
        Command::TableSql(input) => all_resources(services, &input.tables)?,
        Command::GenerateTableSql(input) => all_resources(services, &input.tables)?,
        Command::Tool { id, .. } => executable(services, id, false)?,
        // Capabilities never grant publishing, application membership, backups or token management.
        _ => return Err(Error::Unauthorized),
    }
    Ok(
        if matches!(
            command,
            Command::ImportDocumentStart(_)
                | Command::ImportWebDocumentStart(_)
                | Command::ImportMediaDocumentStart(_)
                | Command::RefreshWebDocumentStart { .. }
        ) {
            Output::Job
        } else {
            Output::Plain
        },
    )
}

fn all_resources(services: &Services, ids: &[String]) -> Result<()> {
    for id in ids {
        resource(services, id)?;
    }
    Ok(())
}

fn document(services: &Services, id: &str) -> Result<()> {
    let knowledge: Option<String> = services
        .db
        .connect()?
        .query_row(
            "SELECT knowledge_id FROM documents WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    resource(services, &knowledge.ok_or(Error::Unauthorized)?)
}

fn conversation(services: &Services, id: Option<&str>) -> Result<()> {
    if let Some(id) = id {
        require_execution(services, "conversation", id)?;
    }
    Ok(())
}

fn executable(services: &Services, id: &str, published: bool) -> Result<()> {
    can_run(services, published)?;
    let mut remaining = vec![id.to_owned()];
    let mut visited = HashSet::new();
    while let Some(id) = remaining.pop() {
        if !visited.insert(id.clone()) {
            continue;
        }
        resource(services, &id)?;
        let body = if published {
            resources::published(&services.db, &id)?.1
        } else {
            resources::get(&services.db, &id)?.draft
        };
        for reference in crate::publications::references(&body)? {
            resource(services, &reference)?;
            remaining.push(reference);
        }
    }
    Ok(())
}

pub fn authorize_mcp(services: &Services, request: &Value) -> Result<Permit> {
    if services.principal.is_owner() {
        return Ok(Permit::default());
    }
    storage::ensure_active(services)?;
    match request["method"].as_str() {
        Some("initialize" | "ping" | "tools/list") => return Ok(Permit::default()),
        Some("tools/call") => {}
        _ => return Err(Error::Unauthorized),
    }
    let arguments = &request["params"]["arguments"];
    let output = match request["params"]["name"].as_str() {
        Some("coze_list") => Output::McpList,
        Some("coze_call") => {
            if matches!(&services.principal, super::Principal::Shared(grant)
                if grant.role == super::Role::Tool && arguments["resource_id"] != grant.app_id)
            {
                return Err(Error::Unauthorized);
            }
            executable(
                services,
                arguments["resource_id"]
                    .as_str()
                    .ok_or(Error::Unauthorized)?,
                true,
            )?;
            conversation(services, arguments["conversation_id"].as_str())?;
            Output::Execution
        }
        Some("coze_resume") => {
            can_run(services, true)?;
            require_execution(
                services,
                "run",
                arguments["run_id"].as_str().ok_or(Error::Unauthorized)?,
            )?;
            Output::Execution
        }
        _ => return Err(Error::Unauthorized),
    };
    Ok(Permit::new(output))
}
