//! Official conversations use the running proxy's active target rather than legacy GUI routing.
use super::{GuiAccountSelection, SelectionError, CHANGED_EVENT};
use crate::models::ManagerStateFile;
use tauri::{AppHandle, Runtime};

fn selection_from_state(state: &ManagerStateFile) -> GuiAccountSelection {
    // A provider group routes across several providers and is not an individual picker choice.
    if state.active_provider_group.is_some() {
        return GuiAccountSelection::None;
    }
    if let Some(id) = state.active_provider_id.as_deref() {
        return match crate::aggregate_api::config_id_from_active_id(id) {
            Some(id) => GuiAccountSelection::Aggregate(id.to_owned()),
            None => GuiAccountSelection::Provider(id.to_owned()),
        };
    }
    state
        .active_account_id
        .as_ref()
        .map_or(GuiAccountSelection::None, |id| {
            GuiAccountSelection::Account(id.clone())
        })
}

pub(super) fn read<R: Runtime>(app: &AppHandle<R>) -> Result<GuiAccountSelection, SelectionError> {
    let paths = crate::storage::resolve_paths(app).map_err(|_| SelectionError::Storage)?;
    let state = crate::storage::try_read_state(&paths).map_err(|_| SelectionError::Storage)?;
    Ok(selection_from_state(&state))
}

fn apply_selection(
    selection: &GuiAccountSelection,
    account: impl FnOnce(&str) -> Result<(), String>,
    provider: impl FnOnce(&str) -> Result<(), String>,
    aggregate: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), SelectionError> {
    let result = match selection {
        GuiAccountSelection::Account(id) => account(id),
        GuiAccountSelection::Provider(id) => provider(id),
        GuiAccountSelection::Aggregate(id) => aggregate(id),
        GuiAccountSelection::None => return Err(SelectionError::Unavailable),
    };
    result.map_err(|_| SelectionError::Unavailable)
}

pub(super) fn switch<R: Runtime>(
    app: &AppHandle<R>,
    selection: GuiAccountSelection,
) -> Result<GuiAccountSelection, SelectionError> {
    // Keep the official process connected to its existing proxy; never replace its login or restart it.
    if !crate::local_proxy::is_running() {
        return Err(SelectionError::Unavailable);
    }
    apply_selection(
        &selection,
        |id| crate::commands::switch_account_blocking(app.clone(), id.to_owned()),
        |id| crate::providers::switch_provider_blocking(app.clone(), id.to_owned()),
        |id| crate::aggregate_api::switch_blocking(app, id),
    )?;
    let current = read(app)?;
    crate::codex_gui::web::publish(app, CHANGED_EVENT, &current);
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn official_picker_reports_the_proxy_target_and_not_an_old_gui_selection() {
        let mut state = ManagerStateFile {
            active_account_id: Some("official-account".into()),
            ..Default::default()
        };
        assert_eq!(
            selection_from_state(&state),
            GuiAccountSelection::Account("official-account".into())
        );
        state.active_provider_id = Some("provider".into());
        assert_eq!(
            selection_from_state(&state),
            GuiAccountSelection::Provider("provider".into())
        );
        state.active_provider_id = Some(crate::aggregate_api::active_id("pool"));
        assert_eq!(
            selection_from_state(&state),
            GuiAccountSelection::Aggregate("pool".into())
        );
        state.active_provider_id = None;
        state.active_provider_group = Some("group".into());
        assert_eq!(selection_from_state(&state), GuiAccountSelection::None);
    }

    #[test]
    fn official_switch_dispatches_only_the_selected_existing_activation_flow() {
        for selection in [
            GuiAccountSelection::Account("account".into()),
            GuiAccountSelection::Provider("provider".into()),
            GuiAccountSelection::Aggregate("pool".into()),
        ] {
            let calls = RefCell::new(Vec::new());
            apply_selection(
                &selection,
                |id| {
                    calls.borrow_mut().push(("account", id.to_owned()));
                    Ok(())
                },
                |id| {
                    calls.borrow_mut().push(("provider", id.to_owned()));
                    Ok(())
                },
                |id| {
                    calls.borrow_mut().push(("aggregate", id.to_owned()));
                    Ok(())
                },
            )
            .unwrap();
            let expected = match selection {
                GuiAccountSelection::Account(id) => ("account", id),
                GuiAccountSelection::Provider(id) => ("provider", id),
                GuiAccountSelection::Aggregate(id) => ("aggregate", id),
                GuiAccountSelection::None => unreachable!(),
            };
            assert_eq!(*calls.borrow(), vec![expected]);
        }
    }

    #[test]
    fn invalid_selections_and_failed_activation_never_report_success() {
        let unexpected =
            |_: &str| -> Result<(), String> { panic!("must not activate another target") };
        assert!(apply_selection(
            &GuiAccountSelection::None,
            unexpected,
            unexpected,
            unexpected
        )
        .is_err());
        assert!(apply_selection(
            &GuiAccountSelection::Account("account".into()),
            |_| Err("activation failed".into()),
            unexpected,
            unexpected
        )
        .is_err());
    }
}
