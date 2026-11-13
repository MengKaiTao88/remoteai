//! Explicit computer/project browsing for the authenticated remote download manager.
use super::{
    client::Client,
    error::{GuiError, Result},
    file_stream::{FileStreams, StreamOpen},
    platform::{directory_roots, execution_path},
    project_files,
    protocol::{thread_params, GuiResponse},
};
use serde::Deserialize;
use serde_json::json;
use std::{path::PathBuf, sync::Arc};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Scope {
    Project,
    Computer,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Location {
    scope: Scope,
    thread_id: Option<String>,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Browse {
    #[serde(flatten)]
    pub(super) location: Location,
    directory: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Open {
    #[serde(flatten)]
    pub(super) location: Location,
    transfer_id: String,
    path: String,
    max_bytes: u64,
    pub(super) git_commit: Option<String>,
    #[serde(default)]
    prepare: bool,
    preparation_id: Option<String>,
}

impl Open {
    pub(super) fn needs_root(&self) -> bool {
        self.preparation_id.is_none()
    }
}

/// Patch content is generated privately, never written into the source repository.
pub(super) async fn open_git_patch(
    streams: Arc<FileStreams>,
    options: Open,
) -> Result<GuiResponse> {
    uuid::Uuid::parse_str(&options.transfer_id).map_err(|_| GuiError::InvalidRequest)?;
    let hash = options.git_commit.ok_or(GuiError::InvalidRequest)?;
    let cwd = options.location.cwd.ok_or(GuiError::InvalidRequest)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file =
            super::git::tool::patch::create(&cwd, &hash, options.max_bytes).map_err(|error| {
                match error {
                    super::git::GitError::PatchTooLarge => GuiError::FileTooLarge,
                    _ => GuiError::GitPatch,
                }
            })?;
        streams.insert_patch(options.transfer_id, file, format!("{}.patch", &hash[..12]))
    })
    .await
    .map_err(|_| GuiError::GitPatch)?
}

pub(super) async fn project_root<F, Fut>(
    location: &Location,
    read_cwd: F,
) -> Result<Option<PathBuf>>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<PathBuf>>,
{
    if matches!(location.scope, Scope::Computer) {
        return Ok(None);
    }
    if let Some(id) = &location.thread_id {
        return read_cwd(id.clone()).await.map(Some);
    }
    location
        .cwd
        .as_ref()
        .map(|path| Some(PathBuf::from(path)))
        .ok_or(GuiError::ProjectFiles)
}

// Limit computer mode to local volumes; UNC, device paths, streams and relative paths are not accepted.
fn volume_root(path: &str) -> Result<PathBuf> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.len() > 4096
        || normalized.starts_with("//")
        || normalized.chars().any(char::is_control)
    {
        return Err(GuiError::ProjectFiles);
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(GuiError::ProjectFiles);
    }
    let canonical = path.canonicalize().map_err(|_| GuiError::ProjectFiles)?;
    directory_roots()
        .into_iter()
        .filter_map(|root| root.canonicalize().ok())
        .find(|root| canonical.starts_with(root))
        .ok_or(GuiError::ProjectFiles)
}

pub(super) async fn browse(client: &Client, options: Browse) -> Result<GuiResponse> {
    let root = project_root(&options.location, |id| client_root(client, id)).await?;
    browse_at_root(root, options).await
}

async fn client_root(client: &Client, id: String) -> Result<PathBuf> {
    let response = client.request("thread/read", thread_params(id)?).await?;
    response["thread"]["cwd"]
        .as_str()
        .map(PathBuf::from)
        .ok_or(GuiError::ProjectFiles)
}

pub(super) async fn browse_at_root(root: Option<PathBuf>, options: Browse) -> Result<GuiResponse> {
    let data = tauri::async_runtime::spawn_blocking(move || {
        if let Some(root) = root {
            return project_files::browse(&root, &options.directory, false);
        }
        if options.directory.is_empty() {
            let entries: Vec<_> = directory_roots()
                .iter()
                .map(|path| {
                    let path = execution_path(path);
                    json!({ "name": path, "path": path, "directory": true })
                })
                .collect();
            return Ok(
                json!({ "directory": "", "parent": null, "entries": entries, "truncated": false }),
            );
        }
        let root = volume_root(&options.directory)?;
        let mut result = project_files::browse(&root, &options.directory, false)?;
        if result["parent"].is_null() {
            result["parent"] = json!("");
        }
        Ok(result)
    })
    .await
    .map_err(|_| GuiError::ProjectFiles)??;
    Ok(GuiResponse { data })
}

pub(super) async fn open(
    client: &Client,
    streams: Arc<FileStreams>,
    options: Open,
) -> Result<GuiResponse> {
    let root = if options.needs_root() {
        project_root(&options.location, |id| client_root(client, id)).await?
    } else {
        None
    };
    open_at_root(streams, options, root).await
}

pub(super) async fn open_at_root(
    streams: Arc<FileStreams>,
    options: Open,
    root: Option<PathBuf>,
) -> Result<GuiResponse> {
    uuid::Uuid::parse_str(&options.transfer_id).map_err(|_| GuiError::InvalidRequest)?;
    if let Some(id) = options.preparation_id {
        uuid::Uuid::parse_str(&id).map_err(|_| GuiError::InvalidRequest)?;
        return streams.archive_status(options.transfer_id, id).await;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = match root {
            Some(root) => root,
            None => volume_root(&options.path)?,
        };
        super::local_file::validate(&options.path)?;
        if root.join(&options.path).is_dir() {
            let root = root.canonicalize().map_err(|_| GuiError::ProjectFiles)?;
            if options.prepare {
                return streams.prepare_archive(
                    root,
                    StreamOpen {
                        thread_id: options.transfer_id,
                        path: options.path,
                        max_bytes: options.max_bytes,
                    },
                );
            }
            let (file, name) =
                super::project_entries::archive(&root, &options.path, options.max_bytes)
                    .map_err(GuiError::ProjectEntry)?;
            return streams.insert_archive(options.transfer_id, file, name);
        }
        streams.insert_response(
            root,
            StreamOpen {
                thread_id: options.transfer_id,
                path: options.path,
                max_bytes: options.max_bytes,
            },
        )
    })
    .await
    .map_err(|_| GuiError::FileRead)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_nonlocal_and_relative_sources() {
        for path in [
            "",
            "../secret",
            "//server/share",
            r"\\?\C:\",
            "C:/bad\npath",
            "file:///tmp/file",
        ] {
            assert!(volume_root(path).is_err(), "{path}");
        }
        assert!(volume_root(std::env::temp_dir().to_str().unwrap()).is_ok());
    }
}
