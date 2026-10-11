use crate::error::{Error, Result};
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone)]
pub struct Database {
    root: PathBuf,
}

impl Database {
    /// One connection per operation: model inference and HTTP calls never hold a database lock.
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        let db = Self {
            root: root.to_owned(),
        };
        let mut conn = db.connect()?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let version: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > 1 {
            return Err(Error::Invalid);
        }
        if version == 0 {
            let tx = conn.transaction()?;
            tx.execute_batch(include_str!("schema.sql"))?;
            tx.pragma_update(None, "user_version", 1)?;
            tx.commit()?;
        }
        Ok(db)
    }

    pub fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(self.root.join("coze.sqlite3"))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}
