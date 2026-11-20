//! Read-only conversation statistics for the official Codex composer.
mod history;

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::Serialize;

const REFRESH_INTERVAL: Duration = Duration::from_millis(1500);
const MISSING_INTERVAL: Duration = Duration::from_secs(8);
const CACHE_LIMIT: usize = 3;
const MAX_WORKERS: usize = 2;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityTotals {
    turns: Option<usize>,
    steps: Option<usize>,
    total_tokens: Option<u64>,
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    successful_command_count: usize,
    completed_command_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ConversationCounts {
    turns: usize,
    steps: usize,
}

impl ActivityTotals {
    pub(crate) fn counts(self) -> Option<ConversationCounts> {
        Some(ConversationCounts {
            turns: self.turns?,
            steps: self.steps?,
        })
    }
}

#[derive(Default)]
struct Activity {
    // Provider retries that are not a new recorded response do not add a step.
    responses: HashSet<String>,
    turns: HashSet<String>,
    commands: HashMap<(String, String), bool>,
    usage: UsageTotals,
}

struct UsageTotals {
    total: Option<u64>,
    input: Option<u64>,
    cached: Option<u64>,
}

impl Default for UsageTotals {
    fn default() -> Self {
        Self {
            total: Some(0),
            input: Some(0),
            cached: Some(0),
        }
    }
}

impl UsageTotals {
    fn add(&mut self, usage: Option<&serde_json::Value>) {
        let count = |key: &str| {
            usage
                .and_then(|value| value.get(key))
                .and_then(|value| value.as_u64())
        };
        let input = count("input_tokens");
        let total = count("total_tokens").or_else(|| {
            input
                .zip(count("output_tokens"))
                .and_then(|(a, b)| a.checked_add(b))
        });
        let cached = count("cached_input_tokens")
            .filter(|cached| input.is_some_and(|input| *cached <= input));
        // A missing count is unknown, not zero; never display a partial cumulative value as exact.
        self.total = self.total.zip(total).and_then(|(a, b)| a.checked_add(b));
        self.input = self.input.zip(input).and_then(|(a, b)| a.checked_add(b));
        self.cached = self.cached.zip(cached).and_then(|(a, b)| a.checked_add(b));
    }
}

impl Activity {
    fn totals(&self) -> ActivityTotals {
        let has_steps = !self.responses.is_empty();
        ActivityTotals {
            turns: has_steps.then_some(self.turns.len()),
            steps: has_steps.then_some(self.responses.len()),
            total_tokens: has_steps.then_some(self.usage.total).flatten(),
            input_tokens: has_steps.then_some(self.usage.input).flatten(),
            cached_input_tokens: has_steps.then_some(self.usage.cached).flatten(),
            successful_command_count: self.commands.values().filter(|&&success| success).count(),
            completed_command_count: self.commands.len(),
        }
    }
}

#[derive(Default)]
struct Entry {
    history: Option<history::Snapshot>,
    totals: Option<ActivityTotals>,
    checked: Option<Instant>,
    running: bool,
}

type Cache = HashMap<(PathBuf, uuid::Uuid), Entry>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

pub(crate) fn poll_official(thread_id: &str) -> Option<ActivityTotals> {
    let thread_id = thread_id.strip_prefix("local:").unwrap_or(thread_id);
    let id = uuid::Uuid::parse_str(thread_id).ok()?;
    let home = crate::codex_home::resolve_default().ok()?;
    poll(&home, id)
}

fn poll(home: &Path, id: uuid::Uuid) -> Option<ActivityTotals> {
    let key = (home.to_path_buf(), id);
    let cache = CACHE.get_or_init(Mutex::default);
    let mut locked = cache.lock().ok()?;
    let entry = locked.get(&key);
    let totals = entry.and_then(|entry| entry.totals);
    if entry.is_some_and(|entry| entry.running)
        || locked.values().filter(|entry| entry.running).count() >= MAX_WORKERS
        || entry.and_then(|entry| entry.checked).is_some_and(|time| {
            time.elapsed()
                < if totals.is_some() {
                    REFRESH_INTERVAL
                } else {
                    MISSING_INTERVAL
                }
        })
    {
        return totals;
    }
    if !locked.contains_key(&key) && locked.len() == CACHE_LIMIT {
        if let Some(oldest) = locked
            .iter()
            .filter(|(_, entry)| !entry.running)
            .min_by_key(|(_, entry)| entry.checked)
            .map(|(key, _)| key.clone())
        {
            locked.remove(&oldest);
        }
    }
    let entry = locked.entry(key.clone()).or_default();
    let snapshot = entry.history.take();
    entry.running = true;
    let worker_key = key.clone();
    // Scanning a long conversation must not hold up the renderer binding or the UI.
    if std::thread::Builder::new()
        .name("codex-conversation-activity".into())
        .spawn(move || {
            let history = history::refresh(&worker_key.0, worker_key.1, snapshot);
            let totals = history.as_ref().map(history::Snapshot::totals);
            if let Ok(mut locked) = cache.lock() {
                locked.insert(
                    worker_key,
                    Entry {
                        history,
                        totals,
                        checked: Some(Instant::now()),
                        running: false,
                    },
                );
            }
        })
        .is_err()
    {
        if let Some(entry) = locked.get_mut(&key) {
            entry.running = false;
        }
    }
    totals
}
