use super::{
    account_selection, choose, ensure_current, initial, official_recovery_routing, settings,
    with_routing, AutoSwitchError, ChoiceRequest, Exhaustion, GuiAccountSelection, Route,
    EXHAUSTED_COOLDOWN,
};
use std::{collections::HashSet, time::Instant};
use tauri::{AppHandle, Runtime};

pub(in crate::local_proxy) fn after_quota<R: Runtime>(
    app: &AppHandle<R>,
    route: &Route,
    session: Option<&str>,
    failed: &HashSet<String>,
) -> Result<Option<Route>, AutoSwitchError> {
    after_failure(
        app,
        route,
        ChoiceRequest {
            session,
            failed,
            explicit_quota: true,
        },
    )
}

pub(in crate::local_proxy) fn after_authentication_failure<R: Runtime>(
    app: &AppHandle<R>,
    route: &Route,
    session: Option<&str>,
    failed: &HashSet<String>,
) -> Result<Option<Route>, AutoSwitchError> {
    after_failure(
        app,
        route,
        ChoiceRequest {
            session,
            failed,
            explicit_quota: false,
        },
    )
}

fn after_failure<R: Runtime>(
    app: &AppHandle<R>,
    route: &Route,
    request: ChoiceRequest<'_>,
) -> Result<Option<Route>, AutoSwitchError> {
    let latest = initial(app)?;
    if !latest.config.settings.enabled
        || (request.explicit_quota && !latest.config.settings.switch_on_quota_exhaustion)
        || latest.config.revision != route.config.revision
        || !matches!(route.selection, GuiAccountSelection::Account(_))
    {
        return Ok(None);
    }
    if latest.seed.revision != route.seed.revision {
        if request.explicit_quota && official_recovery_routing::model().is_some() {
            let GuiAccountSelection::Account(id) = &latest.selection else {
                return Ok(None);
            };
            if request.failed.contains(id) || !official_recovery_routing::account_matches(app, id) {
                return Ok(None);
            }
            return match ensure_current(app, &latest) {
                Ok(()) => Ok(Some(latest)),
                Err(AutoSwitchError::Changed) => Ok(None),
                Err(error) => Err(error),
            };
        }
        let reusable = match &latest.selection {
            GuiAccountSelection::Account(id) => !request.failed.contains(id),
            GuiAccountSelection::Provider(_) | GuiAccountSelection::Aggregate(_) => true,
            GuiAccountSelection::None => false,
        };
        return Ok((reusable && latest.selection != route.selection).then_some(latest));
    }
    let remembered = if request.explicit_quota {
        observe_quota_exhaustion(app, route)?
    } else {
        remember_exhaustion(app, route, false)?
    };
    if !remembered {
        return Ok(None);
    }
    match choose(app, route.clone(), request) {
        Ok(next) if next.selection != route.selection => Ok(Some(next)),
        Ok(_) | Err(AutoSwitchError::Changed | AutoSwitchError::NoAccount) => Ok(None),
        Err(error) => Err(error),
    }
}

pub(in crate::local_proxy) fn observe_quota_exhaustion<R: Runtime>(
    app: &AppHandle<R>,
    route: &Route,
) -> Result<bool, AutoSwitchError> {
    if !route.config.settings.enabled || !route.config.settings.switch_on_quota_exhaustion {
        return Ok(false);
    }
    settings::with_current(app, route.config.revision, || {
        account_selection::with_current(app, route.seed.revision, || {
            remember_exhaustion(app, route, true)
        })
        .map_err(|_| AutoSwitchError::Storage)?
        .unwrap_or(Ok(false))
    })
    .map_err(|_| AutoSwitchError::Storage)?
    .unwrap_or(Ok(false))
}

pub(super) fn remember_exhaustion<R: Runtime>(
    app: &AppHandle<R>,
    route: &Route,
    confirmed_quota: bool,
) -> Result<bool, AutoSwitchError> {
    let GuiAccountSelection::Account(id) = &route.selection else {
        return Ok(false);
    };
    with_routing(app, route, |state| {
        // Check recovery and record this attempt together, without replaying prior retry failures.
        if state
            .recovered
            .get(id)
            .is_some_and(|recovered| *recovered > route.attempt_started_at)
        {
            return false;
        }
        let observed_at = Instant::now();
        state.exhausted.insert(
            id.clone(),
            Exhaustion {
                observed_at,
                next_check_at: observed_at + EXHAUSTED_COOLDOWN,
                confirmed_quota,
            },
        );
        if !confirmed_quota {
            state.scheduler.invalidate_account(id);
        }
        true
    })
}
