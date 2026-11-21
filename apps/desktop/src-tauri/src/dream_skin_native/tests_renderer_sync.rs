use super::*;

struct BindingServer {
    target: CdpTarget,
    port: u16,
    disconnected: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    connections: thread::JoinHandle<()>,
}

impl BindingServer {
    fn start() -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let disconnected = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let worker_disconnected = disconnected.clone();
        let connections = thread::spawn(move || {
            let mut workers = Vec::new();
            while !worker_stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let disconnected = worker_disconnected.clone();
                        let stopped = worker_stopped.clone();
                        workers.push(thread::spawn(move || {
                            serve_binding(stream, disconnected, stopped)
                        }));
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("binding fixture failed: {error}"),
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            target: CdpTarget {
                id: "sync-recovery".to_string(),
                kind: "page".to_string(),
                url: "app://-/index.html".to_string(),
                web_socket_debugger_url: format!(
                    "ws://127.0.0.1:{port}/devtools/page/sync-recovery"
                ),
            },
            port,
            disconnected,
            stopped,
            connections,
        }
    }

    fn stop(self) {
        self.stopped.store(true, Ordering::Release);
        self.connections.join().unwrap();
    }
}

fn serve_binding(stream: TcpStream, disconnected: Arc<AtomicBool>, stopped: Arc<AtomicBool>) {
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut socket = tungstenite::accept(stream).unwrap();
    let mut is_binding = false;
    while !stopped.load(Ordering::Acquire) {
        if is_binding && disconnected.load(Ordering::Acquire) {
            return;
        }
        let message = match socket.read() {
            Ok(Message::Text(text)) => text,
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) =>
            {
                continue
            }
            _ => return,
        };
        let request: Value = serde_json::from_str(&message).unwrap();
        is_binding |= request["method"] == "Runtime.addBinding";
        let is_sync_probe = request["method"] == "Runtime.evaluate"
            && request["params"]["expression"]
                .as_str()
                .is_some_and(|expression| expression.contains("modelOverride:"));
        let value = if is_sync_probe {
            json!({ "healthy": true, "modelOverride": false })
        } else {
            json!(true)
        };
        let response = json!({ "id": request["id"], "result": { "result": { "value": value } } });
        if socket
            .send(Message::Text(response.to_string().into()))
            .is_err()
        {
            return; // The client may abandon an older generation during replacement.
        }
    }
}

fn wait_for_binding_health(target: &CdpTarget, expected: bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while renderer_bindings_healthy(target) != expected {
        assert!(
            Instant::now() < deadline,
            "listener health did not become {expected}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn disconnected_binding_is_detected_and_replaced_without_restarting_the_renderer() {
    let server = BindingServer::start();
    assert!(!renderer_bindings_healthy(&server.target));
    install_renderer_bindings(&server.target, server.port).unwrap();
    assert!(renderer_sync_healthy(&server.target, server.port));
    server.disconnected.store(true, Ordering::Release);
    wait_for_binding_health(&server.target, false);
    server.disconnected.store(false, Ordering::Release);
    install_renderer_bindings(&server.target, server.port).unwrap();
    assert!(renderer_sync_healthy(&server.target, server.port));
    // Replacing a live worker must not let the old worker clear the new one's health.
    install_renderer_bindings(&server.target, server.port).unwrap();
    thread::sleep(RENDERER_BINDING_POLL + Duration::from_millis(100));
    assert!(renderer_bindings_healthy(&server.target));
    let target = server.target.clone();
    server.stop();
    wait_for_binding_health(&target, false);
}

#[test]
fn binding_health_is_scoped_to_the_renderer_endpoint_and_expires() {
    let server = BindingServer::start();
    let mut health = RendererBindingHealth {
        generation: 1,
        endpoint: server.target.web_socket_debugger_url.clone(),
        last_poll: Instant::now(),
    };
    assert!(health.matches(&server.target));
    let mut replaced = server.target.clone();
    replaced.web_socket_debugger_url.push_str("-new-page");
    assert!(!health.matches(&replaced));
    health.last_poll = Instant::now() - RENDERER_BINDING_HEALTH_TIMEOUT;
    assert!(!health.matches(&server.target));
    server.stop();
}
