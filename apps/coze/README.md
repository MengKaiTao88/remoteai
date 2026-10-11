# Coze 的 Rust 本地运行包

Remote AI 通过左侧「插件」下方的 `coze` 入口安装此可选组件。首次打开只检查状态，用户点击下载后才获取独立签名包。主安装包不包含运行程序、编辑器或向量模型。

这是以 `F:/projects/coze-studio` 的 `fefb05ff27be1da939612fbf9faf5db62583b8ae` 为参考的 Rust 重实现。没有打包或启动上游 Go 后端，也不需要 Docker、MySQL、Redis、Elasticsearch、Milvus、Python 或 Node.js 运行环境。

## 当前实现与边界

| 上游职责 | Rust 实现 | 当前能力 |
| --- | --- | --- |
| 模型管理 | `src/proxy.rs` | 自动使用 Remote AI 的 Codex GUI 本地代理、模型目录和当前账户；不复制上游密钥 |
| 知识库 | `src/knowledge/`、`src/embedding.rs` | TXT/Markdown/PDF/DOCX/CSV/TSV/JSON/XLSX 导入、分段、编辑分段、中文本地向量检索、全文匹配、引用、删除 |
| 工作流 | `src/workflow/` | 可视化连线、输入参数、条件分支、模型、知识检索、模板、JSON、受限 JavaScript、HTTP、工具、数据表、子工作流、批量执行、运行记录 |
| 智能体与会话 | `src/agents.rs` | 角色配置、模型选择、知识库引用、多轮会话与本地历史 |
| 工具与 MCP | `src/plugins.rs`、`src/mcp.rs` | HTTPS 工具、发布工作流/智能体/知识库/工具到 PC；自动注册到外部 Codex Home 和内置 GUI Home |
| 提示词与数据 | `src/resources.rs`、`src/tables.rs` | 提示词库、记录增删改查、草稿乐观锁、不可变发布快照、导出和导入本运行包的资源定义 |

**尚未达到上游完整功能对等。** 不兼容全部上游 HTTP/Thrift 接口、画布和数据库导出。尚未迁移上游应用项目编排、市场、团队权限、Python/TypeScript 代码节点、需要暂停和恢复的人机交互/Chatflow 节点、SQL/NL2SQL、扫描文档 OCR、图片知识库、网页采集、智能体自主工具调用、流式输出及中途取消。普通 PDF 需包含可提取文字；上述限制不能表述成“整个 Coze 已完整移植”。

发布父工作流会固定自身画布；引用的子工作流和工具使用它们当前的已发布版本。知识库内容可继续更新。导出的资源定义不包含知识库原文件和索引，也不包含对话历史；它不是完整备份格式。

## 运行与数据

- Tauri 命令只委托阻塞工作线程。下载、解压、进程启动、配置访问及状态检查不占用窗口线程。
- 独立进程只监听 `127.0.0.1` 的随机端口。界面和 MCP 请求需要每次启动生成的凭据；拒绝其他网页来源。
- 启动信息通过 stdin 传递；父进程管道关闭后运行包退出。Windows 后台启动不弹出控制台。
- 数据位于应用数据目录的 `coze/data/coze.sqlite3`。WAL、外键和事务保证索引失败不留下半份文档，删除文档同时清理向量和全文记录。
- 组件位于 `coze/packages/<version>`，更换包不删除 `coze/data`。未完成的下载不产生安装完成标记。
- 向量模型为固定版本的 `multilingual-e5-small`，由 Candle 在 CPU 上运行；首次使用知识库时才载入内存，不再下载模型。
- MCP 工具 `coze_list` 返回当前发布内容和输入结构，`coze_call` 调用对应内容。草稿和停用内容不可调用；工具名稳定，因此新发布内容不要求重启会话。
- JavaScript 无文件、网络、模块加载等宿主能力，设有内存、栈、时间和输出限制。外部访问使用单独的 HTTPS 节点，不携带本地代理凭据。

## 开发验证

在仓库根目录执行：

```powershell
cargo test --manifest-path apps/coze/Cargo.toml
cargo clippy --manifest-path apps/coze/Cargo.toml --all-targets -- -D warnings
node node_modules/typescript/bin/tsc -p apps/coze/ui/tsconfig.json
node node_modules/vite/bin/vite.js build --config apps/coze/ui/vite.config.ts
node scripts/prepare-coze-model.mjs
cargo test --manifest-path apps/coze/Cargo.toml --test local_embedding -- --ignored
cargo build --manifest-path apps/coze/Cargo.toml
node scripts/package-coze.mjs apps/coze/target/debug/remoteai-coze.exe .codex-tmp/coze-package
node scripts/smoke-coze.mjs .codex-tmp/coze-package/remoteai-coze.exe
```

`package-coze.mjs` 要求新的输出目录。macOS/Linux 去掉 `.exe`。冒烟验证使用临时数据和测试模型代理，不修改用户知识库或真实模型配置；本地向量推理使用真实权重。

## 独立发布

`.github/workflows/coze-runtime.yml` 构建 Windows x64/ARM64、macOS x64/ARM64、Linux x64 的独立 ZIP，包含 Rust 程序、React 编辑器和知识库模型。发布标签来自 `runtime.json`，当前为 `coze-v0.1.0`；不会设为 Remote AI 的 latest，也不会被主应用 `v*` 标签规则重新触发。

主发布流程调用此工作流；也可以单独手动运行。包使用现有 `TAURI_SIGNING_PRIVATE_KEY` 签名，桌面端使用内置公钥验证后再解压。已发布版本不可覆盖，修改已发布运行包时必须同步更新 Cargo 版本及 `runtime.json`。下载端固定兼容版本，更新运行协议必须同步桌面适配。

本地构建通过不代表五个平台或 GitHub 签名发布已通过；生产下载需要对应 CI 任务成功发布，不能把尚不存在的 release 当作已经上线。
