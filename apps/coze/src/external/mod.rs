//! Opt-in tool transport. The owner/editor API remains on its separate loopback listener.
mod http;
#[cfg(test)]
mod tests;

use crate::{
    api::Services,
    error::{Error, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    net::UdpSocket,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tiny_http::Server;

const DEFAULT_PORT: u16 = 15461;
const SETTINGS_FILE: &str = "tool-listener.json";

#[derive(Clone, Copy, Default, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Local,
    Network,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub mode: Mode,
    pub port: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: Mode::Local,
            port: DEFAULT_PORT,
        }
    }
}

#[derive(Serialize)]
pub struct Status {
    pub settings: Settings,
    pub urls: Vec<String>,
}

struct Listener {
    server: Arc<Server>,
    stopped: Arc<AtomicBool>,
    settings: Settings,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.server.unblock();
    }
}

#[derive(Default)]
struct State {
    listener: Option<Listener>,
    settings: Settings,
}

#[derive(Default)]
pub struct ToolServer {
    state: Mutex<State>,
}

impl ToolServer {
    pub fn status(&self) -> Result<Status> {
        let current = self.state.lock().map_err(|_| Error::Conflict)?;
        Ok(status(current.settings))
    }

    /// Configuration is owner-only at the API boundary; active listeners cannot be rebound in place.
    pub fn configure(&self, services: &Services, mut settings: Settings) -> Result<Status> {
        let mut current = self.state.lock().map_err(|_| Error::Conflict)?;
        if let Some(listener) = current.listener.as_ref() {
            if settings.enabled && settings != listener.settings {
                return Err(Error::Conflict);
            }
        }
        let next = if settings.enabled && current.listener.is_none() {
            let listener = listen(services.clone(), settings)?;
            settings.port = listener.settings.port;
            Some(listener)
        } else {
            None
        };
        save(services, settings)?;
        if !settings.enabled {
            current.listener.take();
        }
        if next.is_some() {
            current.listener = next;
        }
        current.settings = settings;
        Ok(status(settings))
    }
}

fn status(settings: Settings) -> Status {
    let mut urls = vec![];
    if settings.enabled {
        urls.push(format!("http://127.0.0.1:{}", settings.port));
        if settings.mode == Mode::Network {
            if let Some(address) = local_address() {
                urls.push(format!("http://{address}:{}", settings.port));
            }
        }
    }
    Status { settings, urls }
}

fn local_address() -> Option<std::net::IpAddr> {
    // UDP connect selects the outgoing interface without sending a packet.
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    Some(socket.local_addr().ok()?.ip())
}

fn save(services: &Services, settings: Settings) -> Result<()> {
    // Network exposure belongs to this installation, not to portable content backups.
    let mut file = tempfile::NamedTempFile::new_in(services.db.root())?;
    let bytes = serde_json::to_vec(&settings).map_err(|_| Error::Invalid)?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    file.persist(services.db.root().join(SETTINGS_FILE))
        .map_err(|error| Error::File(error.error))?;
    Ok(())
}

pub fn restore(services: &Services) -> Result<()> {
    let file = match std::fs::File::open(services.db.root().join(SETTINGS_FILE)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(1025).read_to_end(&mut bytes)?;
    if bytes.len() > 1024 {
        return Err(Error::Invalid);
    }
    let settings = serde_json::from_slice(&bytes).map_err(|_| Error::Invalid)?;
    services.external.configure(services, settings)?;
    Ok(())
}

fn listen(mut services: Services, mut settings: Settings) -> Result<Listener> {
    let address = match settings.mode {
        Mode::Local => "127.0.0.1",
        Mode::Network => "0.0.0.0",
    };
    let server = Arc::new(Server::http((address, settings.port)).map_err(|_| Error::ToolListener)?);
    settings.port = server.server_addr().to_ip().ok_or(Error::Network)?.port();
    let listener = Listener {
        server,
        stopped: Arc::new(AtomicBool::new(false)),
        settings,
    };
    // Tool workers cannot configure listeners. Detach their manager to avoid a lifetime cycle.
    services.external = Arc::new(ToolServer::default());
    http::serve(services, listener.server.clone(), listener.stopped.clone())?;
    Ok(listener)
}
