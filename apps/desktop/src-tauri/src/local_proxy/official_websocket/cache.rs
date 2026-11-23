use super::{request::ConfirmedHistory, socket::Socket};
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
static CACHE: OnceLock<Mutex<HashMap<Scope, Slot>>> = OnceLock::new();
static OWNERS: OnceLock<Mutex<HashMap<Scope, AccountUse>>> = OnceLock::new();

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

struct AccountUse {
    id: String,
    last_used: Instant,
}

pub(super) fn account_allowed(scope: &Scope, account: &str, account_bound: bool) -> bool {
    let mut owners = match OWNERS.get_or_init(Mutex::default).lock() {
        Ok(owners) => owners,
        Err(_) => return !account_bound,
    };
    owners.retain(|_, owner| owner.last_used.elapsed() < OWNER_IDLE_TIMEOUT);
    if account_bound && owners.get(scope).is_some_and(|owner| owner.id != account) {
        return false;
    }
    if !owners.contains_key(scope) && owners.len() >= MAX_TRACKED_OWNERS {
        let oldest = owners
            .iter()
            .min_by_key(|(_, owner)| owner.last_used)
            .map(|(scope, _)| scope.clone());
        if let Some(oldest) = oldest {
            owners.remove(&oldest);
        }
    }
    owners.insert(
        scope.clone(),
        AccountUse {
            id: account.into(),
            last_used: Instant::now(),
        },
    );
    true
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

pub(super) struct Lease(Option<Scope>);

type Cache = HashMap<Scope, Slot>;

impl Lease {
    pub(super) fn take(scope: Scope) -> Result<(Self, Option<Connection>), &'static str> {
        let mut cache = cache().lock().map_err(|_| "cache_unavailable")?;
        cache.retain(|_, slot| match slot {
            Slot::Idle { since, .. } => since.elapsed() < IDLE_TIMEOUT,
            Slot::Leased { .. } => true,
        });
        if let Some(Slot::Leased { invalidated }) = cache.get_mut(&scope) {
            *invalidated = true;
            return Err("conversation_busy");
        }
        if !cache.contains_key(&scope) && cache.len() >= MAX_CONNECTIONS {
            evict_idle(&mut cache)?;
        }
        let prior = cache.insert(scope.clone(), Slot::Leased { invalidated: false });
        let connection = match prior {
            Some(Slot::Idle { connection, .. }) => Some(*connection),
            _ => None,
        };
        Ok((Self(Some(scope)), connection))
    }

    pub(super) fn retain(mut self, connection: Connection) {
        if let Ok(mut cache) = cache().lock() {
            let scope = self.0.as_ref().expect("active cache lease");
            if let Some(slot @ Slot::Leased { invalidated: false }) = cache.get_mut(scope) {
                *slot = Slot::Idle {
                    connection: Box::new(connection),
                    since: Instant::now(),
                };
                self.0 = None;
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let Some(scope) = self.0.take() else { return };
        if let Ok(mut cache) = cache().lock() {
            cache.remove(&scope);
        }
    }
}

fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn evict_idle(cache: &mut Cache) -> Result<(), &'static str> {
    let oldest = cache
        .iter()
        .filter_map(|(scope, slot)| match slot {
            Slot::Idle { since, .. } => Some((scope, since)),
            Slot::Leased { .. } => None,
        })
        .min_by_key(|(_, since)| *since)
        .map(|(scope, _)| scope.clone())
        .ok_or("cache_full")?;
    cache.remove(&oldest);
    Ok(())
}

pub(super) fn invalidate(scope: &Scope) {
    let Ok(mut cache) = cache().lock() else {
        return;
    };
    match cache.get_mut(scope) {
        Some(Slot::Leased { invalidated }) => *invalidated = true,
        Some(Slot::Idle { .. }) => {
            cache.remove(scope);
        }
        None => {}
    }
}

pub(super) fn clear(gui: bool) {
    if let Ok(mut owners) = OWNERS.get_or_init(Mutex::default).lock() {
        owners.retain(|scope, _| scope.gui != gui);
    }
    let Ok(mut cache) = cache().lock() else {
        return;
    };
    cache.retain(|scope, slot| {
        if scope.gui != gui {
            return true;
        }
        if let Slot::Leased { invalidated } = slot {
            *invalidated = true;
            return true;
        }
        false
    });
}
