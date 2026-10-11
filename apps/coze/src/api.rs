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
    sync::{Arc, Mutex},
};

pub struct Services {
    pub db: Database,
    pub embedder: Arc<dyn Embedder>,
    pub proxy: ModelProxy,
    in_flight: Mutex<HashSet<String>>,
}

impl Services {
    pub fn new(db: Database, embedder: Arc<dyn Embedder>, proxy: ModelProxy) -> Self {
        Self {
            db,
            embedder,
            proxy,
            in_flight: Mutex::new(HashSet::new()),
        }
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
    let db = &services.db;
    match command {
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
