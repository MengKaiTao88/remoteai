use std::io::Write;
use std::time::Duration;

use flate2::{write::GzEncoder, Compression};
use tiny_http::{Header, Response, Server};

#[test]
fn cloud_client_negotiates_and_decodes_gzip_json() {
    let server = Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}/skills", server.server_addr());
    let expected = serde_json::json!({"items": [{"title": "community plugin"}]});
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(expected.to_string().as_bytes()).unwrap();
    let compressed = encoder.finish().unwrap();
    let worker = std::thread::spawn(move || {
        let request = server
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(request.headers().iter().any(|header| {
            header.field.equiv("Accept-Encoding") && header.value.as_str().contains("gzip")
        }));
        let response = Response::from_data(compressed)
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
            .with_header(Header::from_bytes("Content-Encoding", "gzip").unwrap());
        request.respond(response).unwrap();
    });
    let response = super::api_client().unwrap().get(url).send().unwrap();
    assert!(response.headers().get("Content-Encoding").is_none());
    assert_eq!(response.json::<serde_json::Value>().unwrap(), expected);
    worker.join().unwrap();
}
