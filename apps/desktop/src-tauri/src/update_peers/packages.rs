//! Blocking-worker adapter for GUI dependencies, using the existing peer transport and cache.
use super::{cache::Artifact, dependency, parallel, Error, Result, Service, TRANSFER_LIFETIME};
use std::{path::Path, sync::Arc};
use tauri::{AppHandle, Manager};

/// Metadata must come from the upstream release API or a digest pinned in the application.
pub(crate) struct Package(Artifact);

impl Package {
    pub(crate) fn codex(version: &str, url: &str, digest: &str, size: u64) -> Option<Self> {
        if size == 0 || size > super::MAX_PACKAGE_BYTES as u64 {
            return None;
        }
        let mut artifact = Artifact::dependency(
            dependency::CODEX,
            version,
            url,
            digest.strip_prefix("sha256:")?,
        )
        .ok()?;
        artifact.size = size as usize;
        Some(Self(artifact))
    }

    pub(crate) fn computer_use(version: &str, url: &str, digest: &str) -> Option<Self> {
        Artifact::dependency(dependency::COMPUTER_USE, version, url, digest)
            .ok()
            .map(Self)
    }

    /// Call only from a blocking installation worker. Missing/failed sharing falls back to origin.
    pub(crate) fn read_shared(
        &self,
        app: &AppHandle,
        progress: impl FnMut(usize, Option<u64>),
    ) -> Option<Arc<Vec<u8>>> {
        let service = app.try_state::<Arc<Service>>()?;
        tauri::async_runtime::block_on(shared(&service, &self.0, progress)).ok()
    }

    /// Cache failures never turn a verified upstream download into an installation failure.
    pub(crate) fn remember(&self, app: &AppHandle, bytes: Arc<Vec<u8>>) {
        let Some(service) = app.try_state::<Arc<Service>>() else {
            return;
        };
        if let Err(error) =
            tauri::async_runtime::block_on(service.cache.save(self.0.clone(), bytes))
        {
            eprintln!("could not cache the verified GUI dependency: {error}");
        }
    }

    pub(crate) fn remember_file(&self, app: &AppHandle, path: &Path) {
        // This is a generated installer staging path, never a path supplied by another computer.
        let bytes = std::fs::metadata(path).and_then(|metadata| {
            if metadata.len() != self.0.size as u64 {
                return Err(std::io::Error::other("dependency size changed"));
            }
            std::fs::read(path)
        });
        match bytes {
            Ok(bytes) => self.remember(app, Arc::new(bytes)),
            Err(error) => {
                eprintln!("could not read the verified GUI dependency for sharing: {error}")
            }
        }
    }
}

async fn shared(
    service: &Arc<Service>,
    artifact: &Artifact,
    mut progress: impl FnMut(usize, Option<u64>),
) -> Result<Arc<Vec<u8>>> {
    if let Ok(bytes) = service.cache.read(&artifact.id).await {
        let bytes = verify(service, artifact, bytes).await?;
        progress(bytes.len(), Some(bytes.len() as u64));
        eprintln!("GUI dependency download source: cache");
        return Ok(bytes);
    }
    // A busy update download must not delay GUI setup; its caller can use the original URL.
    let _permit = service
        .downloads
        .try_acquire()
        .map_err(|_| Error::Unavailable)?;
    let bytes = download_peer(service, artifact, progress).await?;
    eprintln!("GUI dependency download source: peer");
    if let Err(error) = service.cache.save(artifact.clone(), bytes.clone()).await {
        eprintln!("could not cache the verified GUI dependency: {error}");
    }
    Ok(bytes)
}

pub(super) async fn download_peer(
    service: &Arc<Service>,
    artifact: &Artifact,
    progress: impl FnMut(usize, Option<u64>),
) -> Result<Arc<Vec<u8>>> {
    if !service.policy.allows_download() {
        return Err(Error::Unavailable);
    }
    let scope = service.policy.preferences().scope;
    let leases = match service.find_peers(&artifact.id).await {
        Ok(leases) => leases,
        Err(_) if service.cache.has_partial(&artifact.id).await => Vec::new(),
        Err(error) => return Err(error),
    };
    let transfer = async {
        if leases.iter().all(|lease| lease.protocol >= 2) {
            super::block_download::download(&leases, artifact, service, progress).await
        } else {
            parallel::download(&leases, &artifact.id, progress).await
        }
    };
    let bytes = tokio::time::timeout(TRANSFER_LIFETIME, async {
        tokio::select! {
            result = transfer => result,
            _ = service.policy.scope_changed(scope) => Err(Error::Unavailable),
        }
    })
    .await
    .map_err(|_| Error::Unavailable)??;
    match verify(service, artifact, bytes).await {
        Ok(bytes) => Ok(bytes),
        Err(error) => {
            for lease in &leases {
                lease.failed();
            }
            Err(error)
        }
    }
}

async fn verify(service: &Service, artifact: &Artifact, bytes: Vec<u8>) -> Result<Arc<Vec<u8>>> {
    let artifact = artifact.clone();
    let key = service.cache.key.clone();
    tokio::task::spawn_blocking(move || {
        artifact.verify(&bytes, &key)?;
        Ok(Arc::new(bytes))
    })
    .await
    .map_err(|_| Error::Unavailable)?
}

#[cfg(test)]
#[path = "packages_tests.rs"]
mod tests;
