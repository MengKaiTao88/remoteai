//! Change the foreground conversation owner without restarting inference or the proxy.
use super::{error::GuiError, GuiState};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering},
        Arc, OnceLock,
    },
};
use tauri::{AppHandle, Manager};
use tokio::sync::{OwnedRwLockReadGuard, RwLock};

static CURRENT: OnceLock<Selection> = OnceLock::new();
const SETTINGS_FILE: &str = "conversation-backend.json";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Backend {
    #[default]
    Gui,
    Official,
}

struct Selection {
    backend: AtomicU8,
    revision: AtomicU64,
}

impl Selection {
    fn new(backend: Backend) -> Self {
        let revision = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(1, |duration| duration.as_millis() as u64);
        Self {
            backend: AtomicU8::new(backend as u8),
            revision: AtomicU64::new(revision),
        }
    }
    fn scope(&self) -> Scope {
        Scope {
            backend: if self.backend.load(Ordering::Acquire) == Backend::Official as u8 {
                Backend::Official
            } else {
                Backend::Gui
            },
            revision: self.revision.load(Ordering::Acquire),
        }
    }
    fn select(&self, backend: Backend) {
        self.backend.store(backend as u8, Ordering::Release);
        self.revision.fetch_add(1, Ordering::AcqRel);
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Scope {
    backend: Backend,
    revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    backend: Backend,
    revision: u64,
    official_available: bool,
}

fn selection() -> &'static Selection {
    CURRENT.get_or_init(|| Selection::new(legacy_default()))
}
pub(crate) fn current() -> Backend {
    selection().scope().backend
}
fn legacy_default() -> Backend {
    if std::env::var_os("REMOTEAI_CODEX_BRIDGE_URL").is_some() {
        Backend::Official
    } else {
        Backend::Gui
    }
}

/// Legacy test processes must not compete with the installed application's proxy.
pub(crate) fn isolated_follower() -> bool {
    std::env::var_os("REMOTEAI_CODEX_BRIDGE_URL").is_some()
        || std::env::var_os("REMOTEAI_PRESERVE_OWNER_CONFIG").is_some()
}

fn read(path: &Path, fallback: Backend) -> Backend {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(fallback)
}

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| GuiError::Startup.to_string())?;
    selection().select(read(&root.join(SETTINGS_FILE), legacy_default()));
    Ok(())
}

fn validate(scope: Scope, selected: &Selection) -> Result<(), String> {
    if scope == selected.scope() {
        Ok(())
    } else {
        Err(GuiError::Disconnected.to_string())
    }
}

/// Reject requests from an old view, including requests queued before a source transition.
pub(super) async fn lease(
    lock: Arc<RwLock<()>>,
    scope: Option<Scope>,
) -> Result<OwnedRwLockReadGuard<()>, String> {
    let scope = scope.unwrap_or_else(|| selection().scope());
    scoped_lease(lock, scope, selection()).await
}

async fn scoped_lease(
    lock: Arc<RwLock<()>>,
    scope: Scope,
    selected: &Selection,
) -> Result<OwnedRwLockReadGuard<()>, String> {
    let guard = lock.read_owned().await;
    validate(scope, selected)?;
    Ok(guard)
}

async fn snapshot(app: AppHandle) -> Result<Snapshot, String> {
    let official_available = tauri::async_runtime::spawn_blocking(move || {
        std::env::var_os("REMOTEAI_CODEX_BRIDGE_URL").is_some()
            || super::gateway_runtime::available(&app)
    })
    .await
    .map_err(|_| GuiError::Startup.to_string())?;
    let scope = selection().scope();
    Ok(Snapshot {
        backend: scope.backend,
        revision: scope.revision,
        official_available,
    })
}

#[tauri::command]
pub(crate) async fn codex_gui_backend(app: AppHandle) -> Result<Snapshot, String> {
    let guard = lease(app.state::<GuiState>().backend_activity.clone(), None).await?;
    let value = snapshot(app).await;
    drop(guard);
    value
}

#[tauri::command]
pub(crate) async fn codex_gui_switch_backend(
    app: AppHandle,
    backend: Backend,
    scope: Option<Scope>,
) -> Result<Snapshot, String> {
    let expected = scope.unwrap_or_else(|| selection().scope());
    let state = app.state::<GuiState>();
    let _switch = state.backend_activity.write().await;
    validate(expected, selection())?;
    if backend == current() {
        return snapshot(app.clone()).await;
    }
    if backend == Backend::Official {
        state
            .official_bridge
            .connect(app.clone())
            .await
            .map_err(|error| error.to_string())?;
    }
    let write_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = write_app
            .path()
            .app_data_dir()
            .map_err(|_| GuiError::Startup.to_string())?;
        crate::storage::write_json_atomic(&root.join(SETTINGS_FILE), &serde_json::json!(backend))
            .map_err(|_| GuiError::Startup.to_string())
    })
    .await
    .map_err(|_| GuiError::Startup.to_string())??;
    selection().select(backend);
    let value = snapshot(app.clone()).await?;
    // Each viewer starts fresh; the existing GUI engine, native owner and proxy stay alive.
    super::web::publish(&app, "codex-gui-backend-changed", &value);
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_modes_preserve_legacy_defaults_and_reject_corrupt_values() {
        let root = std::env::temp_dir().join(format!("remoteai-mode-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(SETTINGS_FILE);
        assert_eq!(read(&path, Backend::Gui), Backend::Gui);
        assert_eq!(read(&path, Backend::Official), Backend::Official);
        std::fs::write(&path, br#""gui""#).unwrap();
        assert_eq!(read(&path, Backend::Official), Backend::Gui);
        std::fs::write(&path, br#""official""#).unwrap();
        assert_eq!(read(&path, Backend::Gui), Backend::Official);
        std::fs::write(&path, br#""unknown""#).unwrap();
        assert_eq!(read(&path, Backend::Gui), Backend::Gui);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn returning_to_the_same_mode_cannot_accept_an_old_views_writes() {
        let selection = Selection::new(Backend::Gui);
        let old = selection.scope();
        selection.select(Backend::Official);
        assert_ne!(selection.scope(), old);
        selection.select(Backend::Gui);
        assert_eq!(selection.scope().backend, old.backend);
        assert_ne!(selection.scope(), old);
    }

    #[tokio::test]
    async fn a_waiting_old_request_cannot_write_into_the_new_source() {
        let selected = Arc::new(Selection::new(Backend::Gui));
        let lock = Arc::new(RwLock::new(()));
        let transition = lock.clone().write_owned().await;
        let old = selected.scope();
        let reader_lock = lock.clone();
        let reader_selection = selected.clone();
        let request = tokio::spawn(async move {
            scoped_lease(reader_lock, old, &reader_selection)
                .await
                .map(|_| ())
        });
        selected.select(Backend::Official);
        drop(transition);
        assert!(request.await.unwrap().is_err());
        assert!(scoped_lease(lock, selected.scope(), &selected)
            .await
            .is_ok());
    }
}
