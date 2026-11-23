use super::{outcome::Reason, request::ConfirmedHistory, socket::Socket};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_CONNECTIONS: usize = 32;
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_TRACKED_OWNERS: usize = 256;
const OWNER_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
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

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum AccountRoute {
    Unknown,
    SameAccount,
    ChangedAccount,
    Unavailable,
}

pub(super) fn account_route(scope: &Scope, account: &str) -> AccountRoute {
    let Ok(mut cache) = cache().lock() else {
        return AccountRoute::Unavailable;
    };
    cache.prune();
    match cache
        .get(scope)
        .and_then(|session| session.account.as_ref())
    {
        Some(owner) if owner.id != account => AccountRoute::ChangedAccount,
        Some(_) => AccountRoute::SameAccount,
        None => AccountRoute::Unknown,
    }
}

pub(super) fn record_account(scope: &Scope, account: &str) {
    if let Ok(mut cache) = cache().lock() {
        cache.record_account(scope, account);
    }
}

struct AccountUse {
    id: String,
    since: Instant,
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
    account: Option<AccountUse>,
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
            if session.account.as_ref().is_some_and(|owner| owner.since.elapsed() >= OWNER_IDLE_TIMEOUT) {
                session.account = None;
            }
            session.socket.is_some() || session.account.is_some()
        });
    }

    fn record_account(&mut self, scope: &Scope, account: &str) {
        self.prune();
        let new_owner = self
            .get(scope)
            .is_none_or(|session| session.account.is_none());
        if new_owner
            && self
                .values()
                .filter(|session| session.account.is_some())
                .count()
                >= MAX_TRACKED_OWNERS
        {
            self.evict_oldest_owner();
        }
        let entry = self.entry(scope.clone()).or_default();
        if matches!(&entry.socket, Some(Slot::Idle { connection, .. }) if connection.owner.account != account)
        {
            entry.socket = None;
        }
        entry.account = Some(AccountUse {
            id: account.into(),
            since: Instant::now(),
        });
    }

    fn evict_oldest_owner(&mut self) {
        let oldest = self
            .iter()
            .filter_map(|(scope, session)| {
                let owner = session.account.as_ref()?;
                session.socket.is_none().then_some((scope, owner.since))
            })
            .min_by_key(|(_, since)| *since)
            .map(|(scope, _)| scope.clone());
        if let Some(scope) = oldest {
            self.remove(&scope);
        }
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

    pub(super) fn record_account(&self, account: &str) {
        if let Some(scope) = self.0.as_ref() {
            record_account(scope, account);
        }
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
            session.account = None;
            invalidate_socket(&mut session.socket);
            session.socket.is_some()
        });
    }
}
