//! Code nodes use embedded Rust tooling; Python executes in a bounded disposable worker.
mod platform;
pub mod python;
mod typescript;
use crate::error::Result;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    #[default]
    Javascript,
    Typescript,
    Python,
}

pub fn javascript(language: Language, source: &str) -> Result<String> {
    match language {
        Language::Javascript => Ok(source.to_owned()),
        Language::Typescript => typescript::transpile(source),
        Language::Python => Err(crate::error::Error::Invalid),
    }
}
