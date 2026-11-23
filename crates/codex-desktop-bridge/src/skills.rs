//! Project genuine native skills without exposing the desktop's skill files.
use super::{projection::rows, thread_id, Client, Error, Result};
use serde_json::{json, Value};

const DRAFT: &str = "00000000-0000-0000-0000-000000000000";
const PAGE_SIZE: usize = 500;
const MAX_SKILLS: usize = 2_000;
pub(super) const MAX_REFERENCES: usize = 8;

pub fn skill_reference_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix("skill://")?;
    valid_id(id).then_some(id)
}

fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn public_skill(row: &Value) -> Option<Value> {
    let id = row["id"].as_str().filter(|id| valid_id(id))?;
    let name = row["name"].as_str().filter(|name| {
        !name.trim().is_empty() && name.len() <= 200 && !name.chars().any(char::is_control)
    })?;
    let label = row["displayName"]
        .as_str()
        .filter(|label| !label.trim().is_empty())
        .unwrap_or(name);
    let description: String = row["description"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(400)
        .collect();
    Some(
        json!({"path":format!("skill://{id}"), "name":name, "enabled":true,
        "description":description, "interface":{"displayName":label.chars().take(200).collect::<String>()}}),
    )
}

impl Client {
    pub(super) async fn skills(&self, request: &Value) -> Result<Value> {
        let query = if request["threadId"].is_null() {
            let project = match &request["cwd"] {
                Value::Null => "local|independent".to_owned(),
                Value::String(cwd) if !cwd.is_empty() => self.project_key(cwd).await?,
                _ => return Err(Error::Invalid),
            };
            let mut query = Self::skill_url(DRAFT, "remoteai-draft-skills")?;
            query.query_pairs_mut().append_pair("q", &project);
            query
        } else {
            Self::skill_url(thread_id(request)?, "remoteai-skills")?
        };
        let mut skills = Vec::new();
        let mut partial = false;
        for offset in (0..MAX_SKILLS).step_by(PAGE_SIZE) {
            let mut page = query.clone();
            page.query_pairs_mut()
                .append_pair("offset", &offset.to_string());
            let result = self
                .http
                .get(&format!(
                    "{}?{}",
                    page.path(),
                    page.query().unwrap_or_default()
                ))
                .await?;
            let entries = result["skills"].as_array().ok_or(Error::Unsupported)?;
            skills.extend(entries.iter().take(PAGE_SIZE).filter_map(public_skill));
            partial |= !rows(&result["errors"]).is_empty();
            if entries.len() < PAGE_SIZE
                || result["total"]
                    .as_u64()
                    .is_some_and(|total| total <= (offset + PAGE_SIZE) as u64)
            {
                break;
            }
            partial |= offset + PAGE_SIZE >= MAX_SKILLS;
        }
        let errors = if partial {
            vec![
                json!({"message":"client.workspaceActions.someSkillsCouldNotLoadReopenTheMenuToRetry"}),
            ]
        } else {
            vec![]
        };
        Ok(json!({"data":[{"skills":skills, "errors":errors}]}))
    }

    fn skill_url(id: &str, kind: &str) -> Result<reqwest::Url> {
        let mut url = reqwest::Url::parse(&format!("http://127.0.0.1/api/sessions/{id}/catalog"))
            .map_err(|_| Error::Invalid)?;
        url.query_pairs_mut()
            .append_pair("host", "local")
            .append_pair("kind", kind)
            .append_pair("limit", &PAGE_SIZE.to_string());
        Ok(url)
    }
}
