//! An opt-in native backend for the existing GUI and authenticated Remote AI phone transport.
use super::{
    error::{GuiError, Result},
    protocol::{ApprovalReply, GuiEvent, GuiRequest, GuiResponse},
};
use csw_codex_desktop_bridge::Client;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::OnceCell;

#[derive(Default)]
pub(super) struct State(OnceCell<Arc<Client>>);

pub(super) fn enabled() -> bool {
    super::backend::current() == super::backend::Backend::Official
}

impl State {
    pub(super) async fn connect(&self, app: AppHandle) -> Result<Vec<GuiEvent>> {
        let client = self
            .0
            .get_or_try_init(|| async move {
                let config = super::gateway_runtime::config(app.clone()).await?;
                let client = Client::connect(config)
                    .await
                    .map_err(GuiError::OfficialBridge)?;
                let mut events = client.subscribe();
                tauri::async_runtime::spawn(async move {
                    loop {
                        match events.recv().await {
                            Ok(mut event) => {
                                if !enabled() {
                                    continue;
                                }
                                if event["method"] == "bridge/modelSettings" {
                                    super::web::publish(
                                        &app,
                                        "codex-gui-model-settings-changed",
                                        &event["params"],
                                    );
                                    continue;
                                }
                                super::official_sidebar::apply(&mut event).await;
                                super::web::publish(&app, "codex-gui-event", event);
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                // Force all viewers to reread authoritative history after bounded replay overflows.
                                super::web::publish(
                                    &app,
                                    "codex-gui-event",
                                    json!({"method": "connection/restored", "params": {}}),
                                );
                            }
                        }
                    }
                });
                Ok::<_, GuiError>(client)
            })
            .await?;
        client
            .pending()
            .await
            .into_iter()
            .map(|event| serde_json::from_value(event).map_err(|_| GuiError::InvalidRequest))
            .collect()
    }

    fn client(&self) -> Result<&Arc<Client>> {
        self.0.get().ok_or(GuiError::Disconnected)
    }

    pub(super) async fn request(&self, request: GuiRequest) -> Result<GuiResponse> {
        let mut window = None;
        let mut summary = false;
        let mut details = true;
        let body = match request {
            GuiRequest::Models { cache_only, cursor } => {
                json!({"operation": "models", "cacheOnly":cache_only, "cursor":cursor})
            }
            GuiRequest::Skills { .. } => json!({"operation": "skills"}),
            GuiRequest::Plugins { .. } => json!({"operation": "plugins"}),
            GuiRequest::List {
                limit,
                cursor,
                archived,
                search,
            } => {
                json!({"operation": "list", "limit": limit, "cursor": cursor, "archived": archived, "search": search})
            }
            GuiRequest::Read {
                thread_id,
                window: history,
                include_tool_details,
            } => {
                window = history;
                details = include_tool_details;
                json!({"operation": "read", "threadId": thread_id})
            }
            GuiRequest::ImagePreview {
                thread_id,
                source,
                variant,
                max_bytes,
            } => {
                let variant = match variant {
                    super::image_thumbnail::ImageVariant::Original => "original",
                    super::image_thumbnail::ImageVariant::Thumbnail => "thumbnail",
                };
                json!({"operation":"imagePreview", "threadId":thread_id,
                    "source":source, "variant":variant, "maxBytes":max_bytes})
            }
            GuiRequest::Resume {
                thread_id,
                summary_only,
                ..
            } => {
                summary = summary_only;
                json!({"operation": "resume", "threadId": thread_id})
            }
            request @ (GuiRequest::Send { .. }
            | GuiRequest::SendBatch { .. }
            | GuiRequest::Steer { .. }) => super::official_bridge_inputs::request(request)?,
            GuiRequest::Interrupt { thread_id, turn_id } => {
                json!({"operation": "interrupt", "threadId": thread_id, "turnId": turn_id})
            }
            GuiRequest::Rename { thread_id, name } => {
                json!({"operation": "rename", "threadId": thread_id, "name": name})
            }
            GuiRequest::ToolDetails(target) => {
                let mut value =
                    serde_json::to_value(target).map_err(|_| GuiError::InvalidRequest)?;
                value["operation"] = json!("toolDetails");
                value
            }
            _ => {
                return Err(GuiError::OfficialBridge(
                    csw_codex_desktop_bridge::Error::Unsupported,
                ))
            }
        };
        let mut data = self
            .client()?
            .request(body)
            .await
            .map_err(GuiError::OfficialBridge)?;
        super::official_sidebar::apply(&mut data).await;
        if let Some(window) = window {
            super::history_page::apply(&mut data, &window)?;
        }
        if summary {
            super::history_page::summarize(&mut data);
        }
        if !details {
            if let Some(thread) = data.get_mut("thread") {
                super::tool_details::summarize_thread(thread);
            }
        }
        Ok(GuiResponse { data })
    }

    pub(super) async fn respond(&self, reply: ApprovalReply) -> Result<()> {
        let reply: Value = serde_json::to_value(reply).map_err(|_| GuiError::InvalidRequest)?;
        self.client()?
            .respond(reply)
            .await
            .map_err(GuiError::OfficialBridge)
    }

    pub(super) async fn model_settings(&self, thread_id: Option<&str>) -> Result<Value> {
        let Some(id) = thread_id else {
            return Ok(json!({"threadId":null, "selection":null, "revision":0}));
        };
        self.client()?
            .model_settings(id)
            .await
            .map_err(GuiError::OfficialBridge)
    }

    pub(super) async fn set_model_settings(
        &self,
        thread_id: Option<&str>,
        selection: Value,
    ) -> Result<Value> {
        let id = thread_id.ok_or(GuiError::InvalidRequest)?;
        self.client()?
            .set_model_settings(id, &selection)
            .await
            .map_err(GuiError::OfficialBridge)
    }

    pub(super) async fn close(&self) {
        if let Some(client) = self.0.get() {
            client.close().await;
        }
    }
}
