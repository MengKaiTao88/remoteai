use crate::{
    agents,
    database::Database,
    embedding::Embedder,
    error::{Error, Result},
    knowledge,
    model::*,
    proxy::ModelProxy,
    resources, workflow,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, RwLock},
};

#[derive(Clone)]
pub struct Services {
    pub db: Database,
    pub embedder: Arc<dyn Embedder>,
    pub proxy: ModelProxy,
    pub jobs: crate::jobs::JobManager,
    pub maintenance: Arc<RwLock<()>>,
    pub principal: crate::collaboration_access::Principal,
    in_flight: Arc<Mutex<HashSet<String>>>,
}

impl Services {
    pub fn new(db: Database, embedder: Arc<dyn Embedder>, proxy: ModelProxy) -> Self {
        Self {
            db,
            embedder,
            proxy,
            jobs: crate::jobs::JobManager::default(),
            maintenance: Arc::new(RwLock::new(())),
            principal: crate::collaboration_access::Principal::default(),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn with_revisions(&self, revisions: std::collections::BTreeMap<String, u64>) -> Self {
        Self {
            db: self.db.with_revisions(revisions),
            ..self.clone()
        }
    }

    pub fn for_publication(&self, id: &str) -> Result<Self> {
        if self.db.pinned_revisions().is_some() {
            return Ok(self.clone());
        }
        Ok(self.with_revisions(crate::publications::snapshot(&self.db, id)?))
    }

    pub fn claim(&self, id: &str) -> Result<OperationGuard<'_>> {
        if !self
            .in_flight
            .lock()
            .map_err(|_| Error::Conflict)?
            .insert(id.to_owned())
        {
            return Err(Error::Conflict);
        }
        Ok(OperationGuard {
            services: self,
            id: id.to_owned(),
        })
    }
}

pub struct OperationGuard<'a> {
    services: &'a Services,
    id: String,
}

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut operations) = self.services.in_flight.lock() {
            operations.remove(&self.id);
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Command {
    AccessInfo,
    IssueAccess(crate::collaboration_access::AccessIssue),
    ListAccess {
        id: String,
    },
    RevokeAccess {
        id: String,
    },
    ImportDocumentStart(knowledge::ImportDocument),
    ImportWebDocumentStart(knowledge::sources::ImportWebDocument),
    ImportMediaDocumentStart(knowledge::sources::ImportMediaDocument),
    RefreshWebDocumentStart {
        id: String,
    },
    ImportTableRows(crate::tables::ImportRowsRequest),
    TableRowsPage {
        id: String,
        offset: u64,
        limit: u64,
    },
    ListTemplates,
    SaveTemplate(crate::catalog::Bundle),
    ExportTemplate {
        id: String,
    },
    GetTemplate {
        id: String,
    },
    InstallTemplate {
        id: String,
    },
    DeleteTemplate {
        id: String,
    },
    ImportWebDocument(knowledge::sources::ImportWebDocument),
    ImportMediaDocument(knowledge::sources::ImportMediaDocument),
    RefreshWebDocument {
        id: String,
    },
    ListDocumentSources {
        id: String,
    },
    DocumentSource {
        id: String,
    },
    TableSchema {
        id: String,
    },
    SaveTableSchema(crate::tables::SchemaInput),
    TableSql(crate::tables::SqlRequest),
    GenerateTableSql(crate::tables::GenerateSqlRequest),
    RunApp(crate::projects::AppRun),
    Releases {
        id: String,
    },
    ActivateRelease {
        id: String,
        revision: u64,
        expected: u64,
    },
    ResumeRun(workflow::ResumeRequest),
    RunStart(workflow::RunRequest),
    ResumeRunStart(workflow::ResumeRequest),
    ImportWorkflow {
        canvas: Value,
    },
    ChatStart(agents::ChatRequest),
    JobStatus {
        id: String,
        after: u64,
    },
    JobCancel {
        id: String,
    },
    UpdateChunk(knowledge::ChunkUpdate),
    Tool {
        id: String,
        input: Value,
    },
    ListResources,
    SaveResource(ResourceInput),
    GetResource {
        id: String,
    },
    DeleteResource {
        id: String,
        revision: u64,
    },
    Publish {
        id: String,
        revision: u64,
        enabled: bool,
    },
    Models,
    ImportDocument(knowledge::ImportDocument),
    ListDocuments {
        id: String,
    },
    DeleteDocument {
        id: String,
    },
    ReadChunks {
        id: String,
    },
    Search(knowledge::SearchRequest),
    Run(workflow::RunRequest),
    Runs {
        id: String,
    },
    Chat(agents::ChatRequest),
    Conversations {
        id: String,
    },
    Messages {
        id: String,
    },
    TableRows {
        id: String,
    },
    SaveTableRow {
        table_id: String,
        id: Option<String>,
        value: Value,
    },
    DeleteTableRow {
        table_id: String,
        id: String,
    },
}

pub fn dispatch(services: &Services, command: Command) -> Result<Value> {
    let _lease = services.maintenance.read().map_err(|_| Error::Conflict)?;
    let permit = crate::collaboration_access::authorize(services, &command)?;
    let value = dispatch_inner(services, command)?;
    permit.finish(services, value)
}

fn dispatch_inner(services: &Services, command: Command) -> Result<Value> {
    let db = &services.db;
    match command {
        Command::AccessInfo => Ok(services.principal.info()),
        Command::IssueAccess(input) => crate::collaboration_access::issue(db, input),
        Command::ListAccess { id } => crate::collaboration_access::list(db, &id),
        Command::RevokeAccess { id } => crate::collaboration_access::revoke(services, &id),
        Command::ImportDocumentStart(input) => {
            knowledge::start_import(services, knowledge::ImportTask::File(input))
        }
        Command::ImportWebDocumentStart(input) => {
            knowledge::start_import(services, knowledge::ImportTask::Web(input))
        }
        Command::ImportMediaDocumentStart(input) => {
            knowledge::start_import(services, knowledge::ImportTask::Media(input))
        }
        Command::RefreshWebDocumentStart { id } => {
            knowledge::start_import(services, knowledge::ImportTask::RefreshWeb { id })
        }
        Command::ImportTableRows(input) => crate::tables::import_rows(db, input),
        Command::TableRowsPage { id, offset, limit } => {
            crate::tables::list_page(db, &id, offset, limit)
        }
        Command::ListTemplates => crate::catalog::list(db),
        Command::SaveTemplate(bundle) => crate::catalog::save(db, bundle),
        Command::ExportTemplate { id } => Ok(json!(crate::catalog::export(db, &id)?)),
        Command::GetTemplate { id } => Ok(json!(crate::catalog::get(db, &id)?)),
        Command::InstallTemplate { id } => crate::catalog::install(db, &id),
        Command::DeleteTemplate { id } => {
            crate::catalog::delete(db, &id)?;
            Ok(json!({}))
        }
        Command::ImportWebDocument(input) => {
            let _guard = services.claim(&input.knowledge_id)?;
            Ok(json!(knowledge::sources::import_web(
                db,
                services.embedder.as_ref(),
                input
            )?))
        }
        Command::ImportMediaDocument(input) => {
            let _guard = services.claim(&input.knowledge_id)?;
            Ok(json!(knowledge::sources::import_media(
                db,
                services.embedder.as_ref(),
                &services.proxy,
                input
            )?))
        }
        Command::RefreshWebDocument { id } => {
            let _guard = services.claim(&id)?;
            Ok(json!(knowledge::sources::refresh_web(
                db,
                services.embedder.as_ref(),
                &id
            )?))
        }
        Command::ListDocumentSources { id } => {
            Ok(json!(knowledge::sources::list_sources(db, &id)?))
        }
        Command::DocumentSource { id } => Ok(json!(knowledge::sources::document_source(db, &id)?)),
        Command::TableSchema { id } => Ok(json!(crate::tables::get_schema(db, &id)?)),
        Command::SaveTableSchema(input) => Ok(json!(crate::tables::save_schema(db, input)?)),
        Command::TableSql(input) => crate::tables::run_sql(db, input),
        Command::GenerateTableSql(input) => crate::tables::generate_sql(db, &services.proxy, input),
        Command::RunApp(request) => crate::projects::run(services, request),
        Command::Releases { id } => crate::publications::list(db, &id),
        Command::ActivateRelease {
            id,
            revision,
            expected,
        } => crate::publications::activate(db, &id, revision, expected),
        Command::ResumeRun(request) => workflow::resume(services, request),
        Command::RunStart(request) => workflow::start(services, request),
        Command::ResumeRunStart(request) => workflow::resume_start(services, request),
        Command::ImportWorkflow { canvas } => Ok(json!(workflow::import_canvas(&canvas)?)),
        Command::ChatStart(request) => agents::start(services, request),
        Command::JobStatus { id, after } => services.jobs.status(&id, after),
        Command::JobCancel { id } => services.jobs.cancel(&id),
        Command::UpdateChunk(update) => {
            knowledge::update_chunk(db, services.embedder.as_ref(), update)?;
            Ok(json!({}))
        }
        Command::Tool { id, input } => crate::plugins::invoke(db, &id, input, false),
        Command::ListResources => Ok(json!(resources::list(db)?)),
        Command::GetResource { id } => Ok(json!(resources::get(db, &id)?)),
        Command::SaveResource(input) => Ok(json!(resources::save(db, input)?)),
        Command::DeleteResource { id, revision } => {
            resources::delete(db, &id, revision)?;
            Ok(json!({}))
        }
        Command::Publish {
            id,
            revision,
            enabled,
        } => Ok(json!(resources::publish(db, &id, revision, enabled)?)),
        Command::Models => services.proxy.models(),
        Command::ImportDocument(input) => {
            let _guard = services.claim(&input.knowledge_id)?;
            Ok(json!(knowledge::import_document(
                db,
                services.embedder.as_ref(),
                input
            )?))
        }
        Command::ListDocuments { id } => Ok(json!(knowledge::list_documents(db, &id)?)),
        Command::DeleteDocument { id } => {
            knowledge::delete_document(db, &id)?;
            Ok(json!({}))
        }
        Command::ReadChunks { id } => Ok(json!(knowledge::read_chunks(db, &id)?)),
        Command::Search(request) => Ok(json!(knowledge::search(
            db,
            services.embedder.as_ref(),
            request
        )?)),
        Command::Run(request) => workflow::run(services, request),
        Command::Runs { id } => workflow::list_runs(db, &id),
        Command::Chat(request) => agents::chat(services, request),
        Command::Conversations { id } => agents::conversations(db, &id),
        Command::Messages { id } => Ok(json!(agents::messages(db, &id)?)),
        command => table_command(db, command),
    }
}

fn table_command(db: &Database, command: Command) -> Result<Value> {
    match command {
        Command::TableRows { id } => crate::tables::query(db, &id, &json!({})),
        Command::SaveTableRow {
            table_id,
            id,
            value,
        } => crate::tables::write(db, &table_id, id.as_deref(), value),
        Command::DeleteTableRow { table_id, id } => crate::tables::delete(db, &table_id, &id),
        _ => Err(Error::Invalid),
    }
}
