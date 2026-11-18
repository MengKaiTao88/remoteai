//! Persist the catalog consumed by Codex, not just the model picker cache.
use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::{
    codex_config,
    storage::{self, Paths},
};

const FILENAME: &str = "remoteai-official-context-model-catalog.json";

pub(super) fn existing_path(paths: &Paths) -> Option<PathBuf> {
    let path = paths.codex_home.join(FILENAME);
    storage::read_json(&path)
        .ok()
        .filter(has_model_metadata)
        .map(|_| path)
}

pub(crate) fn install<R: Runtime>(app: &AppHandle<R>, catalog: &Value) -> Result<(), String> {
    if crate::codex_gui::backend::isolated_follower()
        || !crate::claude_code::should_write_codex_for_app(app)?
        || !has_model_metadata(catalog)
    {
        return Ok(());
    }
    for paths in storage::resolve_enabled_paths(app)? {
        persist_for_official_proxy(&paths, catalog)?;
    }
    Ok(())
}

fn has_model_metadata(catalog: &Value) -> bool {
    catalog["models"].as_array().is_some_and(|models| {
        !models.is_empty()
            && models
                .iter()
                .all(|m| m["slug"].as_str().is_some_and(|slug| !slug.is_empty()))
            && models.iter().any(|m| m["base_instructions"].is_string())
    })
}

fn persist_for_official_proxy(paths: &Paths, catalog: &Value) -> Result<(), String> {
    let state = storage::try_read_state(paths)?;
    if !state.local_proxy_enabled
        || state.active_provider_id.is_some()
        || state.active_provider_group.is_some()
    {
        return Ok(());
    }
    let existing = fs::read_to_string(&paths.current_config).map_err(|error| error.to_string())?;
    let filename = paths.codex_home.join(FILENAME);
    let Some(config) =
        codex_config::set_official_proxy_catalog(&existing, Path::new(FILENAME), &filename)
            .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    // Never copy cache identity or account metadata into the Codex catalog.
    storage::write_json_if_changed(&filename, &json!({ "models": catalog["models"] }))?;
    if fs::read_to_string(&paths.current_config).ok().as_deref() == Some(existing.as_str()) {
        storage::write_text_if_changed(&paths.current_config, &config)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_only_catalog_does_not_replace_full_model_metadata() {
        assert!(!has_model_metadata(
            &json!({ "models": [{"slug": "gpt-6.2-sol"}] })
        ));
        assert!(has_model_metadata(&json!({ "models": [{
            "slug": "gpt-6.2-sol", "base_instructions": "full model data", "context_window": 500000
        }] })));
    }
}
