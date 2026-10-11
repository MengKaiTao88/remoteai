use super::*;
use crate::jobs::JobManager;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::mpsc,
    thread,
    time::Instant,
};

fn wait_status(manager: &JobManager, id: &str, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let value = manager.status(id, 0).unwrap();
        if predicate(&value) {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "job did not reach expected state: {value}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn stream_delivers_events_before_completion_and_cancel_closes_a_stalled_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (release, wait) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = [0; 8192];
        assert!(socket.read(&mut request).unwrap() > 0);
        socket
            .write_all(
                concat!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n",
                    "Connection: close\r\n\r\n",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"first token\"}}]}\n\n"
                )
                .as_bytes(),
            )
            .unwrap();
        socket.flush().unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
    });
    let proxy = ModelProxy::new(&format!("http://{address}/v1"), "local-token".into()).unwrap();
    let jobs = JobManager::default();
    let job = jobs
        .start(move |control| {
            let result = proxy.complete(
                CompletionRequest {
                    model: "test",
                    temperature: 0.7,
                    messages: &[json!({"role":"user","content":"hello"})],
                    tools: &[],
                },
                &control,
            )?;
            Ok(json!({"content":result.content}))
        })
        .unwrap();
    let id = job["id"].as_str().unwrap();
    let partial = wait_status(&jobs, id, |status| {
        !status["events"].as_array().unwrap().is_empty()
    });
    assert_eq!(partial["status"], "running");
    assert_eq!(partial["events"][0]["event"]["text"], "first token");
    let cancelled = Instant::now();
    jobs.cancel(id).unwrap();
    let status = wait_status(&jobs, id, |status| status["status"] != "running");
    assert_eq!(status["status"], "cancelled");
    assert!(cancelled.elapsed() < Duration::from_secs(2));
    release.send(()).unwrap();
    server.join().unwrap();
}

#[test]
fn vision_requests_reject_remote_urls_and_non_image_payloads() {
    assert!(ModelProxy::new("https://example.com/v1", "key".into()).is_err());
    let proxy = ModelProxy::new("http://127.0.0.1:1/v1", "key".into()).unwrap();
    let image = VisionImage {
        mime_type: "text/html".into(),
        content_base64: "YWJj".into(),
    };
    assert!(matches!(
        proxy.vision("test", &[image], "extract"),
        Err(Error::Invalid)
    ));
}
