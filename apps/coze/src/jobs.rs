//! Bounded background work with sequenced events and cooperative cancellation.
use crate::error::{Error, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;

const MAX_JOBS: usize = 64;
const MAX_ACTIVE: usize = 8;
const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENTS: usize = 32_768;
const PAGE_SIZE: usize = 256;
const RETENTION: Duration = Duration::from_secs(3600);

#[derive(Clone, Default)]
pub struct JobControl {
    cancelled: Arc<AtomicBool>,
    wake: Arc<Notify>,
    events: Option<Arc<Mutex<Journal>>>,
}

impl JobControl {
    /// Share cancellation without retaining token events for non-conversational model work.
    pub fn without_events(&self) -> Self {
        Self {
            cancelled: self.cancelled.clone(),
            wake: self.wake.clone(),
            events: None,
        }
    }
    pub fn detached() -> Self {
        Self::default()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.wake.notify_one();
    }

    pub async fn cancelled(&self) {
        if !self.is_cancelled() {
            self.wake.notified().await;
        }
    }

    pub fn emit(&self, event: Value) -> Result<()> {
        self.check()?;
        let Some(events) = &self.events else {
            return Ok(());
        };
        let mut journal = events.lock().map_err(|_| Error::Conflict)?;
        let bytes = event.to_string().len();
        if journal.bytes + bytes > MAX_EVENT_BYTES || journal.events.len() >= MAX_EVENTS {
            return Err(Error::Limit);
        }
        let sequence = journal.events.len() as u64 + 1;
        journal.events.push(Event { sequence, event });
        journal.bytes += bytes;
        Ok(())
    }
}

#[derive(Clone, Serialize)]
struct Event {
    sequence: u64,
    event: Value,
}

#[derive(Default)]
struct Journal {
    events: Vec<Event>,
    bytes: usize,
}

struct Job {
    control: JobControl,
    status: &'static str,
    result: Option<Value>,
    error: Option<String>,
    finished: Option<Instant>,
}

#[derive(Clone, Default)]
pub struct JobManager {
    jobs: Arc<Mutex<HashMap<String, Job>>>,
}

impl JobManager {
    pub fn start(
        &self,
        task: impl FnOnce(JobControl) -> Result<Value> + Send + 'static,
    ) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let control = JobControl {
            events: Some(Arc::new(Mutex::new(Journal::default()))),
            ..Default::default()
        };
        {
            let mut jobs = self.jobs.lock().map_err(|_| Error::Conflict)?;
            jobs.retain(|_, job| job.finished.is_none_or(|time| time.elapsed() < RETENTION));
            if jobs.len() >= MAX_JOBS {
                let oldest = jobs
                    .iter()
                    .filter_map(|(id, job)| job.finished.map(|time| (id.clone(), time)))
                    .min_by_key(|(_, time)| *time);
                if let Some((id, _)) = oldest {
                    jobs.remove(&id);
                }
            }
            if jobs.len() >= MAX_JOBS
                || jobs.values().filter(|job| job.status == "running").count() >= MAX_ACTIVE
            {
                return Err(Error::Limit);
            }
            jobs.insert(
                id.clone(),
                Job {
                    control: control.clone(),
                    status: "running",
                    result: None,
                    error: None,
                    finished: None,
                },
            );
        }
        let manager = self.clone();
        let worker_id = id.clone();
        let spawn = std::thread::Builder::new()
            .name("coze-job".into())
            .spawn(move || {
                // A crashed worker must not occupy an active slot forever or expose panic details over IPC.
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task(control)))
                        .unwrap_or(Err(Error::Limit));
                manager.finish(&worker_id, result);
            });
        if spawn.is_err() {
            self.jobs.lock().map_err(|_| Error::Conflict)?.remove(&id);
            return Err(Error::Limit);
        }
        Ok(json!({"id":id}))
    }

    fn finish(&self, id: &str, result: Result<Value>) {
        let Ok(mut jobs) = self.jobs.lock() else {
            return;
        };
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        let cancelled = matches!(result, Err(Error::Cancelled)) || job.control.is_cancelled();
        job.status = if cancelled {
            "cancelled"
        } else if result.is_ok() {
            "completed"
        } else {
            "failed"
        };
        match result {
            Ok(value) => job.result = Some(value),
            Err(error) => job.error = Some(error.to_string()),
        }
        job.finished = Some(Instant::now());
    }

    pub fn status(&self, id: &str, after: u64) -> Result<Value> {
        let jobs = self.jobs.lock().map_err(|_| Error::Conflict)?;
        let job = jobs.get(id).ok_or(Error::NotFound)?;
        let journal = job
            .control
            .events
            .as_ref()
            .ok_or(Error::Invalid)?
            .lock()
            .map_err(|_| Error::Conflict)?;
        let events: Vec<_> = journal
            .events
            .iter()
            .filter(|event| event.sequence > after)
            .take(PAGE_SIZE)
            .collect();
        Ok(
            json!({"id":id,"status":job.status,"events":events,"lastSequence":journal.events.len(),
            "result":job.result,"error":job.error}),
        )
    }

    pub fn cancel(&self, id: &str) -> Result<Value> {
        let jobs = self.jobs.lock().map_err(|_| Error::Conflict)?;
        let job = jobs.get(id).ok_or(Error::NotFound)?;
        if job.status == "running" {
            job.control.cancel();
        }
        Ok(json!({"cancelled":true}))
    }
}
