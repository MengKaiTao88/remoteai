use crate::{
    models::{CreditsSnapshot, ManagerStateFile},
    storage::{load_usage, usage_path, Paths},
};

/// Read the same cached credits as the PC account column for the selected account only.
pub(super) fn load(paths: &Paths, state: &ManagerStateFile) -> Option<CreditsSnapshot> {
    if state.active_provider_id.is_some() || state.active_provider_group.is_some() {
        return None;
    }
    let account_id = state.active_account_id.as_deref()?;
    load_usage(&usage_path(paths, account_id)).credits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_gui::account_selection::GuiAccountSelection;
    use crate::models::UsageSummary;

    #[test]
    fn gui_credits_follow_the_selected_account_and_pc_usage_cache() {
        let root = tempfile::tempdir().unwrap();
        let paths = Paths {
            current_auth: root.path().join("auth.json"),
            current_config: root.path().join("config.toml"),
            codex_home: root.path().to_path_buf(),
            accounts: root.path().join("accounts"),
            providers: root.path().join("providers"),
            config_backup: root.path().join("backup.toml"),
            state_file: root.path().join("state.json"),
        };
        let mut state = ManagerStateFile::default();
        for (id, balance) in [("first", "62500.125"), ("second", "0")] {
            let credits = CreditsSnapshot {
                has_credits: balance != "0",
                unlimited: false,
                balance: Some(balance.to_string()),
            };
            crate::storage::save_usage(
                &usage_path(&paths, id),
                &UsageSummary {
                    credits: Some(credits.clone()),
                    ..UsageSummary::default()
                },
            )
            .unwrap();
            GuiAccountSelection::Account(id.to_string()).apply_to_summary(&mut state);
            assert_eq!(load(&paths, &state), Some(credits));
        }
        for selection in [
            GuiAccountSelection::Account("missing".to_string()),
            GuiAccountSelection::Provider("api".to_string()),
            GuiAccountSelection::Aggregate("pool".to_string()),
            GuiAccountSelection::None,
        ] {
            selection.apply_to_summary(&mut state);
            assert_eq!(load(&paths, &state), None);
        }
    }
}
