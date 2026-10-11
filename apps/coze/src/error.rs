use serde::Serialize;

pub type Result<T> = std::result::Result<T, Error>;

/// Messages are safe to return across the local API boundary. Sources stay in local logs.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("内容不完整或格式有误，请检查后重试。")]
    Invalid,
    #[error("内容已被其他页面修改，请刷新后重试。")]
    Conflict,
    #[error("未找到这项内容，它可能已被删除。")]
    NotFound,
    #[error("暂时无法保存数据，请检查磁盘空间后重试。")]
    Storage(#[from] rusqlite::Error),
    #[error("文件处理失败，请检查文件后重试。")]
    File(#[from] std::io::Error),
    #[error("文件格式暂不支持，请使用 TXT、Markdown、PDF、DOCX、CSV、JSON 或 XLSX。")]
    Format,
    #[error("文件中没有可读取的文字。扫描文件请先转换为可选择文字的 PDF。")]
    EmptyDocument,
    #[error("本地知识库模型未准备好，请重新下载 Coze。")]
    Embedding,
    #[error("模型连接失败，请检查 Remote AI 中选择的账户或服务。")]
    Proxy,
    #[error("工作流连线或节点配置有误，请检查后重试。")]
    Workflow,
    #[error("运行已达到限制，请缩小输入或减少循环次数。")]
    Limit,
    #[error("请先发布此内容，再通过 MCP 调用。")]
    Unpublished,
    #[error("连接已失效，请重新打开 Coze。")]
    Unauthorized,
    #[error("外部请求未完成，请检查地址和服务状态。")]
    Network,
}

#[derive(Serialize)]
pub struct ApiError {
    pub error: String,
}

impl Error {
    pub fn status(&self) -> u16 {
        match self {
            Self::Unauthorized => 401,
            Self::NotFound => 404,
            Self::Conflict => 409,
            Self::Storage(_) | Self::File(_) | Self::Embedding => 500,
            Self::Proxy | Self::Network => 502,
            _ => 400,
        }
    }
}
