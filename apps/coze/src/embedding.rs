use crate::error::{Error, Result};
use candle_core::{Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tokenizers::{Tokenizer, TruncationParams};

pub const MODEL_ID: &str = "multilingual-e5-small:614241f622f53c4eeff9890bdc4f31cfecc418b3";
const MAX_TOKENS: usize = 512;

/// A replaceable interface lets knowledge tests use deterministic vectors without downloading weights.
pub trait Embedder: Send + Sync {
    fn encode(&self, text: &str, query: bool) -> Result<Vec<f32>>;
    fn model_id(&self) -> &str;
}

pub struct LocalEmbedder {
    root: PathBuf,
    model: Mutex<Option<Model>>,
}

struct Model {
    bert: BertModel,
    tokenizer: Tokenizer,
}

impl LocalEmbedder {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
            model: Mutex::new(None),
        }
    }
}

impl Embedder for LocalEmbedder {
    fn encode(&self, text: &str, query: bool) -> Result<Vec<f32>> {
        let mut guard = self.model.lock().map_err(|_| Error::Embedding)?;
        if guard.is_none() {
            *guard = Some(Model::load(&self.root)?);
        }
        guard.as_ref().ok_or(Error::Embedding)?.encode(text, query)
    }

    fn model_id(&self) -> &str {
        MODEL_ID
    }
}

impl Model {
    fn load(root: &Path) -> Result<Self> {
        let config: Config = serde_json::from_slice(&std::fs::read(root.join("config.json"))?)
            .map_err(|_| Error::Embedding)?;
        let mut tokenizer =
            Tokenizer::from_file(root.join("tokenizer.json")).map_err(|_| Error::Embedding)?;
        tokenizer
            .with_padding(None)
            .with_truncation(Some(TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(|_| Error::Embedding)?;
        // Owned weights avoid an unsafe mmap whose file could be replaced during a runtime update.
        let bytes = std::fs::read(root.join("model.safetensors"))?;
        let weights = VarBuilder::from_buffered_safetensors(bytes, DTYPE, &Device::Cpu)
            .map_err(|_| Error::Embedding)?;
        let bert = BertModel::load(weights, &config).map_err(|_| Error::Embedding)?;
        Ok(Self { bert, tokenizer })
    }

    fn encode(&self, text: &str, query: bool) -> Result<Vec<f32>> {
        let prefix = if query { "query: " } else { "passage: " };
        let tokens = self
            .tokenizer
            .encode(format!("{prefix}{text}"), true)
            .map_err(|_| Error::Embedding)?;
        let run = || -> candle_core::Result<Vec<f32>> {
            let ids = Tensor::new(tokens.get_ids(), &Device::Cpu)?.unsqueeze(0)?;
            let types = ids.zeros_like()?;
            let output = self.bert.forward(&ids, &types, None)?;
            let pooled = (output.sum(1)? / tokens.len() as f64)?;
            let normalized = pooled.broadcast_div(&pooled.sqr()?.sum_keepdim(1)?.sqrt()?)?;
            normalized.squeeze(0)?.to_vec1()
        };
        run().map_err(|_| Error::Embedding)
    }
}

pub fn validate_vector(vector: &[f32]) -> Result<()> {
    if vector.is_empty() || vector.len() > 4096 || vector.iter().any(|value| !value.is_finite()) {
        return Err(Error::Embedding);
    }
    Ok(())
}

pub fn encode_vector(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

pub fn similarity(query: &[f32], bytes: &[u8]) -> f32 {
    if bytes.len() != query.len() * 4 {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm = 0.0;
    let query_norm: f32 = query.iter().map(|value| value * value).sum();
    for (value, bytes) in query.iter().zip(bytes.as_chunks::<4>().0) {
        let other = f32::from_le_bytes(*bytes);
        if !other.is_finite() {
            return 0.0;
        }
        dot += value * other;
        norm += other * other;
    }
    let denominator = (norm * query_norm).sqrt();
    if denominator > 0.0 {
        dot / denominator
    } else {
        0.0
    }
}
