use super::*;
use crate::update_peers::{
    block_download, block_protocol, signaling::Lease, tests::network_fixture,
};
use csw_chat_connectivity::{Config, Connection, Event};
use tokio::sync::oneshot;

const PIPELINE_SETUP_TIMEOUT: Duration = Duration::from_secs(45);
const PIPELINE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(15);
// Exceed the production reader's 12-second open deadline to catch startup/transfer budget coupling.
const SLOW_SEED_START: Duration = Duration::from_secs(13);
type FixtureResult<T> = std::result::Result<T, String>;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn download_pipelines_requests_and_accepts_headers_ahead_of_payloads() {
    exercise_pipeline("pipeline-headers", Duration::ZERO).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pipeline_protocol_waits_for_a_slow_starting_seed() {
    exercise_pipeline("pipeline-cold-seed", SLOW_SEED_START).await;
}

async fn exercise_pipeline(session: &str, seed_delay: Duration) {
    let bytes = vec![31; 4 * 512 * 1024];
    let origin = Origin::with_bytes(bytes.clone());
    let update = origin.update().await;
    let directory = tempfile::tempdir().unwrap();
    let service = service(directory.path(), &origin.key);
    let mut artifact = Artifact::from_update(&update);
    service
        .cache
        .save(artifact.clone(), Arc::new(bytes.clone()))
        .await
        .unwrap();
    let snapshot = service.cache.snapshot(&artifact.id).unwrap();
    let coordinator = network_fixture::coordinator(session).await;
    let mut config = network_fixture::client(&coordinator, session);
    config.desktop = true;
    let (ready, prepared) = oneshot::channel();
    let worker = tokio::spawn(pipeline_seed(config.clone(), snapshot, seed_delay, ready));
    config.desktop = false;
    let (sender, _receiver) = mpsc::channel(16);
    let mut leases = vec![Lease::binary(config, sender).unwrap()];
    artifact.url = "http://127.0.0.1:9/unavailable".into();
    let result = download_after_preparation(prepared, &mut leases, &artifact, &service).await;
    drop(leases);
    worker.abort();
    if let Err(error) = worker.await {
        assert!(error.is_cancelled(), "pipeline seed failed: {error}");
    }
    coordinator.stop().await;
    assert_eq!(result.unwrap(), bytes);
    assert_eq!(
        service.policy.metrics.origin_bytes.load(Ordering::Relaxed),
        0
    );
}

async fn download_after_preparation(
    prepared: oneshot::Receiver<FixtureResult<()>>,
    leases: &mut Vec<Lease>,
    artifact: &Artifact,
    service: &Service,
) -> FixtureResult<Vec<u8>> {
    tokio::time::timeout(PIPELINE_SETUP_TIMEOUT, prepared)
        .await
        .map_err(|_| "pipeline seed preparation timed out".to_owned())?
        .map_err(|_| "pipeline seed stopped during preparation".to_owned())??;
    tokio::time::timeout(
        PIPELINE_TRANSFER_TIMEOUT,
        block_download::download(leases, artifact, service, |_, _| {}),
    )
    .await
    .map_err(|_| "pipeline transfer timed out after the seed became ready".to_owned())?
    .map_err(|error| format!("pipeline transfer failed after the seed became ready: {error}"))
}

async fn pipeline_seed(
    config: Config,
    snapshot: Arc<crate::update_peers::snapshot::Snapshot>,
    delay: Duration,
    ready: oneshot::Sender<FixtureResult<()>>,
) {
    tokio::time::sleep(delay).await;
    let host = Connection::start_with_packets(config).unwrap();
    let preparation = network_fixture::wait_for_stream(&host).await;
    let connected = preparation.is_ok();
    if ready.send(preparation).is_err() || !connected {
        return;
    }
    let mut queued = Vec::new();
    while let Some(event) = host.receive().await {
        let Event::Data { text } = event else {
            continue;
        };
        let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
        if frame["type"] == "describe" {
            host.send(
                serde_json::json!({"type":"manifest", "size":snapshot.manifest.size,
                "hashes":snapshot.manifest.hashes, "requestWindow":8})
                .to_string(),
            )
            .await
            .unwrap();
        } else if frame["type"] == "read" {
            queued.push(frame["index"].as_u64().unwrap() as usize);
            // A stop-and-wait client cannot get any payload from this fixture.
            if queued.len() == 2 {
                send_early_headers(&host, &snapshot, &queued).await;
                queued.clear();
            }
        }
    }
}

async fn send_early_headers(
    connection: &Connection,
    snapshot: &Arc<crate::update_peers::snapshot::Snapshot>,
    indices: &[usize],
) {
    for &index in indices {
        connection
            .send(serde_json::json!({"type":"block", "index":index, "length":512*1024}).to_string())
            .await
            .unwrap();
    }
    for &index in indices {
        for packet in snapshot.block(index).await.unwrap().chunks(64 * 1024) {
            connection.send_packet(packet.to_vec()).await.unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_empty_swarm_discovers_a_new_source_without_restarting_download() {
    let bytes = vec![47; 2 * 512 * 1024];
    let origin = Origin::with_bytes(bytes.clone());
    let update = origin.update().await;
    let directory = tempfile::tempdir().unwrap();
    let service = service(directory.path(), &origin.key);
    let mut artifact = Artifact::from_update(&update);
    service
        .cache
        .save(artifact.clone(), Arc::new(bytes.clone()))
        .await
        .unwrap();
    let snapshot = service.cache.snapshot(&artifact.id).unwrap();
    let coordinator = network_fixture::coordinator("late-update-seed").await;
    let mut config = network_fixture::client(&coordinator, "late-update-seed");
    config.desktop = true;
    let seed_config = config.clone();
    let id = artifact.id.clone();
    let policy = service.policy.clone();
    let (begin, mut started) = watch::channel(false);
    let (connected, mut seed) = tokio::sync::oneshot::channel();
    let serving = tokio::spawn(async move {
        started.changed().await.unwrap();
        // Real upload grants start both engines at lookup time, without an idle seed engine.
        let host = Connection::start_with_packets(seed_config).unwrap();
        connected.send(host.clone()).ok().unwrap();
        block_protocol::seed(&host, snapshot, &id, &policy).await
    });
    config.desktop = false;
    let (sender, mut requests) = mpsc::channel(16);
    service.broker.send_replace(Some(sender.clone()));
    let discovering = tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            if let Request::Find { reply, .. } = request {
                begin.send_replace(true);
                reply
                    .send(Ok(vec![Lease::binary(config, sender).unwrap()]))
                    .ok()
                    .unwrap();
                break;
            }
        }
    });
    artifact.url = "http://127.0.0.1:9/unavailable".into();
    let mut leases = Vec::new();
    let result = tokio::time::timeout(
        Duration::from_secs(25),
        block_download::download(&mut leases, &artifact, &service, |_, _| {}),
    )
    .await;
    drop(leases);
    let seed_result = if serving.is_finished() {
        Some(serving.await.unwrap())
    } else {
        serving.abort();
        None
    };
    if let Ok(seed) = seed.try_recv() {
        seed.close();
    }
    coordinator.stop().await;
    assert!(
        discovering.is_finished(),
        "no refill request before the download deadline"
    );
    discovering.await.unwrap();
    assert!(
        result.is_ok(),
        "download deadline elapsed; seed result: {seed_result:?}"
    );
    assert_eq!(result.unwrap().unwrap(), bytes);
    assert_eq!(
        service.policy.metrics.peer_bytes.load(Ordering::Relaxed),
        bytes.len() as u64
    );
}
