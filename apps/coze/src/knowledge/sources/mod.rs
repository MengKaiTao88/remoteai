//! Source-aware web and visual document ingestion, with atomic refresh of indexed content.
mod fetch;
mod media;
pub(super) mod storage;
mod web;

pub(in crate::knowledge) use media::import_media_controlled;
pub use media::{import_media, ImportMediaDocument};
pub use storage::{document_source, list_sources, SourceInfo, SCHEMA};
pub use web::{import_web, refresh_web, ImportWebDocument};
pub(in crate::knowledge) use web::{import_web_controlled, refresh_web_controlled};

#[cfg(test)]
mod tests;
