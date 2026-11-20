use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use uuid::Uuid;

use super::super::{
    collect_rollout_paths, first_rollout_value, latest_state_db, logical_rollout_path,
    preferred_rollout_path, rollout_reader, snapshot_id, ROLLOUT_FOLDERS,
};
use super::{Activity, ActivityTotals};

const MAX_CHAIN: usize = 64;
const MAX_LINE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}

impl Stamp {
    fn read(path: &Path) -> Option<Self> {
        let meta = fs::metadata(path).ok()?;
        Some(Self {
            len: meta.len(),
            modified: meta.modified().ok(),
            created: meta.created().ok(),
        })
    }
}

pub(super) struct Snapshot {
    path: PathBuf,
    stamp: Stamp,
    offset: u64,
    activity: Activity,
}

impl Snapshot {
    pub(super) fn totals(&self) -> ActivityTotals {
        self.activity.totals()
    }
}

fn indexed_path(home: &Path, id: Uuid) -> Option<PathBuf> {
    let db = latest_state_db(home)?;
    let connection = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    connection.busy_timeout(Duration::from_millis(75)).ok()?;
    let path: String = connection
        .query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1",
            [id.to_string()],
            |row| row.get(0),
        )
        .ok()?;
    verified_path(home, Path::new(&path))
}

fn verified_path(home: &Path, path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let path = preferred_rollout_path(&logical_rollout_path(path)?)?;
    let canonical = fs::canonicalize(path).ok()?;
    (logical_rollout_path(&canonical).is_some()
        && ROLLOUT_FOLDERS
            .iter()
            .any(|folder| canonical.starts_with(home.join(folder))))
    .then_some(canonical)
}

fn physical_id(path: &Path) -> Option<Uuid> {
    let logical = logical_rollout_path(path)?;
    let name = logical.file_stem()?.to_str()?;
    Uuid::parse_str(name.get(name.len().checked_sub(36)?..)?).ok()
}

fn linked_path(home: &Path, files: &[PathBuf], id: Uuid) -> Option<PathBuf> {
    let mut matches = files.iter().filter(|path| physical_id(path) == Some(id));
    let first = matches.next()?;
    if matches.any(|path| path != first) {
        return None;
    }
    verified_path(home, first)
}

struct Segment {
    path: PathBuf,
    // An older segment of the same conversation contributes only bytes before the next segment.
    cutoff: Option<u64>,
    owner: String,
}

fn segments(home: &Path, path: PathBuf, id: Uuid) -> Option<Vec<Segment>> {
    let mut chain: Vec<Segment> = Vec::new();
    let mut files = None;
    let mut path = path;
    let mut cutoff = None;
    loop {
        if chain.len() >= MAX_CHAIN || chain.iter().any(|segment| segment.path == path) {
            return None;
        }
        let meta = first_rollout_value(&path).ok()??;
        let owner = snapshot_id(&meta)?;
        if Uuid::parse_str(&owner).ok()? != id {
            if chain.is_empty() {
                return None;
            }
            // A fork may display its parent's history, but that work belongs to the parent.
            break;
        }
        chain.push(Segment {
            path,
            cutoff,
            owner,
        });
        let base = &meta["payload"]["history_base"];
        if base.is_null() {
            break;
        }
        let linked_id = Uuid::parse_str(base["thread_id"].as_str()?).ok()?;
        if linked_id != id
            && meta["payload"]["forked_from_id"]
                .as_str()
                .and_then(|parent| Uuid::parse_str(parent).ok())
                == Some(linked_id)
        {
            break;
        }
        cutoff = Some(base["end_byte_offset"].as_u64()?);
        if cutoff == Some(0) {
            break;
        }
        if files.is_none() {
            let mut paths = Vec::new();
            for folder in ROLLOUT_FOLDERS {
                collect_rollout_paths(&home.join(folder), &mut paths).ok()?;
            }
            files = Some(paths);
        }
        path = linked_path(home, files.as_ref()?, linked_id)?;
    }
    chain.reverse();
    Some(chain)
}

pub(super) fn refresh(home: &Path, id: Uuid, snapshot: Option<Snapshot>) -> Option<Snapshot> {
    let home = fs::canonicalize(home).ok()?;
    let path = indexed_path(&home, id)?;
    let stamp = Stamp::read(&path)?;
    let compressed = path.extension().is_some_and(|part| part == "zst");
    if let Some(mut old) =
        snapshot.filter(|old| old.path == path && old.stamp.created == stamp.created)
    {
        if old.stamp == stamp {
            return Some(old);
        }
        if !compressed && stamp.len > old.stamp.len {
            old.offset += append(&path, id, old.offset, stamp.len, &mut old.activity).ok()?;
            old.stamp = stamp;
            return Some(old);
        }
    }
    let mut activity = Activity::default();
    let mut offset = 0;
    for segment in segments(&home, path.clone(), id)? {
        if let Some(cutoff) = segment.cutoff {
            let reader = rollout_reader(&segment.path).ok()?.take(cutoff);
            if read_records(reader, &segment.owner, &mut activity).ok()? != cutoff {
                return None;
            }
        } else if compressed {
            read_records(
                rollout_reader(&segment.path).ok()?,
                &segment.owner,
                &mut activity,
            )
            .ok()?;
        } else {
            offset = append(&path, id, 0, stamp.len, &mut activity).ok()?;
        }
    }
    Some(Snapshot {
        path,
        stamp,
        offset,
        activity,
    })
}

fn append(path: &Path, id: Uuid, offset: u64, end: u64, stats: &mut Activity) -> io::Result<u64> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    read_records(
        BufReader::new(file).take(end - offset),
        &id.to_string(),
        stats,
    )
}

fn read_records(mut reader: impl BufRead, owner: &str, stats: &mut Activity) -> io::Result<u64> {
    let mut consumed = 0;
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        let count = Read::by_ref(&mut reader)
            .take(MAX_LINE_BYTES + 1)
            .read_until(b'\n', &mut bytes)?;
        if count as u64 > MAX_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Oversized Codex history record",
            ));
        }
        // An actively written final line is picked up on the next refresh from its starting offset.
        if bytes.last() != Some(&b'\n') {
            break;
        }
        consumed += count as u64;
        if let Ok(line) = std::str::from_utf8(&bytes) {
            if line.contains("\"token_usage_record\"") || line.contains("\"item_completed\"") {
                if let Ok(record) = serde_json::from_str(line) {
                    apply(record, owner, stats);
                }
            }
        }
    }
    Ok(consumed)
}

#[derive(Deserialize)]
struct Record<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(borrow)]
    payload: Payload<'a>,
}

#[derive(Deserialize)]
struct Payload<'a> {
    #[serde(rename = "type")]
    kind: Option<&'a str>,
    thread_id: Option<&'a str>,
    turn_id: Option<&'a str>,
    response_id: Option<&'a str>,
    usage: Option<serde_json::Value>,
    #[serde(borrow)]
    item: Option<Item<'a>>,
}

#[derive(Deserialize)]
struct Item<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    id: Option<&'a str>,
    status: Option<&'a str>,
    exit_code: Option<i64>,
}

fn apply(record: Record<'_>, owner: &str, stats: &mut Activity) {
    let payload = record.payload;
    if payload.thread_id != Some(owner) {
        return;
    }
    let Some(turn) = payload.turn_id.filter(|turn| !turn.is_empty()) else {
        return;
    };
    match (record.kind, payload.kind) {
        ("token_usage_record", _) => {
            if let Some(response) = payload.response_id.filter(|id| !id.is_empty()) {
                if stats.responses.insert(response.to_owned()) {
                    stats.turns.insert(turn.to_owned());
                    // Per-response usage covers this chat's own requests. thread_token_usage is
                    // cumulative and can already include the fork parent's baseline.
                    stats.usage.add(payload.usage.as_ref());
                }
            }
        }
        ("event_msg", Some("item_completed")) => {
            let Some(item) = payload.item.filter(|item| item.kind == "CommandExecution") else {
                return;
            };
            if let Some(id) = item.id.filter(|id| !id.is_empty()) {
                let key = (turn.to_owned(), id.to_owned());
                // Same outcome rules as the Remote AI chat CommandMetrics.
                let result = match (item.status, item.exit_code) {
                    (Some("failed"), _) => Some(false),
                    (Some("completed"), Some(code)) => Some(code == 0),
                    _ => None,
                };
                if let Some(success) = result {
                    stats.commands.insert(key, success);
                } else {
                    stats.commands.remove(&key);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests;
