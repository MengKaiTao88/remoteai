use chrono::DateTime;
use reqwest::blocking::Client;
use serde_json::Value;

use crate::auth::{account_fields, is_agent_identity_auth, token_string};

const SUBSCRIPTION_URL: &str = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";

/// Query the selected account's current entitlement; login JWT claims can predate renewals.
pub(crate) fn subscription_expiration(
    client: &Client,
    auth: &Value,
) -> Result<Option<String>, String> {
    if is_agent_identity_auth(auth) {
        return Ok(None);
    }
    let token = token_string(auth, "access_token").ok_or("Missing subscription access token")?;
    let (_, _, account_id, _) = account_fields(auth)?;
    let mut request = client
        .get(SUBSCRIPTION_URL)
        .bearer_auth(token)
        .header("originator", super::ORIGINATOR)
        .header("User-Agent", "codex_cli_rs/0.1.0")
        .timeout(std::time::Duration::from_secs(10));
    if let Some(id) = &account_id {
        request = request.header("ChatGPT-Account-Id", id);
    }
    let response = request.send().map_err(|_| "Subscription request failed")?;
    if !response.status().is_success() {
        return Err(format!(
            "Subscription endpoint returned HTTP {}",
            response.status()
        ));
    }
    let payload: Value = response
        .json()
        .map_err(|_| "Invalid subscription response")?;
    selected_expiration(&payload, account_id.as_deref())
}

fn selected_expiration(
    payload: &Value,
    account_id: Option<&str>,
) -> Result<Option<String>, String> {
    let accounts = payload["accounts"]
        .as_object()
        .ok_or("Missing subscription accounts")?;
    // Never borrow another workspace's subscription just because it is first in the response.
    let account = match account_id {
        Some(id) => accounts.get(id).or_else(|| {
            accounts
                .get("default")
                .filter(|entry| entry["account"]["account_id"].as_str() == Some(id))
        }),
        None => accounts.get("default"),
    }
    .ok_or("Selected subscription account missing")?;
    let entitlement = account["entitlement"]
        .as_object()
        .ok_or("Missing subscription entitlement")?;
    if entitlement
        .get("has_active_subscription")
        .and_then(Value::as_bool)
        == Some(false)
    {
        return Ok(None);
    }
    match entitlement.get("expires_at") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => super::normalized_timestamp(Some(value))
            .map(Some)
            .ok_or_else(|| "Invalid subscription expiration".to_string()),
    }
}

/// Preserve refreshed subscription data when listing/syncing; past JWT dates are not current billing data.
pub(crate) fn cached_subscription_expiration(cached: Option<String>) -> Option<String> {
    cached.filter(|value| DateTime::parse_from_rfc3339(value).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn account(id: &str, expiration: Value) -> Value {
        json!({"account":{"account_id":id},"entitlement":{
            "has_active_subscription":true,"expires_at":expiration,
            "renews_at":"2026-11-30T08:48:41Z"}})
    }

    #[test]
    fn uses_selected_current_entitlement_instead_of_other_account_or_renewal() {
        let payload = json!({"accounts":{
            "other":account("other", json!("2026-08-24T12:58:09Z")),
            "selected":account("selected", json!("2026-11-30T22:48:41+08:00"))}});
        assert_eq!(
            selected_expiration(&payload, Some("selected"))
                .unwrap()
                .as_deref(),
            Some("2026-11-30T14:48:41+00:00")
        );
        assert!(selected_expiration(&payload, Some("missing")).is_err());
    }

    #[test]
    fn default_fallback_requires_matching_selected_account() {
        let payload =
            json!({"accounts":{"default":account("selected", json!("2026-11-30T14:48:41Z"))}});
        assert!(selected_expiration(&payload, Some("selected"))
            .unwrap()
            .is_some());
        assert!(selected_expiration(&payload, Some("other")).is_err());
    }

    #[test]
    fn missing_or_inactive_entitlement_clears_old_expiration_without_inventing_one() {
        let mut payload = json!({"accounts":{"selected":account("selected", Value::Null)}});
        assert_eq!(
            selected_expiration(&payload, Some("selected")).unwrap(),
            None
        );
        payload["accounts"]["selected"]["entitlement"]["has_active_subscription"] = json!(false);
        payload["accounts"]["selected"]["entitlement"]["expires_at"] =
            json!("2026-11-30T14:48:41Z");
        assert_eq!(
            selected_expiration(&payload, Some("selected")).unwrap(),
            None
        );
        payload["accounts"]["selected"]["entitlement"] = Value::Null;
        assert!(selected_expiration(&payload, Some("selected")).is_err());
    }

    #[test]
    fn refreshed_expiration_survives_account_list_and_cloud_sync() {
        let cached = Some("2026-11-30T14:48:41+00:00".to_string());
        assert_eq!(cached_subscription_expiration(cached.clone()), cached);
        assert_eq!(cached_subscription_expiration(None), None);
    }
}
