use super::{BrowserError, Result};
use std::collections::BTreeMap;

#[cfg(windows)]
mod windows;

pub(super) fn configure(
    view: &tauri::Webview,
    origin: &str,
    headers: &BTreeMap<String, String>,
) -> Result<()> {
    configure_headers(view, origin, headers)
}

#[cfg(windows)]
fn configure_headers(
    view: &tauri::Webview,
    origin: &str,
    headers: &BTreeMap<String, String>,
) -> Result<()> {
    windows::configure_headers(view, origin, headers)
}

#[cfg(not(windows))]
fn configure_headers(
    _: &tauri::Webview,
    _: &str,
    headers: &BTreeMap<String, String>,
) -> Result<()> {
    if headers.is_empty() {
        Ok(())
    } else {
        Err(BrowserError::HeadersUnsupported)
    }
}
