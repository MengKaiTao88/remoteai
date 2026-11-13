#[tauri::command]
pub(crate) async fn set_auto_switch_priority_by_reset<R: Runtime + 'static>(
    app: tauri::AppHandle<R>,
    enabled: bool,
) -> Result<LocalProxyStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = resolve_paths(&app)?;
        let proxy_running = is_running();
        update_state(&paths, |state| {
            if enabled && (!proxy_running || !state.auto_switch_on_quota_exhaustion) {
                return Err(
                    "Enable automatic account switching before enabling custom priorities".to_string(),
                );
            }
            state.auto_switch_priority_by_reset = enabled;
            if enabled {
                state.custom_auto_switch_priority_enabled = true;
            }
            Ok(())
        })?;
        app.emit("providers-changed", ())
            .map_err(|error| error.to_string())?;
        Ok(status(&app))
    })
    .await
    .map_err(|error| format!("Reset priority update task failed: {error}"))?
}
