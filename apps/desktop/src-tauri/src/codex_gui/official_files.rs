//! Official chat metadata resolves file locations; the existing host transport owns file handles.
use super::{
    downloads,
    error::{GuiError, Result},
    file_stream::FileStreams,
    protocol::{GuiRequest, GuiResponse},
};
use std::{future::Future, path::PathBuf, sync::Arc};

pub(super) async fn request<F, Fut>(
    streams: Arc<FileStreams>,
    request: GuiRequest,
    forward: F,
) -> Result<GuiResponse>
where
    F: Fn(GuiRequest) -> Fut,
    Fut: Future<Output = Result<GuiResponse>>,
{
    match request {
        GuiRequest::DownloadOpen(options) if options.git_commit.is_some() => {
            downloads::open_git_patch(streams, options).await
        }
        GuiRequest::DownloadOpen(options) => {
            let root = if options.needs_root() {
                downloads::project_root(&options.location, |id| read_cwd(id, &forward)).await?
            } else {
                None
            };
            downloads::open_at_root(streams, options, root).await
        }
        GuiRequest::DownloadBrowse(options) => {
            let root =
                downloads::project_root(&options.location, |id| read_cwd(id, &forward)).await?;
            downloads::browse_at_root(root, options).await
        }
        GuiRequest::FileOpen(options) => {
            let root = read_cwd(options.thread_id.clone(), &forward).await?;
            tauri::async_runtime::spawn_blocking(move || streams.insert_response(root, options))
                .await
                .map_err(|_| GuiError::FileRead)?
        }
        GuiRequest::FileRead(options) => streams.read(options).await,
        GuiRequest::FileClose(options) => streams.close(options).await,
        GuiRequest::FileManifest(options) => streams.manifest(options).await,
        request => forward(request).await,
    }
}

async fn read_cwd<F, Fut>(id: String, forward: &F) -> Result<PathBuf>
where
    F: Fn(GuiRequest) -> Fut,
    Fut: Future<Output = Result<GuiResponse>>,
{
    uuid::Uuid::parse_str(&id).map_err(|_| GuiError::InvalidRequest)?;
    let response = forward(GuiRequest::Read {
        thread_id: id,
        window: None,
        include_tool_details: false,
    })
    .await?;
    response.data["thread"]["cwd"]
        .as_str()
        .filter(|cwd| !cwd.is_empty())
        .map(PathBuf::from)
        .ok_or(GuiError::ProjectFiles)
}

#[cfg(test)]
#[path = "official_files_tests.rs"]
mod tests;
