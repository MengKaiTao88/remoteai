use std::fmt;

use toml_edit::{value, Array, DocumentMut, InlineTable, Item, Table, Value};

mod official_compatibility;
pub(crate) use official_compatibility::ensure_official_provider_compatibility;
use official_compatibility::{
    is_official_compatibility_provider, set_official_compatibility_provider,
};

pub(crate) const LOCAL_PROXY_HOST: &str = "127.0.0.1";
pub(crate) const LOCAL_PROXY_PORT: u16 = 15722;
pub(crate) const LOCAL_PROXY_BASE_URL: &str = "http://127.0.0.1:15722/v1";
pub(crate) const LOCAL_PROXY_TOKEN: &str = "CODEX_SWITCH_LOCAL_PROXY";
pub(crate) const LOCAL_PROXY_ACTOR_AUTHORIZATION_HEADER: &str = "x-openai-actor-authorization";
pub(crate) const LOCAL_PROXY_REQUEST_PURPOSE_HEADER: &str = "x-codex-switch-request-purpose";
pub(crate) const TITLE_GENERATION_REQUEST_PURPOSE: &str = "title-generation";
pub(crate) const PREDICTION_REQUEST_PURPOSE: &str = "next-prompt-suggestion";
pub(crate) const HELP_REQUEST_PURPOSE: &str = "remote-ai-help";
pub(crate) const GIT_MESSAGE_REQUEST_PURPOSE: &str = "git-commit-message";
pub(crate) const HELP_ACCOUNT_REVISION_HEADER: &str = "x-remote-ai-help-account-revision";
pub(crate) const LOCAL_PROXY_PROVIDER_ID: &str = "codex-switch-local";
const DEFERRED_TOOL_FEATURES: [&str; 2] =
    ["code_mode_only_strict_3p_tools", "code_mode_tool_search"];
const MANAGED_FEATURE_MARKER: &str = "# Managed by Remote AI official proxy";

const OFFICIAL_PROVIDER_ID: &str = "openai";
const PROVIDER_ROOT_START: &str = "# Codex Switch provider start";
const PROVIDER_ROOT_END: &str = "# Codex Switch provider end";
const PROVIDER_TABLE_START: &str = "# Codex Switch custom provider start";
const PROVIDER_TABLE_END: &str = "# Codex Switch custom provider end";
const TOKEN_COMMAND_ARGUMENT: &str = "--print-local-proxy-token";
const TOKEN_COMMAND_TIMEOUT_MS: i64 = 5_000;
const TOKEN_REFRESH_INTERVAL_MS: i64 = 300_000;
const MANAGED_ROOT_KEYS: [&str; 4] = [
    "model_provider",
    "model",
    "disable_response_storage",
    "model_catalog_json",
];

pub(crate) struct LocalProxyConfig<'a> {
    pub(crate) name: &'a str,
    pub(crate) model: Option<&'a str>,
    pub(crate) model_catalog_filename: Option<&'a str>,
    pub(crate) official_inference: bool,
    pub(crate) requires_openai_auth: bool,
    pub(crate) token_command: &'a str,
}

#[derive(Debug)]
pub(crate) enum ConfigError {
    InvalidToml(String),
    InvalidModelProviders,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidToml(error) => write!(formatter, "Invalid Codex config.toml: {error}"),
            Self::InvalidModelProviders => {
                formatter.write_str("Codex model_providers must be a TOML table")
            }
        }
    }
}

impl std::error::Error for ConfigError {}

pub(crate) fn apply_local_proxy(
    content: &str,
    options: &LocalProxyConfig<'_>,
) -> Result<String, ConfigError> {
    let mut document = parse_document(content)?;
    set_proxy_root(&mut document, options);
    replace_local_proxy_table(&mut document, options)?;
    set_managed_tool_deferral(&mut document, options.official_inference);
    Ok(document.to_string())
}

pub(crate) fn restore_official(
    current: &str,
    backup: Option<&str>,
    model: Option<&str>,
) -> Result<String, ConfigError> {
    let mut document = parse_document(current)?;
    remove_managed_root(&mut document);
    remove_local_proxy_table(&mut document)?;
    set_managed_tool_deferral(&mut document, false);

    if let Some(backup) = backup {
        let backup = parse_document(backup)?;
        restore_managed_root(&mut document, &backup);
        restore_custom_provider_if_missing(&mut document, &backup)?;
    }
    set_root_value(
        &mut document,
        "model_provider",
        Value::from(OFFICIAL_PROVIDER_ID),
    );
    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        set_root_value(&mut document, "model", Value::from(model));
    }
    set_official_compatibility_provider(&mut document)?;
    Ok(document.to_string())
}

pub(crate) fn default_official(model: &str, reasoning_effort: &str) -> String {
    let mut document = DocumentMut::new();
    set_root_value(&mut document, "model", Value::from(model));
    set_root_value(
        &mut document,
        "model_reasoning_effort",
        Value::from(reasoning_effort),
    );
    document.to_string()
}

pub(crate) fn contains_local_proxy(content: &str) -> bool {
    content.parse::<DocumentMut>().is_ok_and(|document| {
        let has_proxy_reference = document
            .get("model_provider")
            .and_then(Item::as_str)
            .is_some_and(|provider| provider == LOCAL_PROXY_PROVIDER_ID)
            || local_proxy_table(&document).is_some();
        has_proxy_reference && !is_official_compatibility_provider(&document)
    }) || content.contains(LOCAL_PROXY_BASE_URL)
        || content.contains(LOCAL_PROXY_TOKEN)
}

/// Bind the official catalog without replacing a user-owned or third-party catalog.
pub(crate) fn set_official_proxy_catalog(
    content: &str,
    relative: &std::path::Path,
    absolute: &std::path::Path,
) -> Result<Option<String>, ConfigError> {
    let mut document = parse_document(content)?;
    if document.get("model_provider").and_then(Item::as_str) != Some(LOCAL_PROXY_PROVIDER_ID) {
        return Ok(None);
    }
    if document.get("model_catalog_json").is_some_and(|item| {
        !item.as_str().is_some_and(|value| {
            let path = std::path::Path::new(value);
            path == relative || path == absolute
        })
    }) {
        return Ok(None);
    }
    set_root_value(
        &mut document,
        "model_catalog_json",
        Value::from(absolute.to_string_lossy().as_ref()),
    );
    // Old installs can refresh their catalog before a provider config rewrite.
    if !is_official_compatibility_provider(&document) {
        if let Some(provider) = model_providers_mut(&mut document)?
            .get_mut(LOCAL_PROXY_PROVIDER_ID)
            .and_then(Item::as_table_mut)
            .filter(|provider| {
                provider.get("base_url").and_then(Item::as_str) == Some(LOCAL_PROXY_BASE_URL)
            })
        {
            set_remote_compaction(provider);
            set_managed_tool_deferral(&mut document, true);
        }
    }
    Ok(Some(document.to_string()))
}

/// Reads the saved model without changing unrelated configuration.
pub(crate) fn root_model(content: &str) -> Option<String> {
    parse_document(content)
        .ok()?
        .get("model")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn parse_document(content: &str) -> Result<DocumentMut, ConfigError> {
    remove_legacy_marked_blocks(content)
        .parse::<DocumentMut>()
        .map_err(|error| ConfigError::InvalidToml(error.to_string()))
}

#[cfg(test)]
mod default_official_tests {
    use super::*;

    #[test]
    fn official_model_catalog_rebinds_managed_proxy_and_preserves_user_config() {
        let rel = std::path::Path::new("official-models.json");
        let abs = std::path::Path::new("test-home/official-models.json");
        let config = "model_provider = 'codex-switch-local'\nmodel = 'gpt-6.2-sol'\n[features]\nexample = true\n";
        let bound = set_official_proxy_catalog(config, rel, abs)
            .unwrap()
            .unwrap();
        let parsed = bound.parse::<DocumentMut>().unwrap();
        assert_eq!(parsed["model_catalog_json"].as_str(), abs.to_str());
        assert_eq!(parsed["model"].as_str(), Some("gpt-6.2-sol"));
        assert_eq!(parsed["features"]["example"].as_bool(), Some(true));
        assert_eq!(
            set_official_proxy_catalog(&bound, rel, abs).unwrap(),
            Some(bound)
        );
        for other in [
            format!("model_catalog_json = 'third-party.json'\n{config}"),
            config.replace("codex-switch-local", "openai"),
        ] {
            assert!(set_official_proxy_catalog(&other, rel, abs)
                .unwrap()
                .is_none());
        }
    }

    #[test]
    fn official_model_catalog_installs_compaction_but_honors_user_tool_opt_out() {
        let rel = std::path::Path::new("official-models.json");
        let abs = std::path::Path::new("test-home/official-models.json");
        let config = format!("model_provider = '{LOCAL_PROXY_PROVIDER_ID}'\n[features]\ncode_mode_tool_search = false\n[model_providers.{LOCAL_PROXY_PROVIDER_ID}]\nbase_url = '{LOCAL_PROXY_BASE_URL}'\n");
        let bound = set_official_proxy_catalog(&config, rel, abs)
            .unwrap()
            .unwrap();
        let document = bound.parse::<DocumentMut>().unwrap();
        assert_eq!(
            document["features"]["code_mode_tool_search"].as_bool(),
            Some(false)
        );
        assert!(document["features"]
            .get("code_mode_only_strict_3p_tools")
            .is_none());
        let provider = local_proxy_table(&document).unwrap();
        assert_eq!(
            provider["capabilities"]["remote_compaction"].as_str(),
            Some("v2")
        );
    }

    #[test]
    fn default_official_matches_codex_model_persistence_format() {
        assert_eq!(
            default_official("gpt-5.6-sol", "low"),
            "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"low\"\n"
        );
    }
}

fn set_proxy_root(document: &mut DocumentMut, options: &LocalProxyConfig<'_>) {
    set_root_value(
        document,
        "model_provider",
        Value::from(LOCAL_PROXY_PROVIDER_ID),
    );
    if let Some(model) = options
        .model
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        set_root_value(document, "model", Value::from(model));
    } else {
        document.as_table_mut().remove("model");
    }
    if let Some(filename) = options.model_catalog_filename {
        set_root_value(document, "model_catalog_json", Value::from(filename));
    } else {
        document.as_table_mut().remove("model_catalog_json");
    }
    set_root_value(document, "disable_response_storage", Value::from(true));
}

fn set_root_value(document: &mut DocumentMut, key: &str, mut new_value: Value) {
    if let Some(existing) = document.get_mut(key).and_then(Item::as_value_mut) {
        *new_value.decor_mut() = existing.decor().clone();
        *existing = new_value;
        return;
    }
    document.as_table_mut().insert(key, Item::Value(new_value));
}

fn replace_local_proxy_table(
    document: &mut DocumentMut,
    options: &LocalProxyConfig<'_>,
) -> Result<(), ConfigError> {
    let mut provider = Table::new();
    provider["name"] = value(options.name);
    provider["base_url"] = value(LOCAL_PROXY_BASE_URL);
    provider["wire_api"] = value("responses");
    provider["requires_openai_auth"] = value(options.requires_openai_auth);
    set_proxy_auth(&mut provider, options);
    if options.official_inference {
        set_remote_compaction(&mut provider);
    }
    provider["http_headers"] = Item::Value(Value::InlineTable(proxy_headers()));
    model_providers_mut(document)?.insert(LOCAL_PROXY_PROVIDER_ID, Item::Table(provider));
    Ok(())
}

// Official Responses accepts the v2 trigger over the same streaming endpoint.
fn set_remote_compaction(provider: &mut Table) {
    let entry = provider
        .entry("capabilities")
        .or_insert(Item::Value(Value::InlineTable(InlineTable::new())));
    if let Some(capabilities) = entry.as_table_like_mut() {
        if !capabilities.contains_key("remote_compaction") {
            capabilities.insert("remote_compaction", value("v2"));
        }
    }
}

fn is_managed_feature(item: &Item) -> bool {
    item.as_bool() == Some(true)
        && item
            .as_value()
            .and_then(|v| v.decor().suffix())
            .and_then(|s| s.as_str())
            .is_some_and(|suffix| suffix.trim() == MANAGED_FEATURE_MARKER)
}

fn set_managed_tool_deferral(document: &mut DocumentMut, enabled: bool) {
    if !enabled && !document.contains_key("features") {
        return;
    }
    let Some(features) = document
        .entry("features")
        .or_insert(Item::Table(Table::new()))
        .as_table_mut()
    else {
        return;
    };
    // Do not turn either part on if the user or another application disabled it.
    let enabled = enabled
        && DEFERRED_TOOL_FEATURES.iter().all(|name| {
            features
                .get(name)
                .is_none_or(|item| item.as_bool() == Some(true))
        });
    for name in DEFERRED_TOOL_FEATURES {
        if enabled && !features.contains_key(name) {
            let mut managed = Value::from(true);
            managed
                .decor_mut()
                .set_suffix(format!(" {MANAGED_FEATURE_MARKER}"));
            features.insert(name, Item::Value(managed));
        } else if !enabled && features.get(name).is_some_and(is_managed_feature) {
            features.remove(name);
        }
    }
}

fn set_proxy_auth(provider: &mut Table, options: &LocalProxyConfig<'_>) {
    if options.requires_openai_auth {
        provider["experimental_bearer_token"] = value(LOCAL_PROXY_TOKEN);
        return;
    }

    let mut args = Array::new();
    args.push(TOKEN_COMMAND_ARGUMENT);
    let mut auth = InlineTable::new();
    auth.insert("command", Value::from(options.token_command));
    auth.insert("args", Value::Array(args));
    auth.insert("timeout_ms", Value::from(TOKEN_COMMAND_TIMEOUT_MS));
    auth.insert(
        "refresh_interval_ms",
        Value::from(TOKEN_REFRESH_INTERVAL_MS),
    );
    provider["auth"] = Item::Value(Value::InlineTable(auth));
}

/// Marks the local proxy as an OpenAI actor so Codex exposes built-in image tools.
pub(crate) fn proxy_headers() -> InlineTable {
    let mut headers = InlineTable::new();
    headers.insert(
        LOCAL_PROXY_ACTOR_AUTHORIZATION_HEADER,
        Value::from(LOCAL_PROXY_TOKEN),
    );
    headers
}

fn model_providers_mut(document: &mut DocumentMut) -> Result<&mut Table, ConfigError> {
    if !document.as_table().contains_key("model_providers") {
        let mut providers = Table::new();
        providers.set_implicit(true);
        document["model_providers"] = Item::Table(providers);
    }
    document["model_providers"]
        .as_table_mut()
        .ok_or(ConfigError::InvalidModelProviders)
}

fn local_proxy_table(document: &DocumentMut) -> Option<&Table> {
    document
        .get("model_providers")?
        .as_table()?
        .get(LOCAL_PROXY_PROVIDER_ID)?
        .as_table()
}

fn remove_managed_root(document: &mut DocumentMut) {
    for key in MANAGED_ROOT_KEYS {
        document.as_table_mut().remove(key);
    }
}

fn remove_local_proxy_table(document: &mut DocumentMut) -> Result<(), ConfigError> {
    let Some(providers) = document.get_mut("model_providers") else {
        return Ok(());
    };
    let providers = providers
        .as_table_mut()
        .ok_or(ConfigError::InvalidModelProviders)?;
    providers.remove(LOCAL_PROXY_PROVIDER_ID);
    if providers.is_empty() {
        document.as_table_mut().remove("model_providers");
    }
    Ok(())
}

fn restore_managed_root(document: &mut DocumentMut, backup: &DocumentMut) {
    for key in MANAGED_ROOT_KEYS {
        if let Some(item) = backup.get(key) {
            document.as_table_mut().insert(key, item.clone());
        }
    }
}

fn restore_custom_provider_if_missing(
    document: &mut DocumentMut,
    backup: &DocumentMut,
) -> Result<(), ConfigError> {
    let Some(custom) = backup
        .get("model_providers")
        .and_then(Item::as_table)
        .and_then(|providers| providers.get("custom"))
        .cloned()
    else {
        return Ok(());
    };
    let providers = model_providers_mut(document)?;
    if !providers.contains_key("custom") {
        providers.insert("custom", custom);
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum LegacyBlockKind {
    Root,
    Table,
}

fn remove_legacy_marked_blocks(config: &str) -> String {
    let lines = config.lines().collect::<Vec<_>>();
    let mut output = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        let Some((kind, end_marker)) = legacy_block_start(lines[index].trim()) else {
            output.push(lines[index]);
            index += 1;
            continue;
        };
        let Some(end_index) = find_legacy_block_end(&lines, index + 1, end_marker) else {
            return config.to_string();
        };
        output.extend(clean_legacy_block(&lines[index + 1..end_index], kind));
        index = end_index + 1;
    }
    output.join("\n")
}

fn legacy_block_start(line: &str) -> Option<(LegacyBlockKind, &'static str)> {
    match line {
        PROVIDER_ROOT_START => Some((LegacyBlockKind::Root, PROVIDER_ROOT_END)),
        PROVIDER_TABLE_START => Some((LegacyBlockKind::Table, PROVIDER_TABLE_END)),
        _ => None,
    }
}

fn find_legacy_block_end(lines: &[&str], start: usize, end_marker: &str) -> Option<usize> {
    lines
        .iter()
        .enumerate()
        .skip(start)
        .find_map(|(index, line)| (line.trim() == end_marker).then_some(index))
}

fn clean_legacy_block<'a>(lines: &'a [&'a str], kind: LegacyBlockKind) -> Vec<&'a str> {
    let mut output = Vec::with_capacity(lines.len());
    let mut in_root = true;
    let mut removing_provider_table = false;
    for line in lines {
        let trimmed = line.trim();
        if is_table_header(trimmed) {
            in_root = false;
            removing_provider_table = is_legacy_managed_provider(trimmed);
            if !removing_provider_table {
                output.push(*line);
            }
            continue;
        }
        if removing_provider_table {
            continue;
        }
        if matches!(kind, LegacyBlockKind::Root) && in_root && is_managed_root_line(trimmed) {
            continue;
        }
        output.push(*line);
    }
    output
}

fn is_legacy_managed_provider(line: &str) -> bool {
    line == "[model_providers.custom]"
        || line == format!("[model_providers.{LOCAL_PROXY_PROVIDER_ID}]")
}

fn is_managed_root_line(line: &str) -> bool {
    MANAGED_ROOT_KEYS
        .iter()
        .any(|key| line.starts_with(key) && line[key.len()..].trim_start().starts_with('='))
}

fn is_table_header(value: &str) -> bool {
    value.starts_with('[') && value.ends_with(']')
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn proxy_options<'a>() -> LocalProxyConfig<'a> {
        LocalProxyConfig {
            name: "DeepSeek",
            model: Some("deepseek-chat"),
            model_catalog_filename: Some("codex-switch-model-catalog.json"),
            official_inference: false,
            requires_openai_auth: false,
            token_command: r"C:\Program Files\Remote AI\csw.exe",
        }
    }

    #[test]
    fn proxy_update_preserves_user_format_and_unknown_settings() {
        let source = r#"# User setting
model = "gpt-5.6-sol" # Keep my model note
notify = ["done"]

[features]
js_repl = true
"#;

        let updated = apply_local_proxy(source, &proxy_options()).unwrap();

        assert!(updated.starts_with("# User setting\n"), "{updated}");
        assert!(updated.contains("notify = [\"done\"]"));
        assert!(updated.contains("[features]\njs_repl = true"));
        assert!(updated.contains("model = \"deepseek-chat\""));
        assert!(updated.contains("# Keep my model note"));
        assert!(updated.contains("[model_providers.codex-switch-local]"));
        updated.parse::<DocumentMut>().unwrap();
    }

    #[test]
    fn restoring_proxy_config_forces_the_official_provider() {
        let current = apply_local_proxy("notify = [\"done\"]\n", &proxy_options()).unwrap();

        let restored = restore_official(&current, None, None).unwrap();
        let document = restored.parse::<DocumentMut>().unwrap();

        assert_eq!(document["model_provider"].as_str(), Some("openai"));
        assert_eq!(document["notify"][0].as_str(), Some("done"));
        assert!(is_official_compatibility_provider(&document));
        assert!(!contains_local_proxy(&restored));
    }

    #[test]
    fn restoring_uses_backed_up_model_and_keeps_current_user_edits() {
        let backup = "model = \"gpt-5.5\"\n\n[features]\njs_repl = true\n";
        let current = apply_local_proxy(backup, &proxy_options())
            .unwrap()
            .replace("js_repl = true", "js_repl = false");

        let restored = restore_official(&current, Some(backup), None).unwrap();
        let document = restored.parse::<DocumentMut>().unwrap();

        assert_eq!(document["model_provider"].as_str(), Some("openai"));
        assert_eq!(document["model"].as_str(), Some("gpt-5.5"));
        assert_eq!(document["features"]["js_repl"].as_bool(), Some(false));
    }

    #[test]
    fn restoring_can_force_the_official_model() {
        let backup = "model = \"gpt-5.5\"\n";
        let current = apply_local_proxy(backup, &proxy_options()).unwrap();

        let restored = restore_official(&current, Some(backup), Some("gpt-5.6-sol")).unwrap();
        let document = restored.parse::<DocumentMut>().unwrap();

        assert_eq!(document["model_provider"].as_str(), Some("openai"));
        assert_eq!(document["model"].as_str(), Some("gpt-5.6-sol"));
    }

    #[test]
    fn legacy_markers_are_migrated_without_removing_user_tables() {
        let source = format!(
            "{PROVIDER_TABLE_START}\n\
             [model_providers.{LOCAL_PROXY_PROVIDER_ID}]\n\
             base_url = \"{LOCAL_PROXY_BASE_URL}\"\n\
             \n\
             [features]\n\
             js_repl = true\n\
             {PROVIDER_TABLE_END}\n"
        );

        let restored = restore_official(&source, None, None).unwrap();

        assert!(restored.contains("[features]"));
        assert!(restored.contains("js_repl = true"));
        assert!(!restored.contains(LOCAL_PROXY_BASE_URL));
    }
}
