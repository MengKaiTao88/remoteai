use super::*;
use std::{cell::Cell, thread};

fn server(status: u16, body: Vec<u8>) -> (Url, thread::JoinHandle<()>) {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = catalog_url(&format!("http://{}", server.server_addr())).unwrap();
    let task = thread::spawn(move || {
        let request = server
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(request.url(), "/official-models");
        assert!(!request
            .headers()
            .iter()
            .any(|header| header.field.equiv("Authorization")));
        let response = tiny_http::Response::from_data(body)
            .with_status_code(status)
            .with_header(tiny_http::Header::from_bytes("ETag", "catalog-v3").unwrap());
        request.respond(response).unwrap();
    });
    (url, task)
}

#[test]
fn admin_cache_preserves_capabilities_and_never_calls_official_on_success() {
    let body = br#"{"models":[{"slug":"gpt-test","context_window":123456,"input_modalities":["text","image"],
        "supported_reasoning_levels":[{"effort":"high"}]}],"extra":true}"#.to_vec();
    let (url, task) = server(200, body.clone());
    let client = Client::builder().no_proxy().build().unwrap();
    let payload = prefer_cache(request_catalog(&client, url), || {
        panic!("official fallback called")
    })
    .unwrap();
    assert_eq!(
        payload.response_headers,
        [("etag".into(), "catalog-v3".into())]
    );
    let UpstreamBody::Buffered(actual) = payload.body else {
        panic!("expected buffered catalog")
    };
    assert_eq!(actual, body);
    task.join().unwrap();
}

#[test]
fn unavailable_empty_and_invalid_cache_all_fall_back_to_official() {
    for (status, body) in [
        (503, "unavailable"),
        (404, "missing"),
        (200, "{\"models\":[]}"),
        (200, "[]"),
        (200, "{\"models\":[{}]}"),
        (200, "invalid json"),
    ] {
        let (url, task) = server(status, body.as_bytes().to_vec());
        let client = Client::builder().no_proxy().build().unwrap();
        let calls = Cell::new(0);
        let result = prefer_cache(request_catalog(&client, url), || {
            calls.set(calls.get() + 1);
            Err("official attempted".to_string())
        });
        assert_eq!(calls.get(), 1);
        assert_eq!(result.err().as_deref(), Some("official attempted"));
        task.join().unwrap();
    }
}

#[test]
fn validates_addresses_and_rejects_duplicate_or_oversized_catalogs() {
    assert_eq!(
        catalog_url("https://example.test/api/").unwrap().path(),
        "/api/official-models"
    );
    for address in [
        "file:///tmp/models",
        "https://user:secret@example.test",
        "https://example.test?token=x",
    ] {
        assert!(catalog_url(address).is_err());
    }
    assert!(validate_catalog(br#"{"models":[{"slug":"x"},{"slug":"x"}]}"#).is_err());
    assert!(validate_catalog(&vec![b' '; MAX_CATALOG_BYTES as usize + 1]).is_err());
}

#[test]
fn cache_transport_failure_still_attempts_official() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = catalog_url(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    drop(listener);
    let client = Client::builder().no_proxy().build().unwrap();
    let result = prefer_cache(request_catalog(&client, url), || Err("fallback".into()));
    assert_eq!(result.err().as_deref(), Some("fallback"));
}
