#[test]
fn market_personal_copy_retains_script_without_activation_or_overwriting_other_profiles() {
    let paths = test_paths();
    let original = provider();
    write_local_provider(&paths, &original, None).unwrap();
    let state_before = read_state(&paths);
    let mut installed = original.clone();
    installed.id = "market-copy".into();
    installed.name = "Market copy".into();
    installed.balance_script = Some(serde_json::from_value(json!({
        "url":"https://gateway.example.com/balance", "auth":"bearer",
        "script":"function parseBalance(r){return {amount:r.amount,currency:'USD'};}"
    })).unwrap());
    installed.market_source = Some(serde_json::from_value(json!({
        "id":"11111111-1111-4111-8111-111111111111",
        "page":{"url":"https://gateway.example.com/dashboard", "query":"tag=a&tag=b",
        "headers":{"X-Region":"east"}}
    })).unwrap());
    write_local_provider(&paths, &installed, None).unwrap();
    let restored = read_provider(&paths, &installed.id).unwrap();
    assert_eq!(restored.balance_script, installed.balance_script);
    assert_eq!(restored.market_source, installed.market_source);
    assert!(!load_or_init_provider_field_modified_at(&paths, &installed.id).unwrap().market_source.is_empty());
    assert_eq!(read_provider(&paths, &original.id).unwrap().name, original.name);
    let state_after = read_state(&paths);
    assert_eq!(state_before.active_provider_id, state_after.active_provider_id);
    assert_eq!(state_before.active_provider_group, state_after.active_provider_group);
    assert!(!load_or_init_provider_field_modified_at(&paths, &installed.id).unwrap().balance_script.is_empty());
    let previous = installed.clone();
    installed.balance_script = None;
    write_local_provider(&paths, &installed, Some(&previous)).unwrap();
    assert!(read_provider(&paths, &installed.id).unwrap().balance_script.is_none());
    fs::remove_dir_all(paths.codex_home.parent().unwrap()).unwrap();
}
