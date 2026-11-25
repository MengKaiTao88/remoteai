use super::{outcome::Reason, request::ConfirmedHistory, socket::Socket};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_CONNECTIONS: usize = 32;
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

#[derive(Clone, Eq, Hash, PartialEq)]
pub(super) struct Scope {
    pub(super) workspace: PathBuf,
    pub(super) gui: bool,
    pub(super) lan_key: Option<String>,
    pub(super) client_auth: [u8; 32],
    pub(super) session: String,
}

#[derive(PartialEq)]
pub(super) struct Owner {
    pub(super) account: String,
    pub(super) headers: [u8; 32],
}

pub(super) struct Connection {
    pub(super) socket: Socket,
    pub(super) owner: Owner,
    pub(super) history: ConfirmedHistory,
}

enum Slot {
    Idle {
        connection: Box<Connection>,
        since: Instant,
    },
    Leased {
        invalidated: bool,
    },
}

#[derive(Default)]
struct Session {
    socket: Option<Slot>,
}

pub(super) struct Lease(Option<Scope>);

#[derive(Default)]
struct Cache(HashMap<Scope, Session>);

impl std::ops::Deref for Cache {
    type Target = HashMap<Scope, Session>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for Cache {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Cache {
    fn prune(&mut self) {
        self.retain(|_, session| {
            if matches!(&session.socket, Some(Slot::Idle { since, .. }) if since.elapsed() >= IDLE_TIMEOUT) {
                session.socket = None;
            }
            session.socket.is_some()
        });
    }

    fn reserve_socket(&mut self, scope: &Scope) -> Result<Option<Connection>, Reason> {
        self.prune();
        if let Some(session) = self.get_mut(scope) {
            if let Some(Slot::Leased { invalidated }) = &mut session.socket {
                *invalidated = true;
                return Err(Reason::ConversationBusy);
            }
        }
        if self.values().filter(|entry| entry.socket.is_some()).count() >= MAX_CONNECTIONS
            && self
                .get(scope)
                .is_none_or(|session| session.socket.is_none())
        {
            self.evict_idle_socket()?;
        }
        let session = self.entry(scope.clone()).or_default();
        let previous = session.socket.replace(Slot::Leased { invalidated: false });
        Ok(match previous {
            Some(Slot::Idle { connection, .. }) => Some(*connection),
            _ => None,
        })
    }

    fn evict_idle_socket(&mut self) -> Result<(), Reason> {
        let session = self
            .values_mut()
            .filter_map(|session| match &session.socket {
                Some(Slot::Idle { since, .. }) => Some((*since, session)),
                _ => None,
            })
            .min_by_key(|(since, _)| *since)
            .map(|(_, session)| session)
            .ok_or(Reason::CacheFull)?;
        session.socket = None;
        Ok(())
    }
}

impl Lease {
    pub(super) fn take(scope: Scope) -> Result<(Self, Option<Connection>), Reason> {
        let mut cache = cache().lock().map_err(|_| Reason::CacheUnavailable)?;
        let previous = cache.reserve_socket(&scope)?;
        Ok((Self(Some(scope)), previous))
    }

    pub(super) fn retain(mut self, connection: Connection) {
        let Some(scope) = self.0.as_ref() else { return };
        let Ok(mut cache) = cache().lock() else {
            return;
        };
        let Some(slot) = cache.get_mut(scope).map(|session| &mut session.socket) else {
            return;
        };
        if matches!(slot, Some(Slot::Leased { invalidated: false })) {
            *slot = Some(Slot::Idle {
                connection: Box::new(connection),
                since: Instant::now(),
            });
            self.0 = None;
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let Some(scope) = self.0.take() else { return };
        let Ok(mut cache) = cache().lock() else {
            return;
        };
        if let Some(session) = cache.get_mut(&scope) {
            session.socket = None;
        }
    }
}

fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(Mutex::default)
}

fn invalidate_socket(slot: &mut Option<Slot>) {
    match slot {
        Some(Slot::Leased { invalidated }) => *invalidated = true,
        Some(Slot::Idle { .. }) => *slot = None,
        None => {}
    }
}

pub(super) fn invalidate(scope: &Scope) {
    if let Ok(mut cache) = cache().lock() {
        if let Some(session) = cache.get_mut(scope) {
            invalidate_socket(&mut session.socket);
        }
    }
}

pub(super) fn clear(gui: bool) {
    if let Ok(mut cache) = cache().lock() {
        cache.retain(|scope, session| {
            if scope.gui != gui {
                return true;
            }
            invalidate_socket(&mut session.socket);
            session.socket.is_some()
        });
    }
}
