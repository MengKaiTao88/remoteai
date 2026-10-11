//! Revocable application capabilities for local collaboration; owner authentication stays desktop-owned.
mod commands;
mod permission;
mod storage;
#[cfg(test)]
mod tests;

use crate::{
    api::Services,
    error::{Error, Result},
    model::ResourceKind,
    resources,
};
pub use commands::{authorize, authorize_mcp};
pub use permission::Permit;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub use storage::{authenticate, initialize, issue, list, revoke, AccessIssue};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Tool,
    Viewer,
    Runner,
    Editor,
}

#[derive(Clone, Default)]
pub enum Principal {
    #[default]
    Owner,
    Shared(Grant),
}

#[derive(Clone)]
pub struct Grant {
    pub id: String,
    pub app_id: String,
    pub role: Role,
    pub(super) revisions: BTreeMap<String, u64>,
}

impl Principal {
    pub fn is_owner(&self) -> bool {
        matches!(self, Self::Owner)
    }

    pub fn info(&self) -> Value {
        match self {
            Self::Owner => json!({"role":"owner"}),
            Self::Shared(grant) => json!({"role":grant.role,"appId":grant.app_id}),
        }
    }

    pub fn allows(&self, id: &str) -> bool {
        match self {
            Self::Owner => true,
            Self::Shared(grant) => grant.revisions.contains_key(id),
        }
    }
}

pub fn scoped(services: &Services, principal: Principal) -> Services {
    let mut scoped = match &principal {
        Principal::Owner => services.clone(),
        Principal::Shared(grant) => services.with_revisions(grant.revisions.clone()),
    };
    scoped.principal = principal;
    scoped
}

pub(super) fn resource(services: &Services, id: &str) -> Result<()> {
    if !services.principal.allows(id) {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

pub(super) fn can_edit(services: &Services) -> Result<()> {
    if matches!(
        &services.principal,
        Principal::Shared(Grant {
            role: Role::Editor,
            ..
        }) | Principal::Owner
    ) {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}

pub(super) fn can_run(services: &Services, published: bool) -> Result<()> {
    match &services.principal {
        Principal::Owner => Ok(()),
        Principal::Shared(grant)
            if grant.role == Role::Editor
                || (matches!(grant.role, Role::Runner | Role::Tool) && published) =>
        {
            Ok(())
        }
        _ => Err(Error::Unauthorized),
    }
}

pub(super) fn editable_resource(services: &Services, id: &str) -> Result<()> {
    can_edit(services)?;
    resource(services, id)?;
    if resources::get(&services.db, id)?.kind == ResourceKind::App {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

pub(super) fn references(services: &Services, body: &Value) -> Result<()> {
    for id in crate::publications::references(body)? {
        resource(services, &id)?;
    }
    Ok(())
}

pub fn require_execution(services: &Services, kind: &str, id: &str) -> Result<()> {
    storage::ensure_active(services)?;
    if owns_execution(services, kind, id)? {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}

pub fn owns_execution(services: &Services, kind: &str, id: &str) -> Result<bool> {
    storage::owns(services, kind, id)
}

pub fn register_execution(services: &Services, kind: &str, id: &str) -> Result<()> {
    storage::remember(services, kind, id)
}
