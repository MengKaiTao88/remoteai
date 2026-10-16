use csw_chat_connectivity::{Config, Connection, Event};
use easytier::{
    common::config::{ConfigLoader, NetworkIdentity, TomlConfig},
    instance::factory::{create_native_instance, NativeCoreInstance},
};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const STREAM_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Consume the seed's startup events before a protocol fixture starts accepting requests.
/// The download side keeps its own Open/Status events for the production protocol reader.
pub(crate) async fn wait_for_stream(connection: &Connection) -> Result<(), String> {
    let mut diagnostic = "no discovery diagnostics received".to_owned();
    let ready = tokio::time::timeout(STREAM_READY_TIMEOUT, async {
        loop {
            match connection.receive().await {
                Some(Event::Open) => return true,
                Some(Event::Closed) | None => return false,
                Some(Event::Diagnostic { stage, snapshot }) => {
                    // These snapshots contain counts and stages, never peer addresses or credentials.
                    diagnostic = format!("{stage:?}: {snapshot:?}");
                }
                _ => {}
            }
        }
    })
    .await;
    match ready {
        Ok(true) => Ok(()),
        Ok(false) => Err(format!(
            "P2P fixture closed before its stream opened; {diagnostic}"
        )),
        Err(_) => Err(format!(
            "P2P fixture did not open its stream within {STREAM_READY_TIMEOUT:?}; {diagnostic}"
        )),
    }
}

pub(crate) async fn host(session: &str) -> Arc<NativeCoreInstance> {
    start(session, false).await
}

pub(crate) async fn coordinator(session: &str) -> Arc<NativeCoreInstance> {
    start(session, true).await
}

async fn start(session: &str, coordinator: bool) -> Arc<NativeCoreInstance> {
    let core = TomlConfig::default();
    core.set_inst_name(session.into());
    core.set_hostname(Some(
        if coordinator {
            "update-coordinator"
        } else {
            "csw-host"
        }
        .into(),
    ));
    core.set_network_identity(NetworkIdentity::new(
        format!("csw-{session}"),
        "ab".repeat(32),
    ));
    if !coordinator {
        core.set_ipv4(Some("10.253.0.1/24".parse().unwrap()));
    }
    core.set_listeners(vec!["tcp://127.0.0.1:0".parse().unwrap()]);
    let mut flags = core.get_flags();
    flags.no_tun = true;
    flags.use_smoltcp = !coordinator;
    flags.enable_ipv6 = true;
    flags.enable_encryption = true;
    flags.disable_upnp = true;
    flags.disable_relay_data = true;
    flags.relay_network_whitelist.clear();
    if coordinator {
        flags.relay_network_whitelist = "csw-*".into();
    }
    flags.accept_dns = false;
    core.set_flags(flags);
    let host = tokio::task::spawn_blocking(move || create_native_instance(core).unwrap())
        .await
        .unwrap();
    host.start().await.unwrap();
    host
}

pub(crate) fn client(host: &NativeCoreInstance, session: &str) -> Config {
    Config {
        session_id: session.into(),
        secret: "ab".repeat(32),
        desktop: false,
        servers: vec![host
            .running_listeners()
            .into_iter()
            .find(|url| url.scheme() == "tcp")
            .unwrap()
            .to_string()],
        stun_servers: Vec::new(),
        expires_at: (SystemTime::now().duration_since(UNIX_EPOCH).unwrap()
            + Duration::from_secs(60))
        .as_millis() as u64,
    }
}
