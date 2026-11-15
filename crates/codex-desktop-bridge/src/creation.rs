//! Create an empty official chat once; message delivery remains a separate operation.
use super::{projection, Client, Error, Result};
use serde_json::{json, Value};
use std::sync::Arc;

const ATTACH_ATTEMPTS: usize = 40;
const ATTACH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

impl Client {
    pub(super) async fn start(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let title = request["title"].as_str().ok_or(Error::Invalid)?.trim();
        let access = request["access"].as_str().ok_or(Error::Invalid)?;
        if title.is_empty()
            || title.chars().count() > 120
            || title.chars().any(char::is_control)
            || !matches!(
                access,
                "read-only" | "workspace-write" | "danger-full-access"
            )
        {
            return Err(Error::Invalid);
        }
        let cwd = match &request["cwd"] {
            Value::Null => "",
            Value::String(value) if !value.chars().any(char::is_control) => value.as_str(),
            _ => return Err(Error::Invalid),
        };
        let project = if cwd.is_empty() {
            "local|independent".to_owned()
        } else {
            self.project_key(cwd).await?
        };
        let created = self
            .http
            .post(
                "/api/sessions?host=local",
                &json!({
                    "project":project, "title":title, "id":uuid::Uuid::new_v4().to_string()
                }),
            )
            .await?;
        let id = created["id"].as_str().ok_or(Error::UnknownWrite)?;
        uuid::Uuid::parse_str(id).map_err(|_| Error::UnknownWrite)?;
        // The first send must confirm this choice before submitting any user message.
        // Keep it pending if the desktop takes longer to open than the creation response.
        self.initial_access
            .lock()
            .await
            .insert(id.to_owned(), access.to_owned());
        let metadata = json!({"id":id,"title":title,"cwd":cwd,"connected":false});
        self.metadata
            .lock()
            .await
            .insert(id.to_owned(), metadata.clone());
        self.created_thread(id, metadata).await
    }

    async fn created_thread(self: &Arc<Self>, id: &str, mut view: Value) -> Result<Value> {
        for _ in 0..ATTACH_ATTEMPTS {
            if let Ok(current) = self
                .http
                .get(&format!("/api/sessions/{id}?host=local"))
                .await
            {
                view = current;
                if view["connected"] == true {
                    break;
                }
            }
            tokio::time::sleep(ATTACH_INTERVAL).await;
        }
        // Creation has succeeded even if attachment is still pending. Return its actual
        // identity so a failed first-send retry resumes this chat instead of creating another.
        let view = self.with_metadata(view).await;
        self.accept(&view).await?;
        self.watch(id).await?;
        Ok(json!({"thread":projection::thread(&view)}))
    }

    async fn project_key(&self, cwd: &str) -> Result<String> {
        let projects = self
            .http
            .get("/api/projects?entry=desktop&host=local")
            .await?;
        resolve_project(&projects["projects"], cwd)
    }
}

fn resolve_project(projects: &Value, cwd: &str) -> Result<String> {
    let wanted = normalize_cwd(cwd);
    let mut matches = projection::rows(projects).iter().filter(|project| {
        project["type"].as_str().unwrap_or("desktop") == "desktop"
            && project["cwd"]
                .as_str()
                .is_some_and(|value| normalize_cwd(value) == wanted)
            && project["key"]
                .as_str()
                .is_some_and(|key| key.starts_with("local|"))
    });
    let project = matches.next().ok_or(Error::Invalid)?;
    if matches.next().is_some() {
        return Err(Error::Invalid);
    }
    Ok(project["key"].as_str().ok_or(Error::Invalid)?.to_owned())
}

fn normalize_cwd(value: &str) -> String {
    if cfg!(windows) {
        value
            .replace('/', "\\")
            .trim_start_matches("\\\\?\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    } else {
        value.trim_end_matches('/').to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_resolution_requires_one_saved_local_desktop_project() {
        let projects = json!([
            {"key":"remote|other","cwd":"/project","type":"desktop"},
            {"key":"local|cli","cwd":"/project","type":"cli"},
            {"key":"local|expected","cwd":"/project","type":"desktop"}
        ]);
        assert_eq!(
            resolve_project(&projects, "/project/").unwrap(),
            "local|expected"
        );
        assert!(resolve_project(&projects, "/missing").is_err());
        let mut ambiguous = projects.clone();
        ambiguous.as_array_mut().unwrap().push(projects[2].clone());
        assert!(resolve_project(&ambiguous, "/project").is_err());
    }

    #[test]
    #[cfg(windows)]
    fn windows_project_paths_accept_separator_case_and_extended_prefix_variants() {
        assert_eq!(
            normalize_cwd("C:/Project/"),
            normalize_cwd("\\\\?\\c:\\project")
        );
    }
}
