use super::*;
use crate::update_peers::{
    block_download, block_protocol, signaling::Lease, tests::network_fixture,
};
use csw_chat_connectivity::{Connection, Event};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn origin_ranges_finish_without_waiting_for_an_unresponsive_peer() {
    let bytes = vec![29; 2 * 1024 * 1024 + 7];
    let origin = Origin::with_bytes(bytes.clone());
    let update = origin.update().await;
    let directory = tempfile::tempdir().unwrap();
    let service = service(directory.path(), &origin.key);
    let artifact = Artifact::from_update(&update);
    let coordinator = network_fixture::coordinator("origin-hedge").await;
    let config = network_fixture::client(&coordinator, "missing-seed");
    let (sender, _receiver) = mpsc::channel(16);
    let leases = vec![Lease::binary(config, sender).unwrap()];
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        block_download::download(&leases, &artifact, &service, |_, _| {}),
    )
    .await;
    drop(leases);
    coordinator.stop().await;
    let received = result.unwrap().unwrap();
    artifact.verify(&received, &origin.key).unwrap();
    assert_eq!(received, bytes);
    assert_eq!(
        service.policy.metrics.origin_bytes.load(Ordering::Relaxed),
        bytes.len() as u64
    );
    assert!(origin.downloads.load(Ordering::Relaxed) > 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn disconnected_source_does_not_discard_other_peers_blocks() {
    let bytes = vec![73; 2 * 1024 * 1024 + 17];
    let origin = Origin::with_bytes(bytes.clone());
    let update = origin.update().await;
    let directory = tempfile::tempdir().unwrap();
    let seed_service = service(directory.path(), &origin.key);
    let mut artifact = Artifact::from_update(&update);
    seed_service
        .cache
        .save(artifact.clone(), Arc::new(bytes.clone()))
        .await
        .unwrap();
    let snapshot = seed_service.cache.snapshot(&artifact.id).unwrap();
    let coordinator = network_fixture::coordinator("block-recovery").await;
    let (sender, _receiver) = mpsc::channel(16);
    let mut leases = Vec::new();
    let mut workers = Vec::new();
    let mut seeds = Vec::new();
    let (failed_request, observer) = watch::channel(false);
    for index in 0..2 {
        let mut config = network_fixture::client(&coordinator, &format!("block-recovery-{index}"));
        config.desktop = true;
        let seed = Connection::start_with_packets(config.clone()).unwrap();
        seeds.push(seed.clone());
        let snapshot = snapshot.clone();
        let artifact = artifact.id.clone();
        let policy = seed_service.policy.clone();
        let failed_request = failed_request.clone();
        let mut observer = observer.clone();
        workers.push(tokio::spawn(async move {
            if index == 0 {
                disconnect_after_request(&seed, &snapshot.manifest, failed_request).await;
            } else {
                while !*observer.borrow_and_update() {
                    observer.changed().await.unwrap();
                }
                let _result = block_protocol::seed(&seed, snapshot, &artifact, &policy).await;
            }
        }));
        config.desktop = false;
        leases.push(Lease::binary(config, sender.clone()).unwrap());
    }
    artifact.url = "http://127.0.0.1:9/unavailable".into();
    let result = tokio::time::timeout(
        Duration::from_secs(40),
        block_download::download(&leases, &artifact, &seed_service, |_, _| {}),
    )
    .await;
    for seed in seeds {
        seed.close();
    }
    for worker in workers {
        worker.abort();
    }
    coordinator.stop().await;
    assert_eq!(result.unwrap().unwrap(), bytes);
    assert!(seed_service.policy.metrics.retries.load(Ordering::Relaxed) >= 1);
    assert_eq!(origin.downloads.load(Ordering::Relaxed), 0);
}

async fn disconnect_after_request(
    connection: &Connection,
    manifest: &crate::update_peers::snapshot::Manifest,
    requested: watch::Sender<bool>,
) {
    let mut sent = false;
    while let Some(event) = connection.receive().await {
        let Event::Data { text } = event else {
            continue;
        };
        let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
        if frame["type"] == "read" {
            if sent {
                requested.send_replace(true);
                connection.close();
                return;
            }
            let index = frame["index"].as_u64().unwrap() as usize;
            let length = manifest.length(index).unwrap();
            connection
                .send(
                    serde_json::json!({"type":"block", "index":index, "length":length}).to_string(),
                )
                .await
                .unwrap();
            for chunk in vec![73; length].chunks(64 * 1024) {
                connection.send_packet(chunk.to_vec()).await.unwrap();
            }
            sent = true;
        }
        if frame["type"] == "describe" {
            connection
                .send(
                    serde_json::json!({"type":"manifest", "size":manifest.size,
                "hashes":manifest.hashes})
                    .to_string(),
                )
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn immutable_digest_snapshot_rejects_same_size_local_corruption() {
    let origin = Origin::start();
    let update = origin.update().await;
    let directory = tempfile::tempdir().unwrap();
    let service = service(directory.path(), &origin.key);
    let artifact = Artifact::from_update(&update);
    service
        .cache
        .save(artifact.clone(), Arc::new(b"signed installer".to_vec()))
        .await
        .unwrap();
    let snapshot = service.cache.snapshot(&artifact.id).unwrap();
    std::fs::write(
        directory.path().join(format!("{}.pkg", artifact.id)),
        b"broken installer",
    )
    .unwrap();
    assert!(snapshot.block(0).await.is_err());
}
