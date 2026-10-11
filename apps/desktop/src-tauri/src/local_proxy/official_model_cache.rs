//! Shared admin-first discovery for proxy clients, the GUI, and explicit catalog refreshes.
use super::{UpstreamBody, UpstreamPayload};
use std::{collections::HashSet, io::Read, time::Duration};

use reqwest::{blocking::Client, Url};
use serde_json::Value;
use tauri::{AppHandle, Runtime};

const CACHE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CATALOG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
enum CatalogError {
    #[error("Could not read model catalog server settings")]
    Settings,
    #[error("Invalid model catalog server address")]
    Address,
    #[error("Model catalog cache request failed")]
    Request(#[from] reqwest::Error),
    #[error("Could not read model catalog cache")]
    Read(#[from] std::io::Error),
    #[error("Model catalog cache is invalid or empty")]
    Invalid,
}

pub(super) fn with_fallback<R: Runtime>(
    app: &AppHandle<R>,
    official: impl FnOnce() -> Result<UpstreamPayload, String>,
) -> Result<UpstreamPayload, String> {
    prefer_cache(fetch(app), official)
}

fn prefer_cache(
    cached: Result<UpstreamPayload, CatalogError>,
    official: impl FnOnce() -> Result<UpstreamPayload, String>,
) -> Result<UpstreamPayload, String> {
    match cached {
        Ok(payload) => Ok(payload),
        Err(error) => {
            eprintln!("{error}; fetching models from the official service");
            official()
        }
    }
}

fn fetch<R: Runtime>(app: &AppHandle<R>) -> Result<UpstreamPayload, CatalogError> {
    let settings = crate::storage::read_app_settings(app).map_err(|_| CatalogError::Settings)?;
    let base = settings
        .cloud_base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(crate::models::DEFAULT_CLOUD_BASE_URL);
    let client = crate::system_proxy::apply(Client::builder())
        .timeout(CACHE_TIMEOUT)
        .build()?;
    request_catalog(&client, catalog_url(base)?)
}

fn catalog_url(base: &str) -> Result<Url, CatalogError> {
    let mut url = Url::parse(base.trim()).map_err(|_| CatalogError::Address)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CatalogError::Address);
    }
    url.set_path(&format!(
        "{}/official-models",
        url.path().trim_end_matches('/')
    ));
    Ok(url)
}

fn request_catalog(client: &Client, url: Url) -> Result<UpstreamPayload, CatalogError> {
    // Catalogs are public metadata; never send local account or cloud credentials here.
    let response = client
        .get(url)
        .timeout(CACHE_TIMEOUT)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-cache")
        .send()?
        .error_for_status()?;
    let headers = ["etag", "x-models-etag"]
        .into_iter()
        .filter_map(|name| {
            let value = response.headers().get(name)?.to_str().ok()?;
            Some((name.to_owned(), value.to_owned()))
        })
        .collect();
    let mut bytes = Vec::new();
    response
        .take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut bytes)?;
    validate_catalog(&bytes)?;
    Ok(UpstreamPayload {
        status: 200,
        content_type: Some("application/json".into()),
        response_headers: headers,
        body: UpstreamBody::Buffered(bytes),
        token_usage_service_tier: None,
        token_usage_account: None,
    })
}

fn validate_catalog(bytes: &[u8]) -> Result<(), CatalogError> {
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        return Err(CatalogError::Invalid);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| CatalogError::Invalid)?;
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or(CatalogError::Invalid)?;
    let mut names = HashSet::new();
    let mut visible = false;
    if models.is_empty() {
        return Err(CatalogError::Invalid);
    }
    for model in models {
        let name = model
            .get("slug")
            .or_else(|| model.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or(CatalogError::Invalid)?;
        if !names.insert(name) {
            return Err(CatalogError::Invalid);
        }
        visible |= model.get("visibility").and_then(Value::as_str) != Some("hide");
    }
    if !visible {
        return Err(CatalogError::Invalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
