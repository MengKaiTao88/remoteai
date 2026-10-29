use std::{io::Read, time::Duration};

use crate::models::{ProviderBalance, ProviderProfile};
use csw_provider_balance_script::{Authentication, BalanceScript, MAX_RESPONSE_BYTES};

#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error(transparent)]
    Script(#[from] csw_provider_balance_script::Error),
    #[error("market.scriptRequest")]
    Request,
}

/// The caller runs on a blocking worker. Scripts have no transport binding and cannot change this request.
pub(super) fn query(
    provider: &ProviderProfile,
    script: &BalanceScript,
) -> Result<ProviderBalance, Error> {
    let url = script.validate(&provider.base_url)?;
    let client = crate::system_proxy::apply(reqwest::blocking::Client::builder())
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::Request)?;
    let token = provider
        .balance_query_token
        .as_deref()
        .unwrap_or(&provider.api_key);
    let request = client.get(url).header("Accept", "application/json");
    let request = match script.auth {
        Authentication::Bearer => request.bearer_auth(token),
        Authentication::ApiKey => request.header("X-API-Key", token),
        Authentication::None => request,
    };
    let response = request.send().map_err(|_| Error::Request)?;
    if !response.status().is_success() {
        return Err(Error::Request);
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Request)?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(Error::Request);
    }
    let body = std::str::from_utf8(&bytes).map_err(|_| Error::Request)?;
    let balance = csw_provider_balance_script::parse(&script.script, body)?;
    Ok(ProviderBalance {
        api_amount: Some(balance.amount),
        api_unit: balance.currency,
        api_unlimited: false,
        wallet_amount: None,
        wallet_unit: String::new(),
        wallet_error: None,
        balance_items: Vec::new(),
        queried_at: chrono::Utc::now().timestamp(),
    })
}
