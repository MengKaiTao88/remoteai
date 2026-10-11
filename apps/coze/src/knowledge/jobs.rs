use super::{documents, sources, ImportDocument};
use crate::{
    api::Services,
    error::{Error, Result},
    jobs::JobControl,
};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

pub enum ImportTask {
    File(ImportDocument),
    Web(sources::ImportWebDocument),
    Media(sources::ImportMediaDocument),
    RefreshWeb { id: String },
}

pub fn start_import(services: &Services, task: ImportTask) -> Result<Value> {
    let worker = services.clone();
    services.jobs.start(move |control| {
        let _lease = worker.maintenance.read().map_err(|_| Error::Conflict)?;
        let knowledge = match &task {
            ImportTask::File(input) => input.knowledge_id.clone(),
            ImportTask::Web(input) => input.knowledge_id.clone(),
            ImportTask::Media(input) => input.knowledge_id.clone(),
            ImportTask::RefreshWeb { id } => worker
                .db
                .connect()?
                .query_row(
                    "SELECT knowledge_id FROM documents WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or(Error::NotFound)?,
        };
        let _guard = worker.claim(&knowledge)?;
        run(&worker, task, &control)
    })
}

fn run(services: &Services, task: ImportTask, control: &JobControl) -> Result<Value> {
    let db = &services.db;
    let embedder = services.embedder.as_ref();
    let document = match task {
        ImportTask::File(input) => documents::import_controlled(db, embedder, input, control)?,
        ImportTask::Web(input) => sources::import_web_controlled(db, embedder, input, control)?,
        ImportTask::Media(input) => sources::import_media_controlled(services, input, control)?,
        ImportTask::RefreshWeb { id } => {
            sources::refresh_web_controlled(db, embedder, &id, control)?
        }
    };
    Ok(json!(document))
}
