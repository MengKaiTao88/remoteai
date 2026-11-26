# 由 Remote AI 后台接管默认 Codex 会话

Cockpit Tools 使用官方安装和更新渠道，负责启动默认 Codex 实例并提供模型 API。手机继续从现有 Remote AI Web 入口接管原会话。Windows 后台服务单独安装，随当前用户登录启动，由无窗口启动器管理 Node 和 Python 进程。运行时和迁移后的设备绑定保存在服务自己的安装目录。

后台服务使用原设备的身份和协调器签发的设备凭据。凭据通过当前 Windows 用户的 DPAPI 保存。服务复用已部署的 Web 设备连接协议，通过本机桥接访问默认 Codex 实例。会话仍由官方 Codex 保存，发送、恢复和历史同步沿用原生会话 ID。

独立服务的安装和管理见 [Windows 后台接管](../cockpit-handoff.md)。需求和验收结果记录在 [GitHub #3](https://github.com/MengKaiTao88/remoteai/issues/3)。

## 验收

- Windows 登录后，后台启动项运行一个服务实例。现有设备在手机 Web 上自动上线，桌面无需打开 Remote AI。
- 从 Cockpit 启动默认 Codex 实例后，手机 Web 能打开已有会话并用同一会话 ID 收发消息。将 Cockpit 关闭到托盘后，手机仍能收发。
- 现有 Web 可在新对话加载完整模型目录、保存所选设置并发送首条消息。已有会话保存模型和推理强度后，下一轮使用已确认的设置。
- 彻底退出 Cockpit 时，若默认 Codex 仍在运行，手机能查看会话历史。在 Cockpit 的模型 API 恢复后，手机可以继续生成回复。
- 默认 Codex 实例退出后，手机显示会话连接断开。实例再次启动后，手机自动接回原会话。
- Cockpit 官方更新重启后，手机沿用已绑定的设备，回到同一个会话 ID。更新前的记录和恢复后发送的消息各显示一次。
