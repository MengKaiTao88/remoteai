use super::*;

const ROUTING_TIMEOUT: Duration = Duration::from_secs(8);
const PRIMARY: &str = "primary-routing@example.test";
const MODEL_ONLY: &str = "model-only-routing@example.test";
const MATCHING: &str = "matching-routing@example.test";
const MODEL: &str = "gpt-5.6-sol";
const EFFORT: &str = "xhigh";

#[test]
fn official_concurrent_recovery_preserves_model_and_effort() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = Server::http("127.0.0.1:0").unwrap();
    let fixture = RoutingFixture::concurrent(&upstream, 1);
    let worker = thread::spawn(move || serve_model_limited_accounts(upstream));
    let input = serde_json::to_vec(&routing_input("continue the conversation")).unwrap();
    let response = fixture
        .request(json!({}))
        .header("content-encoding", "gzip")
        .body(responses_lite::encode(&input, "gzip").unwrap())
        .send()
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let response: Value = response.json().unwrap();
    assert_eq!(response["id"], MATCHING);
    worker.join().unwrap();
    fixture.join();
}

#[test]
fn official_image_input_recovery_skips_incompatible_backup_accounts() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = Server::http("127.0.0.1:0").unwrap();
    let fixture = RoutingFixture::concurrent(&upstream, 1);
    let paths = resolve_paths(fixture.app.handle()).unwrap();
    let mut state = read_state(&paths);
    state.image_input_target = Some(ImageModelTarget::Official {
        account_id: state.active_account_id.clone().unwrap(),
    });
    write_state(&paths, &state).unwrap();
    let worker = thread::spawn(move || serve_model_limited_accounts(upstream));
    let mut body = routing_input("continue the conversation");
    body["input"][0]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"input_image","image_url":"data:image/png;base64,AA=="}));
    let response = fixture.send(body);
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.json::<Value>().unwrap()["id"], MATCHING);
    worker.join().unwrap();
    fixture.join();
}

#[test]
fn official_gui_recovery_uses_only_candidate_catalogs_that_support_the_original_effort() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = Server::http("127.0.0.1:0").unwrap();
    let fixture = RoutingFixture::new(&upstream, 1, RoutingMode::Gui);
    let worker = thread::spawn(move || serve_model_limited_accounts(upstream));
    let response = fixture.send(routing_input("continue the conversation"));
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.json::<Value>().unwrap()["id"], MATCHING);
    worker.join().unwrap();
    fixture.join();
}

#[test]
fn official_concurrent_recovery_preserves_quota_when_no_eligible_backup_can_repeat_the_request() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = Server::http("127.0.0.1:0").unwrap();
    let fixture = RoutingFixture::concurrent(&upstream, 2);
    let worker = thread::spawn(move || {
        let primary = next_request(&upstream);
        assert_eq!(mock_account(&primary), PRIMARY);
        quota_reply(primary);
        loop {
            let mut candidate = next_request(&upstream);
            let account = mock_account(&candidate);
            assert_ne!(account, PRIMARY);
            if candidate.method() == &Method::Get {
                catalog_reply(candidate, "high");
                continue;
            }
            let body: Value = serde_json::from_reader(candidate.as_reader()).unwrap();
            assert_eq!(body["reasoning"]["effort"], "high");
            mock_json_reply(candidate, 200, json!({"id":account}));
            break;
        }
    });
    let response = fixture.send(routing_input("must keep the stronger effort"));
    assert_eq!(response.status().as_u16(), 429);
    assert_eq!(
        response.json::<Value>().unwrap()["error"]["type"],
        "usage_limit_reached"
    );
    let mut next = routing_input("a lower effort is enough for this turn");
    next["reasoning"]["effort"] = "high".into();
    assert_eq!(
        fixture.send(next).json::<Value>().unwrap()["id"],
        MODEL_ONLY
    );
    worker.join().unwrap();
    fixture.join();
}

#[test]
fn official_concurrent_stream_quota_changes_only_later_requests_after_output() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = Server::http("127.0.0.1:0").unwrap();
    let fixture = RoutingFixture::concurrent(&upstream, 2);
    let worker = thread::spawn(move || {
        let primary = next_request(&upstream);
        assert_eq!(mock_account(&primary), PRIMARY);
        committed_quota_reply(primary);
        serve_model_limited_accounts(upstream);
    });
    let mut first = routing_input("already generating output");
    first["stream"] = true.into();
    let response = fixture.send(first);
    assert_eq!(response.status().as_u16(), 200);
    let body = response.text().unwrap();
    assert!(body.contains("already sent"));
    assert!(body.contains("usage_limit_reached"));
    assert_eq!(
        fixture
            .send(routing_input("continue the conversation"))
            .json::<Value>()
            .unwrap()["id"],
        MATCHING,
    );
    worker.join().unwrap();
    fixture.join();
}

#[test]
fn official_late_quota_respects_an_explicit_reselection_of_the_same_shared_account() {
    if run_gui_runtime_test_in_subprocess() {
        return;
    }
    let upstream = Server::http("127.0.0.1:0").unwrap();
    let fixture = RoutingFixture::new(&upstream, 2, RoutingMode::SharedSequential);
    let (started, received) = std::sync::mpsc::sync_channel(0);
    let (selected, confirmed) = std::sync::mpsc::sync_channel(0);
    let worker = thread::spawn(move || {
        let primary = next_request(&upstream);
        assert_eq!(mock_account(&primary), PRIMARY);
        started.send(()).unwrap();
        confirmed.recv_timeout(ROUTING_TIMEOUT).unwrap();
        quota_reply(primary);
        let next = next_request(&upstream);
        assert_eq!(next.method(), &Method::Post);
        assert_eq!(mock_account(&next), PRIMARY);
        mock_json_reply(next, 200, json!({"id":PRIMARY}));
    });
    let app = fixture.app.handle();
    let primary = read_state(&resolve_paths(app).unwrap())
        .active_account_id
        .unwrap();
    let request = fixture.request(routing_input("first turn"));
    thread::scope(|scope| {
        let inflight = scope.spawn(move || request.send().unwrap());
        received.recv_timeout(ROUTING_TIMEOUT).unwrap();
        crate::commands::switch_account_blocking(app.clone(), primary.clone()).unwrap();
        selected.send(()).unwrap();
        assert_eq!(inflight.join().unwrap().status().as_u16(), 429);
    });
    let response = fixture.send(routing_input("deliberate retry"));
    assert_eq!(response.json::<Value>().unwrap()["id"], PRIMARY);
    assert_eq!(
        read_state(&resolve_paths(app).unwrap()).active_account_id,
        Some(primary)
    );
    worker.join().unwrap();
    fixture.join();
}

fn next_request(server: &Server) -> Request {
    server
        .recv_timeout(ROUTING_TIMEOUT)
        .unwrap()
        .expect("mock official upstream request")
}

fn committed_quota_reply(request: Request) {
    let delta = json!({"type":"response.output_text.delta","delta":"already sent"});
    let quota = json!({
        "type":"response.failed", "response": {
            "output":[{"type":"message","role":"assistant","content":[]}],
            "error":{"type":"usage_limit_reached"}
        }
    });
    request
        .respond(
            Response::from_string(format!("data: {delta}\r\n\r\ndata: {quota}\r\n\r\n"))
                .with_header(Header::from_bytes("Content-Type", "text/event-stream").unwrap()),
        )
        .unwrap();
}

fn serve_model_limited_accounts(upstream: Server) {
    while let Some(mut request) = upstream.recv_timeout(ROUTING_TIMEOUT).unwrap() {
        let account = mock_account(&request);
        if request.method() == &Method::Get {
            assert!(request.url().starts_with("/models?client_version="));
            let effort = if account == MODEL_ONLY {
                "high"
            } else {
                EFFORT
            };
            catalog_reply(request, effort);
            continue;
        }
        assert_eq!(request.url(), "/responses");
        let encoding = request
            .headers()
            .iter()
            .find(|header| header.field.equiv("content-encoding"))
            .map_or("identity", |header| header.value.as_str())
            .to_owned();
        let mut bytes = Vec::new();
        request.as_reader().read_to_end(&mut bytes).unwrap();
        let body: Value =
            serde_json::from_slice(&responses_lite::decode(&bytes, &encoding).unwrap()).unwrap();
        assert_eq!(body["model"], MODEL);
        assert_eq!(body["reasoning"]["effort"], EFFORT);
        assert_eq!(
            body["input"][0]["content"][0]["text"],
            "continue the conversation"
        );
        if account == PRIMARY {
            quota_reply(request);
            continue;
        }
        mock_json_reply(request, 200, json!({"id":account}));
        break;
    }
}

fn mock_account(request: &Request) -> String {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .and_then(|header| header.value.as_str().strip_prefix("Bearer test-token-"))
        .expect("official credential")
        .to_owned()
}

fn routing_input(text: &str) -> Value {
    json!({
        "model": MODEL,
        "reasoning": {"effort": EFFORT},
        "input": [{"role":"user","content":[{"type":"input_text","text":text}]}],
        "stream": false
    })
}

fn quota_reply(request: Request) {
    mock_json_reply(
        request,
        429,
        json!({"error":{"type":"usage_limit_reached"}}),
    );
}

fn catalog_reply(request: Request, effort: &str) {
    mock_json_reply(
        request,
        200,
        json!({"models":[{
            "slug": MODEL, "supported_reasoning_levels": [{"effort":effort}]
        }]}),
    );
}

fn mock_json_reply(request: Request, status: u16, value: Value) {
    request
        .respond(
            Response::from_string(value.to_string())
                .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
                .with_status_code(status),
        )
        .unwrap();
}

struct RoutingFixture {
    app: tauri::App<tauri::test::MockRuntime>,
    base: String,
    worker: thread::JoinHandle<()>,
}

#[derive(Clone, Copy)]
enum RoutingMode {
    SharedSequential,
    SharedConcurrent,
    Gui,
}

impl RoutingFixture {
    fn concurrent(upstream: &Server, turns: usize) -> Self {
        Self::new(upstream, turns, RoutingMode::SharedConcurrent)
    }

    fn new(upstream: &Server, turns: usize, mode: RoutingMode) -> Self {
        let app = gui_runtime_test_app();
        let paths = resolve_paths(app.handle()).unwrap();
        let accounts = [PRIMARY, MODEL_ONLY, MATCHING].map(|email| {
            let member = aggregate_official_account(&paths, email);
            let id = aggregate_api::member_account_id(&member).unwrap();
            let mut usage = account_with_usage(id, 60.0, 90.0).usage;
            usage.fetched_at = Some(chrono::Utc::now().to_rfc3339());
            crate::storage::save_usage(&usage_path(&paths, id), &usage).unwrap();
            let priority = [PRIMARY, MODEL_ONLY, MATCHING]
                .iter()
                .position(|account| *account == email)
                .unwrap();
            crate::storage::save_auto_switch_priority(
                &auto_switch_priority_path(&paths, id),
                priority as i32,
            )
            .unwrap();
            id.to_owned()
        });
        write_state(
            &paths,
            &ManagerStateFile {
                active_account_id: Some(accounts[0].clone()),
                auto_switch_on_quota_exhaustion: true,
                concurrent_account_routing_enabled: matches!(mode, RoutingMode::SharedConcurrent),
                custom_auto_switch_priority_enabled: true,
                ..Default::default()
            },
        )
        .unwrap();
        if matches!(mode, RoutingMode::Gui) {
            configure_gui(&app, &accounts);
        }
        Self::start(upstream, turns, app, mode)
    }

    fn start(
        upstream: &Server,
        turns: usize,
        app: tauri::App<tauri::test::MockRuntime>,
        mode: RoutingMode,
    ) -> Self {
        let proxy = Server::http("127.0.0.1:0").unwrap();
        let (prefix, origin) = match mode {
            RoutingMode::Gui => ("/codex-gui", RequestOrigin::Gui),
            _ => ("", RequestOrigin::External),
        };
        let base = format!("http://{}{prefix}", proxy.server_addr());
        let upstream = format!("http://{}", upstream.server_addr());
        let handle = app.handle().clone();
        let worker = thread::spawn(move || {
            thread::scope(|scope| {
                for _ in 0..turns {
                    let request = proxy.recv_timeout(ROUTING_TIMEOUT).unwrap().unwrap();
                    let upstream = upstream.as_str();
                    let app = handle.clone();
                    scope.spawn(move || {
                        let _upstream = AggregateOfficialUpstream::set(upstream);
                        serve_request(app, request, origin);
                    });
                }
            });
        });
        Self { app, base, worker }
    }

    fn send(&self, body: Value) -> reqwest::blocking::Response {
        self.request(body).send().unwrap()
    }

    fn request(&self, body: Value) -> reqwest::blocking::RequestBuilder {
        gui_runtime_client()
            .post(format!("{}/v1/responses", self.base))
            .bearer_auth(crate::codex_config::LOCAL_PROXY_TOKEN)
            .header("thread-id", "official-recovery-routing")
            .json(&body)
    }

    fn join(self) {
        self.worker.join().unwrap();
    }
}

fn configure_gui(app: &tauri::App<tauri::test::MockRuntime>, accounts: &[String; 3]) {
    app.manage(crate::codex_gui::GuiState::default());
    app.manage(crate::codex_gui::web::WebEventState::default());
    let root = app.path().app_data_dir().unwrap();
    crate::storage::write_json_atomic(
        &root.join("codex-gui-account.json"),
        &json!({"kind":"account","id":accounts[0],"revision":1}),
    )
    .unwrap();
    let rules: Vec<_> = accounts
        .iter()
        .enumerate()
        .map(|(priority, id)| json!({"accountId":id,"priority":priority}))
        .collect();
    crate::storage::write_json_atomic(
        &root.join("codex-gui-auto-switch.json"),
        &json!({"enabled":true,"mode":"sequential","accounts":rules,"revision":1}),
    )
    .unwrap();
}
