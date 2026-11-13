use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

const THREAD: &str = "01234567-0123-4123-8123-012345678901";

fn parse(value: Value) -> GuiRequest {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn official_artifact_downloads_use_owner_cwd_and_host_handles_until_closed() {
    let fixture = tempfile::tempdir().unwrap();
    std::fs::create_dir(fixture.path().join("outputs")).unwrap();
    let expected: Vec<u8> = (0..600_013).map(|offset| (offset % 251) as u8).collect();
    std::fs::write(fixture.path().join("outputs/开题报告.docx"), &expected).unwrap();
    let streams = Arc::new(FileStreams::downloads());
    let calls = AtomicUsize::new(0);
    let forward = |request| {
        assert!(matches!(request, GuiRequest::Read { thread_id, .. } if thread_id == THREAD));
        calls.fetch_add(1, Ordering::Relaxed);
        let response = GuiResponse {
            data: json!({"thread": {"cwd": fixture.path()}}),
        };
        async { Ok(response) }
    };
    let transfer = uuid::Uuid::new_v4().to_string();
    let info = request(
        streams.clone(),
        parse(json!({"operation": "downloadOpen", "scope": "project",
        "threadId": THREAD, "cwd": "ignored-stale-project", "transferId": transfer,
        "path": "outputs/开题报告.docx", "maxBytes": 1_000_000, "prepare": true})),
        &forward,
    )
    .await
    .unwrap()
    .data;
    assert_eq!(info["name"], "开题报告.docx");
    assert_eq!(info["size"], expected.len());
    let read = |owner: &str, offset: usize| {
        parse(json!({"operation": "fileRead", "threadId": owner,
        "id": info["id"], "offset": offset, "length": (expected.len() - offset).min(256 * 1024),
        "maxBytes": 1_000_000}))
    };
    assert!(request(streams.clone(), read(THREAD, 0), &forward)
        .await
        .is_err());
    let manifest = request(
        streams.clone(),
        parse(json!({"operation": "fileManifest", "threadId": transfer,
        "id": info["id"], "maxBytes": 1_000_000})),
        &forward,
    )
    .await
    .unwrap();
    assert!(!manifest.data.is_null());
    let mut received = Vec::new();
    while received.len() < expected.len() {
        let chunk = request(streams.clone(), read(&transfer, received.len()), &forward)
            .await
            .unwrap()
            .data;
        assert_eq!(chunk["offset"], received.len());
        received.extend(STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap());
    }
    assert_eq!(received, expected);
    request(
        streams.clone(),
        parse(json!({"operation": "fileClose", "threadId": transfer,
        "id": info["id"]})),
        &forward,
    )
    .await
    .unwrap();
    assert!(request(streams, read(&transfer, 0), &forward)
        .await
        .is_err());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn official_downloads_preserve_size_path_and_missing_owner_checks() {
    let fixture = tempfile::tempdir().unwrap();
    std::fs::write(fixture.path().join("report.docx"), b"content").unwrap();
    let streams = Arc::new(FileStreams::downloads());
    let open = |path: &str, max: usize| {
        parse(json!({"operation": "downloadOpen", "scope": "project",
        "threadId": THREAD, "transferId": uuid::Uuid::new_v4().to_string(), "path": path, "maxBytes": max}))
    };
    let forward = |_| async {
        Ok(GuiResponse {
            data: json!({"thread": {"cwd": fixture.path()}}),
        })
    };
    assert!(matches!(
        request(streams.clone(), open("report.docx", 1), &forward).await,
        Err(GuiError::FileTooLarge)
    ));
    for path in [
        "missing.docx",
        "//server/share/file",
        "C:/file:stream",
        "bad\nfile",
    ] {
        assert!(request(streams.clone(), open(path, 100), &forward)
            .await
            .is_err());
    }
    let missing_owner = |_| async {
        Ok(GuiResponse {
            data: json!({"thread": {}}),
        })
    };
    assert!(matches!(
        request(streams, open("report.docx", 100), missing_owner).await,
        Err(GuiError::ProjectFiles)
    ));
}

#[tokio::test]
async fn official_project_browser_and_legacy_file_open_use_the_same_owner() {
    let fixture = tempfile::tempdir().unwrap();
    std::fs::write(fixture.path().join("report.docx"), b"content").unwrap();
    let streams = Arc::new(FileStreams::downloads());
    let forward = |_| async {
        Ok(GuiResponse {
            data: json!({"thread": {"cwd": fixture.path()}}),
        })
    };
    let browse = request(
        streams.clone(),
        parse(json!({"operation": "downloadBrowse", "scope": "project",
        "threadId": THREAD, "directory": ""})),
        &forward,
    )
    .await
    .unwrap();
    assert!(browse.data["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "report.docx"));
    let info = request(
        streams.clone(),
        parse(json!({"operation": "fileOpen", "threadId": THREAD,
        "path": "report.docx", "maxBytes": 100})),
        &forward,
    )
    .await
    .unwrap()
    .data;
    assert_eq!(info["size"], 7);
    let reply = request(
        streams,
        parse(json!({"operation": "fileRead", "threadId": THREAD,
        "id": info["id"], "offset": 0, "length": 7, "maxBytes": 100})),
        &forward,
    )
    .await
    .unwrap();
    assert_eq!(
        STANDARD
            .decode(reply.data["data"].as_str().unwrap())
            .unwrap(),
        b"content"
    );
}
