static RUNTIME: OnceLock<Mutex<Option<ProxyRuntime>>> = OnceLock::new();
static TOKEN_USAGE_DB_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static AUTO_SWITCH_COORDINATOR: OnceLock<AutoSwitchCoordinator> = OnceLock::new();
static PROXY_SESSIONS: OnceLock<Mutex<HashMap<String, ProxySessionState>>> = OnceLock::new();
static CONCURRENT_ACCOUNT_ROUTER: OnceLock<Mutex<ConcurrentAccountRouter>> = OnceLock::new();

#[derive(Default)]
struct ConcurrentAccountRouter {
    assignments: HashMap<String, String>,
}

impl ConcurrentAccountRouter {
    fn account_for_session(
        &mut self,
        session_id: &str,
        eligible_account_ids: &[String],
        preferred_account_ids: &[String],
    ) -> Option<String> {
        // Priority changes affect new assignments, not healthy existing conversations.
        // Keep every eligible account here, including those outside the preferred tier.
        if let Some(account_id) = self.assignments.get(session_id) {
            if eligible_account_ids
                .iter()
                .any(|candidate| candidate == account_id)
            {
                return Some(account_id.clone());
            }
        }
        if preferred_account_ids.is_empty() {
            self.assignments.remove(session_id);
            return None;
        }
        self.assignments.remove(session_id);
        let mut conversation_counts = preferred_account_ids
            .iter()
            .map(|account_id| (account_id.as_str(), 0_usize))
            .collect::<HashMap<_, _>>();
        for account_id in self.assignments.values() {
            if let Some(count) = conversation_counts.get_mut(account_id.as_str()) {
                *count = count.saturating_add(1);
            }
        }
        let account_id = preferred_account_ids
            .iter()
            .min_by_key(|account_id| {
                conversation_counts
                    .get(account_id.as_str())
                    .copied()
                    .unwrap_or(0)
            })?
            .clone();
        self.assignments
            .insert(session_id.to_string(), account_id.clone());
        Some(account_id)
    }

    fn clear(&mut self) {
        self.assignments.clear();
    }
}

#[derive(Default)]
struct AutoSwitchCoordinator {
    state: Mutex<AutoSwitchState>,
    attempt: Mutex<()>,
}

#[derive(Default)]
struct AutoSwitchState {
    // The account generation advances only after a real automatic switch. The attempt
    // generation also advances after no-op/error outcomes so requests that were already
    // in flight do not repeat the same expensive refresh after waiting for the lock.
    active_account_generation: u64,
    switch_attempt_generation: u64,
    last_attempt: Option<CompletedAutoSwitchAttempt>,
}

struct CompletedAutoSwitchAttempt {
    observed_generation: u64,
    failed_account_id: String,
    should_retry: bool,
    requirements: Option<AutoSwitchRequirements>,
}

struct AutoSwitchObservation<'a> {
    generation: u64,
    attempt_generation: u64,
    failed_account_id: &'a str,
    requirements: Option<&'a AutoSwitchRequirements>,
}

enum AutoSwitchAttempt {
    Unchanged,
    AlreadyChanged,
    Switched,
}

impl AutoSwitchCoordinator {
    fn recover_state<'a>(
        &'a self,
        mut state: MutexGuard<'a, AutoSwitchState>,
    ) -> MutexGuard<'a, AutoSwitchState> {
        // A panic can happen after the account state was written but before the
        // coordinator published it. Advance both generations conservatively so old
        // responses only retry, then keep ordinary official proxying available.
        state.active_account_generation = state.active_account_generation.wrapping_add(1);
        state.switch_attempt_generation = state.switch_attempt_generation.wrapping_add(1);
        state.last_attempt = None;
        self.state.clear_poison();
        state
    }

    fn lock_state(&self) -> MutexGuard<'_, AutoSwitchState> {
        match self.state.lock() {
            Ok(state) => state,
            Err(error) => self.recover_state(error.into_inner()),
        }
    }

    #[cfg(test)]
    fn active_account_generation(&self) -> u64 {
        self.lock_state().active_account_generation
    }

    fn account_snapshot<T, F>(&self, snapshot: F) -> Result<(u64, u64, T), String>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let state = self.lock_state();
        let value = snapshot()?;
        Ok((
            state.active_account_generation,
            state.switch_attempt_generation,
            value,
        ))
    }

    #[cfg(test)]
    fn switch_or_wait<F>(
        &self,
        observed_generation: u64,
        observed_attempt_generation: u64,
        failed_account_id: &str,
        switch: F,
    ) -> Result<bool, String>
    where
        F: FnOnce() -> Result<AutoSwitchAttempt, String>,
    {
        self.switch_or_wait_with_waiter_hook(
            observed_generation,
            observed_attempt_generation,
            failed_account_id,
            switch,
            || {},
        )
    }

    #[cfg(test)]
    fn switch_or_wait_with_waiter_hook<F, W>(
        &self,
        observed_generation: u64,
        observed_attempt_generation: u64,
        failed_account_id: &str,
        switch: F,
        waiter_hook: W,
    ) -> Result<bool, String>
    where
        F: FnOnce() -> Result<AutoSwitchAttempt, String>,
        W: FnOnce(),
    {
        self.switch_for(
            AutoSwitchObservation {
                generation: observed_generation,
                attempt_generation: observed_attempt_generation,
                failed_account_id,
                requirements: None,
            },
            switch,
            waiter_hook,
        )
    }

    fn switch_for<F, W>(
        &self,
        observation: AutoSwitchObservation<'_>,
        switch: F,
        waiter_hook: W,
    ) -> Result<bool, String>
    where
        F: FnOnce() -> Result<AutoSwitchAttempt, String>,
        W: FnOnce(),
    {
        let _attempt = self.lock_attempt(waiter_hook);
        let state = self.lock_state();
        if let Some(outcome) = state.completed_outcome(&observation) {
            return Ok(outcome);
        }
        // Discovery and quota refresh may make network requests. Keep the
        // switch serialized while other requests can still read route snapshots.
        drop(state);
        let result = switch();
        self.lock_state().finish_attempt(observation, result)
    }

    fn lock_attempt(&self, waiter_hook: impl FnOnce()) -> MutexGuard<'_, ()> {
        let lock = match self.attempt.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => {
                waiter_hook();
                return self.attempt.lock().unwrap_or_else(|error| {
                    self.attempt.clear_poison();
                    drop(self.recover_state(self.lock_state()));
                    error.into_inner()
                });
            }
            Err(TryLockError::Poisoned(error)) => {
                let lock = error.into_inner();
                self.attempt.clear_poison();
                drop(self.recover_state(self.lock_state()));
                lock
            }
        };
        lock
    }
}

impl AutoSwitchState {
    fn completed_outcome(&self, observation: &AutoSwitchObservation<'_>) -> Option<bool> {
        if self.active_account_generation != observation.generation {
            return Some(true);
        }
        if self.switch_attempt_generation == observation.attempt_generation {
            return None;
        }
        let last = self.last_attempt.as_ref()?;
        (last.observed_generation == observation.generation
            && last.failed_account_id == observation.failed_account_id
            && last.requirements.as_ref() == observation.requirements)
            .then_some(last.should_retry)
    }

    fn finish_attempt(
        &mut self,
        observation: AutoSwitchObservation<'_>,
        result: Result<AutoSwitchAttempt, String>,
    ) -> Result<bool, String> {
        self.switch_attempt_generation = self.switch_attempt_generation.wrapping_add(1);
        if matches!(result, Ok(AutoSwitchAttempt::Switched)) {
            self.active_account_generation = self.active_account_generation.wrapping_add(1);
        }
        let should_retry = matches!(
            result,
            Ok(AutoSwitchAttempt::AlreadyChanged | AutoSwitchAttempt::Switched)
        );
        self.last_attempt = Some(CompletedAutoSwitchAttempt {
            observed_generation: observation.generation,
            failed_account_id: observation.failed_account_id.to_string(),
            should_retry,
            requirements: observation.requirements.cloned(),
        });
        result.map(|_| should_retry)
    }
}
