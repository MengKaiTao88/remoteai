use super::*;

/// Private installation input, separate from every public publication DTO.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MarketInstallation {
    entry_id: String,
    draft: models::Draft,
    api_key: String,
}
#[derive(Serialize)]
pub(crate) struct InstalledProvider {
    id: String,
}

fn personal_payload(input: &MarketInstallation, id: &str) -> Result<Value, MarketError> {
    let draft = &input.draft;
    validate_connection(draft)?;
    if let Some(page) = &draft.page_link {
        page.validate().map_err(|_| MarketError::Invalid)?;
    }
    if input.api_key.trim().is_empty()
        || input.api_key.len() > 10000
        || draft.models.is_empty()
        || draft.models.len() > 64
        || (!input.entry_id.is_empty() && !valid_id(&input.entry_id))
    {
        return Err(MarketError::Invalid);
    }
    if let Some(script) = &draft.balance_query {
        script
            .validate(&draft.base_url)
            .map_err(|_| MarketError::Invalid)?;
    }
    let formats: serde_json::Map<String, Value> = draft
        .models
        .iter()
        .map(|model| (model.id.clone(), json!(model.protocol)))
        .collect();
    let timestamp = Utc::now().to_rfc3339();
    let mut body = json!({"id":id, "kind":"custom", "name":draft.name,
        "baseUrl":draft.base_url.trim_end_matches('/'), "apiKey":input.api_key.trim(),
        "model":draft.models[0].id, "models":draft.models.iter().map(|model| &model.id).collect::<Vec<_>>(),
        "apiFormat":draft.models[0].protocol, "modelApiFormats":formats,
        "modelReasoningEfforts":{}, "modelContextWindows":{}, "imageInputModels":[],
        "modelSelectionControlledByCodex":true, "fastModeEnabled":true, "balanceScript":draft.balance_query,
        "lastModifiedAt":timestamp});
    body["marketSource"] = match (&draft.page_link, input.entry_id.is_empty()) {
        (Some(page), false) => json!({"id": input.entry_id, "page": page}),
        _ => Value::Null,
    };
    let versions: serde_json::Map<String, Value> = body
        .as_object()
        .ok_or(MarketError::Invalid)?
        .keys()
        .filter(|key| key.as_str() != "id" && key.as_str() != "lastModifiedAt")
        .map(|key| (key.clone(), json!(timestamp)))
        .collect();
    body["fieldModifiedAt"] = json!(versions);
    Ok(body)
}

fn validate_connection(draft: &models::Draft) -> Result<(), MarketError> {
    let url = url::Url::parse(&draft.base_url).map_err(|_| MarketError::Invalid)?;
    if draft.name.trim().is_empty()
        || draft.name.chars().count() > 80
        || draft.base_url.len() > 512
        || !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || draft.base_url.contains("..")
        || draft
            .base_url
            .chars()
            .any(|c| c.is_whitespace() || c == '\\')
        || url.path().split('/').any(|part| {
            part.len() > 32
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
    {
        return Err(MarketError::Invalid);
    }
    let mut seen = std::collections::HashSet::new();
    for model in &draft.models {
        if model.id.len() > 128
            || !model.id.starts_with(|c: char| c.is_ascii_alphanumeric())
            || !model
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'-'))
            || !seen.insert(&model.id)
        {
            return Err(MarketError::Invalid);
        }
    }
    Ok(())
}
fn install<R: Runtime>(
    app: &tauri::AppHandle<R>,
    identity: GuiCloudIdentity,
    input: MarketInstallation,
) -> Result<InstalledProvider, MarketError> {
    let id = Uuid::new_v4().to_string();
    let body = personal_payload(&input, &id)?;
    let client = api_client().map_err(|_| MarketError::Unavailable)?;
    let response = authenticated_request(
        app,
        Some(&identity),
        (Method::PUT, format!("/sync/providers/{id}"), Some(body)),
        &client,
    )?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            400 => MarketError::Invalid,
            401 => MarketError::Authentication,
            403 => MarketError::Forbidden,
            _ => MarketError::Unavailable,
        });
    }
    if !input.entry_id.is_empty() {
        // Statistics are best-effort after persistence; failure must never cause a duplicate installation.
        let usage = authenticated_request(
            app,
            Some(&identity),
            (
                Method::POST,
                format!("/provider-market/{}/usage", input.entry_id),
                Some(json!({"providerId":id})),
            ),
            &client,
        );
        if let Err(_error) = usage { /* Keep successful installation independent of usage reporting. */
        }
    }
    Ok(InstalledProvider { id })
}
/// Remote workspaces add to the existing personal cloud store, leaving device activation unchanged.
#[tauri::command]
pub(crate) async fn cloud_install_market_provider(
    app: tauri::AppHandle,
    identity: GuiCloudIdentity,
    input: MarketInstallation,
) -> Result<InstalledProvider, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app, identity, input))
        .await
        .map_err(|_| MarketError::Unavailable.to_string())?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_uses_allowlisted_fields_without_price_or_activation_changes() {
        let draft = json!({"name":"Example", "description":"", "baseUrl":"https://example.test/v1",
            "currency":"USD", "unit":"millionTokens", "models":[{"id":"m", "protocol":"openaiChat",
            "tiers":[{"multiplier":5,"input":100,"output":null,"cachedInput":null,
            "longContextThreshold":null,"longContext":{"input":null,"output":null,"cachedInput":null}}]}]});
        let input = MarketInstallation {
            entry_id: "".into(),
            draft: serde_json::from_value(draft).unwrap(),
            api_key: "own-key".into(),
        };
        let body = personal_payload(&input, "new-id").unwrap();
        assert_eq!(body["apiKey"], "own-key");
        assert_eq!(body["modelApiFormats"]["m"], "openaiChat");
        for field in [
            "active",
            "modelTokenCosts",
            "tiers",
            "official",
            "ownerId",
            "description",
        ] {
            assert!(body.get(field).is_none());
        }
    }
}
