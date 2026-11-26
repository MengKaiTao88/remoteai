# Windows 后台接管

Remote AI Handoff 在当前 Windows 用户的登录会话里运行。电脑端从官方 Cockpit Tools 启动默认 Codex，手机在原 Remote AI Web 打开已绑定设备和原会话。初次安装需要同一 Windows 账号上已经登录并绑定设备的 Remote AI 桌面端。服务迁移原设备绑定后，从独立目录运行。

## 打包和安装

在仓库根目录准备 Node 24、Windows Python 3.12 和已安装的 npm 依赖。打包使用 Windows 自带的 .NET Framework C# 编译器。准备 [Codex Mobile Bridge](https://github.com/try2love/codex-mobile-bridge) 源码检出，固定到 `0721aa7dafa6177751ba7e568e0ad0efee05655b`。

```powershell
$package = './.artifacts/cockpit-handoff-standalone/package'
./scripts/cockpit-handoff/Package.ps1 `
    -BridgePath '<Codex Mobile Bridge 检出目录>' `
    -Python '<Python 3.12 的 python.exe>' `
    -Destination $package
& (Join-Path $package 'Service.ps1') -Action Install
```

使用一个尚未存在的打包目录。服务安装到 `%LOCALAPPDATA%\Remote AI Handoff`，登录启动命令注册到当前用户。部署新版本时再次运行 `Install`，原设备绑定和现有自启选择会保留。初次安装完成后退出 Remote AI 桌面端，让独立服务接管原设备。若旧浏览器助手会自动启动桌面端，在 Chrome 中停用旧助手后复测。

## 日常运行

- 电脑从 Cockpit 启动默认 Codex，手机沿用原 Web 账号和设备。先打开该实例里的现有会话，便可继续文字对话。
- Cockpit 留在托盘时，模型 API 继续服务。模型 API 停止期间可以查看会话历史，生成回复需要 Cockpit 的 API 恢复。
- 服务以 Windows 登录为启动条件。Codex 会话接管以默认 Codex 实例运行并能接入本机桥接为条件。

```powershell
$service = Join-Path $env:LOCALAPPDATA 'Remote AI Handoff/Service.ps1'
& $service -Action Status
```

`Status` 显示登录自启、独立进程数量和设备连接状态。`Start` 和 `Stop` 管理本次运行。`Enable` 开启自启并启动服务，`Disable` 关闭自启并停止服务。`Remove` 移除服务程序和登录启动项、撤销服务凭据，并保留其他本地状态供排查或恢复。
