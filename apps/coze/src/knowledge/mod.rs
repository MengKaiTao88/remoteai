//! Document parsing, transactional indexing and hybrid retrieval adapted from Coze knowledge services.
mod chunk;
mod documents;
mod jobs;
mod parse;
mod search;
pub mod sources;

pub use chunk::{split, ChunkOptions};
pub use documents::import_controlled as import_document_controlled;
pub use documents::{
    delete_document, import_document, list_documents, read_chunks, update_chunk, ChunkUpdate,
    ImportDocument,
};
pub use jobs::{start_import, ImportTask};
pub use search::{search, SearchRequest};

#[cfg(test)]
mod cancellation_tests;
#[cfg(test)]
mod tests;
