//! Work stealing preserves completed blocks when one source disappears. Origin joins after a short grace period.
use super::{
    block_protocol,
    checkpoint::Checkpoint,
    origin_blocks::Origin,
    policy::Metrics,
    signaling::Lease,
    snapshot::{Manifest, BLOCK_BYTES},
    Error, Result,
};
use futures_util::{future::BoxFuture, stream::FuturesUnordered, FutureExt, StreamExt};
use std::{sync::atomic::Ordering, time::Duration};

const ORIGIN_DELAY: Duration = Duration::from_secs(2);
const BLOCK_TIMEOUT: Duration = Duration::from_secs(25);
const STEAL_DELAY: Duration = Duration::from_secs(2);

enum Event {
    Ready(Manifest),
    Origin(usize),
    Block(usize, Vec<u8>),
}
type Job<'a> = BoxFuture<'a, (usize, Result<Event>)>;

struct Plan {
    size: usize,
    done: Vec<bool>,
    busy: Vec<Option<(usize, tokio::time::Instant)>>,
    disabled: Vec<bool>,
    completed: usize,
}

impl Plan {
    fn new(size: usize, sources: usize) -> Self {
        Self {
            size,
            done: vec![false; size.div_ceil(BLOCK_BYTES)],
            busy: vec![None; sources],
            disabled: vec![false; sources],
            completed: 0,
        }
    }

    fn next(&self, source: usize) -> Option<usize> {
        if self.disabled[source] || self.busy[source].is_some() {
            return None;
        }
        let pending = self.done.iter().enumerate().find(|(index, done)| {
            !**done && !self.busy.iter().flatten().any(|(busy, _)| busy == index)
        });
        if let Some((index, _)) = pending {
            return Some(index);
        }
        self.busy
            .iter()
            .flatten()
            .find(|(index, started)| {
                !self.done[*index]
                    && started.elapsed() >= STEAL_DELAY
                    && self
                        .busy
                        .iter()
                        .flatten()
                        .filter(|(busy, _)| busy == index)
                        .count()
                        == 1
            })
            .map(|(index, _)| *index)
    }

    fn length(&self, index: usize) -> usize {
        BLOCK_BYTES.min(self.size - index * BLOCK_BYTES)
    }
}

pub(super) async fn download(
    leases: &[Lease],
    artifact: &super::cache::Artifact,
    service: &super::Service,
    mut progress: impl FnMut(usize, Option<u64>),
) -> Result<Vec<u8>> {
    let metrics = &service.policy.metrics;
    let origin = Origin::new(&artifact.url)?;
    let mut jobs: FuturesUnordered<Job<'_>> = FuturesUnordered::new();
    let mut manifests = vec![None; leases.len()];
    for (source, lease) in leases.iter().enumerate() {
        jobs.push(
            async move {
                (
                    source,
                    block_protocol::manifest(&lease.connection, &artifact.id)
                        .await
                        .map(Event::Ready),
                )
            }
            .boxed(),
        );
    }
    let origin_ref = &origin;
    jobs.push(
        async move {
            if !leases.is_empty() {
                tokio::time::sleep(ORIGIN_DELAY).await;
            }
            (leases.len(), origin_ref.size().await.map(Event::Origin))
        }
        .boxed(),
    );
    let mut state = Download {
        directory: service.cache.partial_directory(),
        id: artifact.id.clone(),
        plan: None,
        destination: None,
        origin_ready: false,
        failed: vec![false; leases.len() + 1],
    };
    while !jobs.is_empty() {
        tokio::select! {
            Some((source, result)) = jobs.next() => {
                if result.is_err() && source < leases.len() { leases[source].failed(); }
                state.accept((source, result), &mut manifests, Report {
                    expected_size: artifact.size, metrics, progress: &mut progress,
                }).await?;
            }
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
        let Some(plan) = state.plan.as_mut() else {
            continue;
        };
        if plan.completed == plan.done.len() {
            for (source, lease) in leases.iter().enumerate() {
                if plan.busy[source].is_some_and(|(_, started)| started.elapsed() >= STEAL_DELAY) {
                    lease.failed();
                    metrics.failures.fetch_add(1, Ordering::Relaxed);
                }
            }
            drop(jobs);
            return state
                .destination
                .ok_or(Error::Invalid)?
                .finish(plan.size)
                .await;
        }
        schedule(
            &mut jobs,
            plan,
            (&manifests, leases),
            (&origin, state.origin_ready, metrics),
        );
    }
    Err(Error::Unavailable)
}

struct Download {
    plan: Option<Plan>,
    destination: Option<std::sync::Arc<Checkpoint>>,
    directory: std::path::PathBuf,
    id: String,
    origin_ready: bool,
    failed: Vec<bool>,
}

struct Report<'a, F> {
    expected_size: usize,
    metrics: &'a Metrics,
    progress: &'a mut F,
}

impl Download {
    async fn accept<F: FnMut(usize, Option<u64>)>(
        &mut self,
        (source, result): (usize, Result<Event>),
        manifests: &mut [Option<Manifest>],
        report: Report<'_, F>,
    ) -> Result<()> {
        let Report {
            expected_size,
            metrics,
            progress,
        } = report;
        let event = match result {
            Ok(event) => event,
            Err(_) => {
                self.failed[source] = true;
                metrics.failures.fetch_add(1, Ordering::Relaxed);
                if let Some(plan) = &mut self.plan {
                    if plan.busy[source].take().is_some() {
                        metrics.retries.fetch_add(1, Ordering::Relaxed);
                    }
                    plan.disabled[source] = true;
                }
                return Ok(());
            }
        };
        match event {
            Event::Ready(manifest) => {
                let restored = self.initialize(manifest.size, expected_size).await?;
                progress(restored, Some(manifest.size as u64));
                manifests[source] = Some(manifest);
            }
            Event::Origin(size) => {
                let restored = self.initialize(size, expected_size).await?;
                progress(restored, Some(size as u64));
                self.origin_ready = true;
            }
            Event::Block(index, bytes) => {
                let plan = self.plan.as_mut().ok_or(Error::Invalid)?;
                plan.busy[source] = None;
                if plan.done[index] {
                    return Ok(());
                }
                let length = bytes.len();
                self.destination
                    .as_ref()
                    .ok_or(Error::Invalid)?
                    .write(index, bytes)
                    .await?;
                plan.done[index] = true;
                plan.completed += 1;
                let counter = if source == manifests.len() {
                    &metrics.origin_bytes
                } else {
                    &metrics.peer_bytes
                };
                counter.fetch_add(length as u64, Ordering::Relaxed);
                progress(length, Some(plan.size as u64));
            }
        }
        Ok(())
    }

    async fn initialize(&mut self, size: usize, expected: usize) -> Result<usize> {
        if size == 0 || size > super::MAX_PACKAGE_BYTES || (expected != 0 && expected != size) {
            return Err(Error::Invalid);
        }
        if let Some(plan) = &self.plan {
            return if plan.size == size {
                Ok(0)
            } else {
                Err(Error::Invalid)
            };
        }
        let mut plan = Plan::new(size, self.failed.len());
        let (destination, done) =
            Checkpoint::open(self.directory.clone(), self.id.clone(), size).await?;
        plan.done = done;
        plan.completed = plan.done.iter().filter(|done| **done).count();
        let restored = plan
            .done
            .iter()
            .enumerate()
            .filter(|(_, done)| **done)
            .map(|(index, _)| plan.length(index))
            .sum();
        plan.disabled.clone_from(&self.failed);
        self.plan = Some(plan);
        self.destination = Some(destination);
        Ok(restored)
    }
}

fn schedule<'a>(
    jobs: &mut FuturesUnordered<Job<'a>>,
    plan: &mut Plan,
    peers: (&[Option<Manifest>], &'a [Lease]),
    origin: (&'a Origin, bool, &Metrics),
) {
    for source in 0..plan.busy.len() {
        let Some(index) = plan.next(source) else {
            continue;
        };
        let length = plan.length(index);
        let size = plan.size;
        let operation: BoxFuture<'a, Result<Vec<u8>>> = if source == peers.1.len() {
            if !origin.1 {
                continue;
            }
            async move { origin.0.block(index * BLOCK_BYTES, length, size).await }.boxed()
        } else {
            let Some(manifest) = peers.0[source].clone() else {
                continue;
            };
            async move { block_protocol::block(&peers.1[source].connection, &manifest, index).await }.boxed()
        };
        if plan.busy.iter().flatten().any(|(busy, _)| *busy == index) {
            origin.2.retries.fetch_add(1, Ordering::Relaxed);
        }
        plan.busy[source] = Some((index, tokio::time::Instant::now()));
        jobs.push(
            async move {
                let result = tokio::time::timeout(BLOCK_TIMEOUT, operation)
                    .await
                    .map_err(|_| Error::Unavailable)
                    .and_then(|value| value);
                (source, result.map(|bytes| Event::Block(index, bytes)))
            }
            .boxed(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_source_releases_only_its_unfinished_block() {
        let mut plan = Plan::new(BLOCK_BYTES * 3, 3);
        plan.done[0] = true;
        plan.completed = 1;
        plan.busy[0] = Some((1, tokio::time::Instant::now()));
        assert_eq!(plan.next(1), Some(2));
        plan.busy[0] = None;
        plan.disabled[0] = true;
        assert_eq!(plan.next(1), Some(1));
        assert!(plan.done[0]);
    }
    #[test]
    fn idle_source_can_take_over_a_slow_final_block() {
        let mut plan = Plan::new(BLOCK_BYTES, 3);
        plan.busy[0] = Some((0, tokio::time::Instant::now() - STEAL_DELAY));
        assert_eq!(plan.next(1), Some(0));
        plan.busy[1] = Some((0, tokio::time::Instant::now()));
        assert_eq!(plan.next(2), None);
    }
}
