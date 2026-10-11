use super::*;
use crate::update_peers::{cache::Cache, signaling::Request};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, watch, Semaphore};

const CODEX_URL: &str = concat!(
    "https://github.com/openai/codex/releases/download/rust-v1.0.0/",
    "codex-package-x86_64-pc-windows-msvc.tar.gz"
);
const DRIVER_URL: &str = concat!(
    "https://github.com/trycua/cua/releases/download/cua-driver-rs-v1.0.0/",
    "cua-driver-rs-1.0.0-windows-x86_64.zip"
);
const BYTES: &[u8] = b"verified dependency";

fn package() -> Package {
    Package::codex(
        "1.0.0",
        CODEX_URL,
        &format!("sha256:{:x}", Sha256::digest(BYTES)),
        BYTES.len() as u64,
    )
    .unwrap()
}

fn service(path: &Path) -> Arc<Service> {
    Arc::new(Service {
        cache: Arc::new(Cache::new(path.into(), String::new())),
        broker: watch::channel(None).0,
        uploads: Arc::new(Semaphore::new(2)),
        downloads: Semaphore::new(1),
        policy: super::super::policy::Policy::testing(),
    })
}

#[test]
fn dependencies_require_trusted_urls_digests_versions_and_sizes() {
    let digest = format!("sha256:{:x}", Sha256::digest(BYTES));
    for url in [
        CODEX_URL.replace("openai", "other"),
        format!("{CODEX_URL}?token=secret"),
        CODEX_URL.replace("https:", "http:"),
        CODEX_URL.replace("github.com", "github.com.evil.test"),
    ] {
        assert!(Package::codex("1.0.0", &url, &digest, BYTES.len() as u64).is_none());
    }
    assert!(Package::codex("2.0.0", CODEX_URL, &digest, 1).is_none());
    assert!(Package::codex("1.0.0", CODEX_URL, "sha256:invalid", 1).is_none());
    assert!(Package::codex("1.0.0", CODEX_URL, &digest, 0).is_none());
    assert!(Package::codex(
        "1.0.0",
        CODEX_URL,
        &digest,
        super::super::MAX_PACKAGE_BYTES as u64 + 1
    )
    .is_none());
    let cli = package();
    cli.0.verify(BYTES, "").unwrap();
    assert!(cli.0.verify(b"untrusted dependency", "").is_err());
    let mut wrong_size = cli.0.clone();
    wrong_size.size += 1;
    assert!(wrong_size.verify(BYTES, "").is_err());
    let driver =
        Package::computer_use("1.0.0", DRIVER_URL, &format!("{:x}", Sha256::digest(BYTES)))
            .unwrap();
    driver.0.verify(BYTES, "").unwrap();
    assert_ne!(driver.0.id, cli.0.id);
    assert!(Package::computer_use("1.0.0", CODEX_URL, &"a".repeat(64)).is_none());
    assert!(Package::computer_use("2.0.0", DRIVER_URL, &"a".repeat(64)).is_none());
}

#[tokio::test]
async fn dependencies_reuse_restart_cache_and_reject_corruption_or_size_changes() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path());
    let package = package();
    service
        .cache
        .save(package.0.clone(), Arc::new(BYTES.to_vec()))
        .await
        .unwrap();
    service.cache.restore().await.unwrap();
    let mut downloaded = 0;
    assert_eq!(
        shared(&service, &package.0, |length, _| downloaded += length)
            .await
            .unwrap()
            .as_slice(),
        BYTES
    );
    assert_eq!(downloaded, BYTES.len());
    let mut wrong_size = package.0.clone();
    wrong_size.size += 1;
    assert!(shared(&service, &wrong_size, |_, _| {}).await.is_err());
    std::fs::write(
        root.path().join(format!("{}.pkg", package.0.id)),
        b"corrupted",
    )
    .unwrap();
    assert!(shared(&service, &package.0, |_, _| {}).await.is_err());
    assert!(service.cache.artifacts().is_empty());
}

#[tokio::test]
async fn unavailable_or_busy_sharing_leaves_origin_download_available() {
    let root = tempfile::tempdir().unwrap();
    let service = service(root.path());
    let package = package();
    assert!(shared(&service, &package.0, |_, _| {}).await.is_err());
    let (sender, mut receiver) = mpsc::channel(2);
    service.broker.send_replace(Some(sender));
    let permit = service.downloads.acquire().await.unwrap();
    assert!(shared(&service, &package.0, |_, _| {}).await.is_err());
    assert!(receiver.try_recv().is_err());
    drop(permit);
    let lookup = tokio::spawn(async move {
        let Some(Request::Find { reply, .. }) = receiver.recv().await else {
            panic!("expected lookup")
        };
        assert!(reply.send(Err(Error::Unavailable)).is_ok());
    });
    assert!(shared(&service, &package.0, |_, _| {}).await.is_err());
    lookup.await.unwrap();
}

#[path = "packages_peer_tests.rs"]
mod peer;
