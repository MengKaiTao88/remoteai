//! Reuse the normal GUI validation for single, queued and steering messages.
use super::{
    error::{GuiError, Result},
    prompt::{batch_params, PromptInput, TurnOptions},
    protocol::GuiRequest,
};
use serde_json::{json, Value};

pub(super) fn request(request: GuiRequest) -> Result<Value> {
    let (thread_id, messages, turn_id) = match request {
        GuiRequest::Send {
            thread_id,
            transfer_mode,
            text,
            images,
            skills,
            attachments,
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
        ),
        GuiRequest::SendBatch {
            thread_id,
            messages,
            ..
        } => (thread_id, messages, None),
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
        "threadId": thread_id, "turnId": turn_id, "input": params["input"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(body.get("model").is_none());
    }
}
