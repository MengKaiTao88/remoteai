# 由 Remote AI 后台接管默认 Codex 会话

Cockpit Tools 使用官方安装和更新渠道，负责启动默认 Codex 实例并提供模型 API。Remote AI 独立安装，随当前 Windows 用户登录启动，首版提供手机 Web 会话接管。后台启动创建隐藏的主 WebView，通过现有远程聊天通道注册已绑定的设备，手机继续从原网页入口连接。

## 验收

- Windows 登录后，Remote AI 通过现有登录启动设置运行一个实例。现有设备在手机 Web 上自动上线，Remote AI 主窗口保持隐藏。
- 从 Cockpit 启动默认 Codex 实例后，手机 Web 能打开已有会话并用同一会话 ID 收发消息。将 Cockpit 关闭到托盘后，手机仍能收发。
- 彻底退出 Cockpit 时，若默认 Codex 仍在运行，手机能查看会话历史。在 Cockpit 的模型 API 恢复后，手机可以继续生成回复。
- 默认 Codex 实例退出后，手机显示会话连接已断开。实例再次启动后，手机自动接回原会话。
- Cockpit 官方更新重启后，手机沿用已绑定的设备，回到同一个会话 ID。更新前的记录和恢复后发送的消息各显示一次。
