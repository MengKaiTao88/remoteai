//! Local ownership of official Responses artifacts. Store only hashes of
//! conversation identifiers and artifacts, never request or response content.
use super::{
    account_context::{self, Error},
    cache::Scope,
    request::{self, Fingerprint},
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::time::Duration;

const DATABASE_FILE: &str = "official-responses-context.sqlite3";
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS routes (
    scope BLOB PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    mixed INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS artifacts (
    scope BLOB NOT NULL,
    digest BLOB NOT NULL,
    account_id TEXT NOT NULL,
    PRIMARY KEY (scope, digest, account_id)
) WITHOUT ROWID;
";

pub(super) struct ContextStore {
    connection: Connection,
    scope: Fingerprint,
    account: String,
}

#[derive(Default)]
pub(super) struct Projection {
    pub(super) body_changed: bool,
    pub(super) strip_routing_hint: bool,
    pub(super) strip_turn_state: bool,
}

struct Route {
    account: String,
    mixed: bool,
}

impl ContextStore {
    pub(super) fn open(scope: &Scope, account: &str, create: bool) -> Result<Option<Self>, Error> {
        let path = scope.workspace.join(DATABASE_FILE);
        if !create
            && !path
                .try_exists()
                .map_err(|_| rusqlite::Error::InvalidPath(path.clone()))?
        {
            return Ok(None);
        }
        let digest =
            request::fingerprint(&(scope.gui, &scope.lan_key, scope.client_auth, &scope.session))
                .ok_or(rusqlite::Error::InvalidQuery)?;
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(2))?;
        connection.execute_batch(SCHEMA)?;
        if !create && read_route(&connection, &digest)?.is_none() {
            return Ok(None);
        }
        Ok(Some(Self {
            connection,
            scope: digest,
            account: account.into(),
        }))
    }

    pub(super) fn project(
        &mut self,
        options: Option<&mut Map<String, Value>>,
        has_turn_state: bool,
    ) -> Result<Projection, Error> {
        let connection = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_route(&connection, &self.scope)?;
        let changed_owner = previous
            .as_ref()
            .is_some_and(|route| route.account != self.account);
        let mixed = previous.as_ref().is_some_and(|route| route.mixed) || changed_owner;
        let mut projection = Projection {
            strip_routing_hint: changed_owner,
            strip_turn_state: changed_owner && has_turn_state,
            ..Projection::default()
        };
        if let Some(options) = options {
            let owns = |digest: &Fingerprint| {
                artifact_owner(&connection, &self.scope, &self.account, digest)
                    .map(|known| known.unwrap_or(false))
            };
            projection.body_changed = account_context::project(options, &owns)?;
            if (previous.is_none() || mixed) && projection.body_changed {
                // On upgrade, a self-contained request can carry older opaque
                // history even before this proxy has saved a route for it.
                projection.strip_routing_hint = true;
                projection.strip_turn_state = has_turn_state;
            }
            if (changed_owner || projection.strip_turn_state) && !request::replay_safe(options) {
                return Err(Error::Bound);
            }
        } else if mixed {
            return Err(Error::InvalidBody);
        }
        match previous {
            None => write_route(
                &connection,
                &self.scope,
                &self.account,
                projection.body_changed,
            )?,
            Some(previous) if changed_owner && !previous.mixed => {
                // Keep the confirmed owner until upstream accepts the new
                // request. Record the boundary before sending upstream.
                write_route(&connection, &self.scope, &previous.account, true)?;
            }
            Some(_) => {}
        }
        connection.commit()?;
        Ok(projection)
    }

    pub(super) fn record(&self, event: &Value) {
        if self.observe(event).is_err() {
            super::diagnostic_event(json!({"event":"official_responses_ownership_write_failed"}));
        }
    }

    fn observe(&self, event: &Value) -> rusqlite::Result<()> {
        let artifacts = account_context::response_artifacts(event);
        if artifacts.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "UPDATE routes
             SET mixed = mixed OR account_id <> ?2, account_id = ?2
             WHERE scope = ?1",
            params![&self.scope[..], self.account],
        )?;
        {
            let mut insert = transaction.prepare_cached(
                "INSERT OR IGNORE INTO artifacts (scope, digest, account_id) VALUES (?1, ?2, ?3)",
            )?;
            for digest in artifacts {
                insert.execute(params![&self.scope[..], &digest[..], self.account])?;
            }
        }
        transaction.commit()
    }
}

fn read_route(connection: &Connection, scope: &Fingerprint) -> rusqlite::Result<Option<Route>> {
    connection
        .query_row(
            "SELECT account_id, mixed FROM routes WHERE scope = ?1",
            params![&scope[..]],
            |row| {
                Ok(Route {
                    account: row.get(0)?,
                    mixed: row.get(1)?,
                })
            },
        )
        .optional()
}

fn write_route(
    connection: &Connection,
    scope: &Fingerprint,
    account: &str,
    mixed: bool,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO routes (scope, account_id, mixed) VALUES (?1, ?2, ?3)
         ON CONFLICT (scope) DO UPDATE SET account_id = excluded.account_id, mixed = excluded.mixed",
        params![&scope[..], account, mixed],
    )?;
    Ok(())
}

fn artifact_owner(
    connection: &Connection,
    scope: &Fingerprint,
    account: &str,
    digest: &Fingerprint,
) -> rusqlite::Result<Option<bool>> {
    connection
        .prepare_cached(
            "SELECT MAX(account_id = ?3) FROM artifacts WHERE scope = ?1 AND digest = ?2",
        )?
        .query_row(params![&scope[..], &digest[..], account], |row| row.get(0))
}
