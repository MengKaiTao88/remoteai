fn reset_priority_account(id: &str, reset: Option<i64>) -> AccountSummary {
    let mut account = account_with_usage(id, 80.0, 80.0);
    account.usage.secondary.as_mut().unwrap().resets_at = reset;
    account
}

fn reset_priority_state() -> ManagerStateFile {
    ManagerStateFile {
        auto_switch_on_quota_exhaustion: true,
        custom_auto_switch_priority_enabled: true,
        auto_switch_priority_by_reset: true,
        ..Default::default()
    }
}

#[test]
fn reset_priority_orders_next_reset_not_window_duration_or_manual_number() {
    let now = chrono::Utc::now().timestamp();
    let mut accounts = vec![
        reset_priority_account("later", Some(now + 200)),
        reset_priority_account("sooner", Some(now + 100)),
        reset_priority_account("same-time", Some(now + 100)),
        reset_priority_account("unknown", None),
        reset_priority_account("elapsed", Some(now - 1)),
    ];
    accounts[0].auto_switch_priority = -100;
    accounts[1].usage.secondary.as_mut().unwrap().window_minutes = Some(20_000);
    reset_priority::apply(&mut accounts, &reset_priority_state());
    assert_eq!(accounts.iter().map(|a| a.auto_switch_priority).collect::<Vec<_>>(), [2, 1, 1, 3, 3]);
    let target = account_with_lowest_remaining_primary_quota(&accounts, "current", true, false, 0.0);
    assert_eq!(target.unwrap().id, "sooner");
}

#[test]
fn reset_priority_never_bypasses_quota_enabled_or_threshold_checks() {
    let now = chrono::Utc::now().timestamp();
    let mut accounts = vec![
        reset_priority_account("exhausted", Some(now + 10)),
        reset_priority_account("disabled", Some(now + 20)),
        reset_priority_account("below-threshold", Some(now + 30)),
        reset_priority_account("eligible", Some(now + 100)),
    ];
    accounts[0].usage.secondary.as_mut().unwrap().remaining_percent = 0.0;
    accounts[1].auto_switch_enabled = false;
    accounts[2].usage.primary.as_mut().unwrap().remaining_percent = 10.0;
    reset_priority::apply(&mut accounts, &reset_priority_state());
    let target = account_with_lowest_remaining_primary_quota(&accounts, "current", true, true, 40.0);
    assert_eq!(target.unwrap().id, "eligible");
}

#[test]
fn reset_priority_reorders_after_refresh_and_leaves_manual_mode_unchanged() {
    let now = chrono::Utc::now().timestamp();
    let original = || vec![
        reset_priority_account("first", Some(now + 100)),
        reset_priority_account("second", Some(now + 200)),
    ];
    for disabled in [0, 1, 2] {
        let mut accounts = original();
        accounts[0].auto_switch_priority = -8;
        let mut state = reset_priority_state();
        match disabled {
            0 => state.auto_switch_on_quota_exhaustion = false,
            1 => state.custom_auto_switch_priority_enabled = false,
            _ => state.auto_switch_priority_by_reset = false,
        }
        reset_priority::apply(&mut accounts, &state);
        assert_eq!(accounts[0].auto_switch_priority, -8);
    }
    let mut accounts = original();
    reset_priority::apply(&mut accounts, &reset_priority_state());
    accounts[0].usage.secondary.as_mut().unwrap().resets_at = Some(now + 300);
    reset_priority::apply(&mut accounts, &reset_priority_state());
    assert_eq!(accounts[0].auto_switch_priority, 2);
    assert_eq!(accounts[1].auto_switch_priority, 1);
}

#[test]
fn reset_priority_concurrency_and_image_fallback_preserve_manual_values() {
    let (root, paths) = concurrent_priority_test_paths();
    let now = chrono::Utc::now().timestamp();
    for (id, reset, manual) in [("later", now + 200, -5), ("sooner", now + 100, 9)] {
        add_concurrent_priority_test_account(&paths, id, manual);
        let account = reset_priority_account(id, Some(reset));
        write_json_if_changed(&usage_path(&paths, id), &serde_json::to_value(account.usage).unwrap()).unwrap();
    }
    let mut state = reset_priority_state();
    state.concurrent_account_routing_enabled = true;
    let eligible = available_concurrent_account_ids(&paths, &state).unwrap();
    assert_eq!(preferred_concurrent_account_ids(&paths, &state, &eligible), ["sooner"]);
    assert_eq!(image_failover_account_ids(&paths, &state).unwrap(), ["sooner", "later"]);
    assert_eq!(load_auto_switch_priority(&auto_switch_priority_path(&paths, "later")), -5);
    state.auto_switch_priority_by_reset = false;
    assert_eq!(preferred_concurrent_account_ids(&paths, &state, &eligible), ["later"]);
    let mut refreshed = vec![reset_priority_account("later", Some(now + 200))];
    refreshed[0].auto_switch_priority = 2;
    reset_priority::reload(&paths, &mut refreshed, &state);
    assert_eq!(refreshed[0].auto_switch_priority, -5);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn reset_priority_rejects_elapsed_missing_or_failed_timestamps() {
    let mut account = reset_priority_account("a", Some(101));
    assert_eq!(reset_priority::secondary_reset_key(&account.usage, 100), 101);
    assert_eq!(reset_priority::secondary_reset_key(&account.usage, 101), i64::MAX);
    account.usage.error = Some("offline".into());
    assert_eq!(reset_priority::secondary_reset_key(&account.usage, 100), i64::MAX);
    account.usage.error = None;
    account.usage.secondary = None;
    assert_eq!(reset_priority::secondary_reset_key(&account.usage, 100), i64::MAX);
}
