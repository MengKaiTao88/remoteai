use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
const MAX_PAGE_BYTES: usize = 16 * 1024;
const MAX_PAGE_URL_BYTES: usize = 4096;
const MAX_PAGE_HEADERS: usize = 32;
const MAX_PAGE_HEADER_BYTES: usize = 4096;

#[cfg(test)]
#[path = "market_page_tests.rs"]
mod tests;

/// A public website definition, separate from API routing and personal credentials.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MarketPageLink {
    pub(crate) url: String,
    pub(crate) query: String,
    pub(crate) headers: BTreeMap<String, String>,
}

/// Snapshot of the market entry selected at installation time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProviderMarketSource {
    pub(crate) id: String,
    pub(crate) page: MarketPageLink,
}

#[derive(Debug, thiserror::Error)]
#[error("market.invalid")]
pub(crate) struct InvalidMarketPage;

impl MarketPageLink {
    pub(crate) fn validate(&self) -> Result<(), InvalidMarketPage> {
        let url = url::Url::parse(&self.url).map_err(|_| InvalidMarketPage)?;
        let bytes = serde_json::to_vec(self).map_err(|_| InvalidMarketPage)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || self.url.len() > MAX_PAGE_URL_BYTES
            || self.url.chars().any(|c| c.is_whitespace() || c == '\\')
            || self.query.contains(['\r', '\n', '#'])
            || bytes.len() > MAX_PAGE_BYTES
        {
            return Err(InvalidMarketPage);
        }
        validate_page_headers(&self.headers)
    }
}

impl ProviderMarketSource {
    pub(crate) fn validate(&self) -> Result<(), InvalidMarketPage> {
        let id = uuid::Uuid::parse_str(&self.id).map_err(|_| InvalidMarketPage)?;
        if id.to_string() != self.id {
            return Err(InvalidMarketPage);
        }
        self.page.validate()
    }
}

pub(crate) fn validate_page_headers(
    headers: &BTreeMap<String, String>,
) -> Result<(), InvalidMarketPage> {
    if headers.len() > MAX_PAGE_HEADERS
        || serde_json::to_vec(headers)
            .map_err(|_| InvalidMarketPage)?
            .len()
            > MAX_PAGE_BYTES
    {
        return Err(InvalidMarketPage);
    }
    let mut names = HashSet::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if !names.insert(lower.clone())
            || reqwest::header::HeaderName::from_bytes(name.as_bytes()).is_err()
            || lower.starts_with("sec-")
            || matches!(
                lower.as_str(),
                "host"
                    | "connection"
                    | "content-length"
                    | "transfer-encoding"
                    | "upgrade"
                    | "te"
                    | "trailer"
                    | "cookie"
                    | "set-cookie"
                    | "proxy-authorization"
                    | "proxy-connection"
                    | "keep-alive"
            )
            || value.len() > MAX_PAGE_HEADER_BYTES
            || !value.bytes().all(|c| c == b'\t' || (32..=126).contains(&c))
        {
            return Err(InvalidMarketPage);
        }
    }
    Ok(())
}
