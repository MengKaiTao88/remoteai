use super::{Error, Result, Service};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::State;
use tokio::sync::{watch, Mutex};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SharingScope {
    Off,
    #[default]
    Own,
    Everyone,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Preferences {
    pub scope: SharingScope,
    pub upload_kib_per_second: u32,
    pub unmetered_only: bool,
    pub prepare_android: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            scope: SharingScope::Own,
            upload_kib_per_second: 1024,
            unmetered_only: true,
            prepare_android: false,
        }
    }
}

impl Preferences {
    fn validate(&self) -> Result<()> {
        if !(64..=8192).contains(&self.upload_kib_per_second) {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct Metrics {
    pub peer_bytes: AtomicU64,
    pub origin_bytes: AtomicU64,
    pub uploaded_bytes: AtomicU64,
    pub retries: AtomicU64,
    pub failures: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    preferences: Preferences,
    network_allowed: bool,
    peer_bytes: u64,
    origin_bytes: u64,
    uploaded_bytes: u64,
    retries: u64,
    failures: u64,
}

pub(super) struct Policy {
    path: PathBuf,
    settings: watch::Sender<Preferences>,
    unmetered: AtomicBool,
    initialized: AtomicBool,
    next_upload: Mutex<tokio::time::Instant>,
    save: Mutex<()>,
    pub metrics: Metrics,
}

impl Policy {
    pub fn new(path: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            path,
            settings: watch::channel(Preferences::default()).0,
            unmetered: AtomicBool::new(false),
            initialized: AtomicBool::new(false),
            next_upload: Mutex::new(tokio::time::Instant::now()),
            save: Mutex::new(()),
            metrics: Metrics::default(),
        })
    }

    pub fn preferences(&self) -> Preferences {
        self.settings.borrow().clone()
    }

    pub fn allows_network(&self) -> bool {
        !self.preferences().unmetered_only || self.unmetered.load(Ordering::Relaxed)
    }

    pub fn allows_upload(&self) -> bool {
        self.allows_download() && self.allows_network()
    }

    pub fn allows_download(&self) -> bool {
        self.initialized.load(Ordering::Acquire) && self.preferences().scope != SharingScope::Off
    }

    /// Transfers observe scope changes independently of the signaling connection.
    pub async fn scope_changed(&self, initial: SharingScope) {
        let mut settings = self.settings.subscribe();
        while settings.borrow_and_update().scope == initial {
            if settings.changed().await.is_err() {
                return;
            }
        }
    }

    pub async fn throttle(&self, bytes: usize) -> Result<()> {
        if !self.allows_upload() {
            return Err(Error::Unavailable);
        }
        let limit = self.preferences().upload_kib_per_second as f64 * 1024.0;
        let until = {
            let mut next = self.next_upload.lock().await;
            *next = (*next).max(tokio::time::Instant::now())
                + Duration::from_secs_f64(bytes as f64 / limit);
            *next
        };
        tokio::time::sleep_until(until).await;
        if !self.allows_upload() {
            return Err(Error::Unavailable);
        }
        self.metrics
            .uploaded_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
        Ok(())
    }

    pub async fn run(self: Arc<Self>) {
        let guard = self.save.lock().await;
        let path = self.path.clone();
        if let Ok(Some(settings)) = tokio::task::spawn_blocking(move || {
            let settings: Preferences = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
            settings.validate().ok()?;
            Some(settings)
        })
        .await
        {
            self.settings.send_replace(settings);
        }
        self.initialized.store(true, Ordering::Release);
        drop(guard);
        loop {
            let allowed = tokio::task::spawn_blocking(super::network_cost::unmetered)
                .await
                .unwrap_or(false);
            self.unmetered.store(allowed, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    fn status(&self) -> Status {
        let read = |value: &AtomicU64| value.load(Ordering::Relaxed);
        Status {
            preferences: self.preferences(),
            network_allowed: self.allows_network(),
            peer_bytes: read(&self.metrics.peer_bytes),
            origin_bytes: read(&self.metrics.origin_bytes),
            uploaded_bytes: read(&self.metrics.uploaded_bytes),
            retries: read(&self.metrics.retries),
            failures: read(&self.metrics.failures),
        }
    }

    async fn update(&self, settings: Preferences) -> Result<Status> {
        settings.validate()?;
        let _guard = self.save.lock().await;
        let path = self.path.clone();
        let bytes = serde_json::to_vec(&settings).map_err(|_| Error::Invalid)?;
        tokio::task::spawn_blocking(move || {
            use std::io::Write;
            let parent = path.parent().ok_or(Error::Invalid)?;
            std::fs::create_dir_all(parent)?;
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            file.write_all(&bytes)?;
            file.as_file().sync_all()?;
            file.persist(path).map_err(|error| error.error)?;
            Ok::<_, Error>(())
        })
        .await
        .map_err(|_| Error::Unavailable)??;
        self.settings.send_replace(settings);
        Ok(self.status())
    }

    #[cfg(test)]
    pub fn testing() -> Arc<Self> {
        let policy = Self::new(PathBuf::new());
        policy.unmetered.store(true, Ordering::Relaxed);
        policy.initialized.store(true, Ordering::Release);
        policy.settings.send_modify(|value| {
            value.scope = SharingScope::Everyone;
        });
        policy
    }
}

#[tauri::command]
pub(crate) async fn update_sharing_status(
    service: State<'_, Arc<Service>>,
) -> std::result::Result<Status, String> {
    Ok(service.policy.status())
}

#[tauri::command]
pub(crate) async fn set_update_sharing_preferences(
    webview: tauri::Webview,
    settings: Preferences,
    service: State<'_, Arc<Service>>,
) -> std::result::Result<Status, String> {
    if webview.label() != "main" {
        return Err("Sharing settings are unavailable".into());
    }
    service
        .policy
        .update(settings)
        .await
        .map_err(|_| "Could not save sharing settings".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn persists_scope_and_rejects_invalid_limits_without_changing_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sharing.json");
        let policy = Policy::new(path.clone());
        assert!(!policy.allows_upload());
        let settings = Preferences {
            scope: SharingScope::Off,
            ..Preferences::default()
        };
        policy.update(settings).await.unwrap();
        let stored: Preferences = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(stored.scope, SharingScope::Off);
        let invalid = Preferences {
            upload_kib_per_second: 0,
            ..Preferences::default()
        };
        assert!(policy.update(invalid).await.is_err());
        assert_eq!(policy.preferences().scope, SharingScope::Off);
    }

    #[tokio::test]
    async fn disabling_uploads_interrupts_a_waiting_transfer() {
        let policy = Policy::testing();
        let worker = policy.clone();
        let pending = tokio::spawn(async move { worker.throttle(64 * 1024).await });
        tokio::task::yield_now().await;
        policy
            .settings
            .send_modify(|settings| settings.scope = SharingScope::Off);
        assert!(pending.await.unwrap().is_err());
        assert!(!policy.allows_download());
    }

    #[tokio::test]
    async fn scope_changes_interrupt_transfers_without_a_signaling_connection() {
        let policy = Policy::testing();
        let worker = policy.clone();
        let pending =
            tokio::spawn(async move { worker.scope_changed(SharingScope::Everyone).await });
        policy
            .settings
            .send_modify(|settings| settings.scope = SharingScope::Own);
        tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap();
    }
}
