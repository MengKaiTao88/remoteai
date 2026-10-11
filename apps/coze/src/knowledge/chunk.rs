// Adapted from coze-dev/coze-studio, Copyright 2025 coze-dev Authors. Apache-2.0.
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChunkOptions {
    pub size: usize,
    pub overlap: usize,
}

impl Default for ChunkOptions {
    fn default() -> Self {
        Self {
            size: 500,
            overlap: 80,
        }
    }
}

/// Split by Unicode scalar values, retaining overlap even across paragraph boundaries.
pub fn split(text: &str, options: ChunkOptions) -> Result<Vec<String>> {
    if !(100..=2000).contains(&options.size) || options.overlap >= options.size / 2 {
        return Err(Error::Invalid);
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() > 2_000_000 {
        return Err(Error::Limit);
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let end = (start + options.size).min(chars.len());
        let text: String = chars[start..end].iter().collect();
        if !text.trim().is_empty() {
            chunks.push(text.trim().to_owned());
        }
        if end == chars.len() {
            break;
        }
        start = end - options.overlap;
    }
    if chunks.is_empty() {
        return Err(Error::EmptyDocument);
    }
    if chunks.len() > 5000 {
        return Err(Error::Limit);
    }
    Ok(chunks)
}
