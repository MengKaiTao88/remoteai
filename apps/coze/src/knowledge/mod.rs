//! Document parsing, transactional indexing and hybrid retrieval adapted from Coze knowledge services.
mod chunk;
mod documents;
mod parse;
mod search;

pub use chunk::{split, ChunkOptions};
pub use documents::{
    delete_document, import_document, list_documents, read_chunks, update_chunk, ChunkUpdate,
    ImportDocument,
};
pub use search::{search, SearchRequest};

#[cfg(test)]
mod tests;
