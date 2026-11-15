//! Reuse the normal GUI validation for single, queued and steering messages.
use super::{
    error::{GuiError, Result},
    prompt::{batch_params, PromptInput, TurnOptions},
    protocol::GuiRequest,
};
use serde_json::{json, Value};

pub(super) fn start(request: GuiRequest) -> Result<Value> {
    let GuiRequest::Start { cwd, model, access } = request else {
        return Err(GuiError::InvalidRequest);
    };
    if let Some(model) = model.as_deref() {
        super::model_settings::validate_model(model).map_err(|_| GuiError::InvalidRequest)?;
    }
    // None means an independent official chat, not a standalone scratch workspace.
    Ok(
        json!({"operation":"start", "cwd":cwd, "model":model, "access":access,
        "title":crate::storage::native_text("新对话")}),
    )
}

pub(super) fn request(request: GuiRequest) -> Result<Value> {
    let (thread_id, messages, turn_id, model, effort) = match request {
        GuiRequest::Send {
            thread_id,
            transfer_mode,
            text,
            images,
            skills,
            attachments,
            model,
            effort,
            ..
        } => (
            thread_id,
            vec![PromptInput {
                transfer_mode,
                text,
                images,
                skills,
                attachments,
            }],
            None,
            model,
            effort,
        ),
        GuiRequest::SendBatch {
            thread_id,
            messages,
            model,
            effort,
            ..
        } => (thread_id, messages, None, model, effort),
        GuiRequest::Steer {
            thread_id,
            turn_id,
            transfer_mode,
            text,
            images,
            skills,
            attachments,
        } => (
            thread_id,
            vec![PromptInput {
                transfer_mode,
                text,
                images,
                skills,
                attachments,
            }],
            Some(turn_id),
            None,
            None,
        ),
        _ => return Err(GuiError::InvalidRequest),
    };
    let (_, params) = batch_params(
        thread_id.clone(),
        messages,
        TurnOptions {
            model: None,
            effort: None,
            cwd: None,
            access: None,
        },
    )?;
    Ok(
        json!({"operation": if turn_id.is_some() { "steer" } else { "send" },
        "threadId": thread_id, "turnId": turn_id, "input": params["input"], "model":model, "effort":effort}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_official_chat_keeps_independent_or_saved_project_scope_and_permissions() {
        for cwd in [None, Some("C:\\saved-project")] {
            let input = serde_json::from_value(json!({"operation":"start", "cwd":cwd,
                "model":"gpt-test", "access":"workspace-write"}))
            .unwrap();
            let mapped = start(input).unwrap();
            assert_eq!(mapped["operation"], "start");
            assert_eq!(mapped["cwd"], json!(cwd));
            assert_eq!(mapped["access"], "workspace-write");
            assert_eq!(mapped["model"], "gpt-test");
            assert!(!mapped["title"].as_str().unwrap().is_empty());
        }
    }

    #[test]
    fn queued_gui_batch_uses_the_same_validated_send_path() {
        let request: GuiRequest = serde_json::from_value(json!({"operation":"sendBatch",
        "threadId":"00000000-0000-4000-8000-000000000001", "messages":[
            {"text":"first", "images":[]}, {"text":"second", "images":[]}
        ]}))
        .unwrap();
        let body = super::request(request).unwrap();
        assert_eq!(body["operation"], "send");
        assert_eq!(body["input"][0]["text"], "first");
        assert_eq!(body["input"][1]["text"], "second");
        assert!(body["model"].is_null());
    }

    #[test]
    fn queued_gui_batch_preserves_explicit_model_and_effort() {
        let request: GuiRequest = serde_json::from_value(json!({"operation":"sendBatch",
            "threadId":"00000000-0000-4000-8000-000000000001", "messages":[{"text":"hello","images":[]}],
            "model":"model-b", "effort":"high"})).unwrap();
        let body = super::request(request).unwrap();
        assert_eq!(body["model"], "model-b");
        assert_eq!(body["effort"], "high");
    }
}
