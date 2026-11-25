//! The application owns the local gateway process; renderers never receive its credentials.
use super::error::{GuiError, Result};
use csw_codex_desktop_bridge::Config;
use serde::Deserialize;
use std::{process::Child, sync::Mutex};
use tauri::{AppHandle, Manager};

static PROCESS: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Deserialize)]
struct Credentials {
    port: u16,
    username: String,
    password: String,
}

fn resources(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        // Tauri canonicalizes the executable path. Windows PowerShell classifies a
        // verbatim \\?\ drive path as a remote script and rejects the local helper.
        .map(|root| {
            super::platform::execution_path(&root.join("resources/official-codex/runtime")).into()
        })
}

pub(super) fn available(app: &AppHandle) -> bool {
    cfg!(windows) && resources(app).is_some_and(|root| root.join("Ensure-Gateway.ps1").is_file())
}

pub(super) async fn config(app: AppHandle) -> Result<Config> {
    if let Some(config) = Config::from_env().map_err(GuiError::OfficialBridge)? {
        return Ok(config);
    }
    tauri::async_runtime::spawn_blocking(move || start(&app))
        .await
        .map_err(|_| GuiError::Startup)?
}

#[cfg(windows)]
fn record_preparation(runtime: &std::path::Path, status: &str) {
    // Fixed stage identifiers only: helper output includes the local gateway credential.
    if std::fs::create_dir_all(runtime)
        .and_then(|()| std::fs::write(runtime.join("gateway-status.txt"), status))
        .is_err()
    {
        eprintln!("Official gateway status could not be recorded");
    }
}

#[cfg(windows)]
fn helper_command(
    root: &std::path::Path,
    runtime: &std::path::Path,
) -> Result<std::process::Command> {
    use std::os::windows::process::CommandExt;
    // The desktop can inherit a PATH without the Windows PowerShell directory.
    let powershell =
        crate::desktop_service::platform::system_binary(r"WindowsPowerShell\v1.0\powershell.exe")
            .map_err(|_| GuiError::Startup)?;
    let mut command = std::process::Command::new(powershell);
    command
        .args(["-NoProfile", "-NonInteractive", "-File"])
        // Windows PowerShell must load its own modules even when launched from PowerShell 7.
        .env_remove("PSModulePath")
        .arg(root.join("Ensure-Gateway.ps1"))
        .arg("-RuntimeRoot")
        .arg(runtime)
        .arg("-BridgePath")
        .arg(root.join("codex-mobile-bridge"))
        .arg("-Python")
        .arg(root.join("python/python.exe"))
        .arg("-PrepareOnly")
        .creation_flags(0x08000000);
    Ok(command)
}

#[cfg(windows)]
fn prepare(root: &std::path::Path, runtime: &std::path::Path) -> Result<Credentials> {
    record_preparation(runtime, "preparing");
    let mut command = helper_command(root, runtime).inspect_err(|_| {
        record_preparation(runtime, "helper-system-directory-unavailable");
    })?;
    let output = command.output().map_err(|error| {
        record_preparation(
            runtime,
            &format!(
                "helper-spawn-failed:{:?}:{:?}",
                error.kind(),
                error.raw_os_error()
            ),
        );
        GuiError::Startup
    })?;
    // Never log these streams: the one-shot helper returns a DPAPI-protected local secret.
    if !output.status.success() || output.stdout.len() > 16 * 1024 {
        record_preparation(
            runtime,
            &format!(
                "helper-exit:{:?}:stderr-bytes:{}",
                output.status.code(),
                output.stderr.len()
            ),
        );
        return Err(GuiError::Startup);
    }
    serde_json::from_slice(&output.stdout).map_err(|_| {
        record_preparation(runtime, "helper-invalid-response");
        GuiError::Startup
    })
}

#[cfg(windows)]
fn start(app: &AppHandle) -> Result<Config> {
    use std::{fs::OpenOptions, os::windows::process::CommandExt, process::Stdio};
    let root = resources(app).ok_or(GuiError::Startup)?;
    let runtime = app
        .path()
        .app_data_dir()
        .map_err(|_| GuiError::Startup)?
        .join("official-codex");
    let mut owned = PROCESS.lock().map_err(|_| GuiError::Startup)?;
    if let Some(mut previous) = owned.take() {
        stop(&mut previous);
    }
    let credentials = prepare(&root, &runtime)?;
    let log = |name: &str| {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(runtime.join(name))
            .map_err(|_| GuiError::Startup)
    };
    let mut child = std::process::Command::new(root.join("python/python.exe"))
        .arg("-B")
        .arg(root.join("run_gateway.py"))
        .arg(root.join("codex-mobile-bridge"))
        .arg("--config")
        .arg(runtime.join("config.json"))
        .arg("--port")
        .arg(credentials.port.to_string())
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::null())
        .stdout(log("gateway.stdout.log")?)
        .stderr(log("gateway.stderr.log")?)
        .creation_flags(0x08000000 | 0x00000200)
        .spawn()
        .map_err(|_| GuiError::Startup)?;
    let url = format!("http://127.0.0.1:{}", credentials.port);
    if wait_ready(&url, &mut child).is_err() {
        stop(&mut child);
        record_preparation(&runtime, "gateway-not-ready");
        return Err(GuiError::Startup);
    }
    record_preparation(&runtime, "ready");
    *owned = Some(child);
    Config::new(&url, credentials.username, credentials.password).map_err(GuiError::OfficialBridge)
}

#[cfg(windows)]
fn wait_ready(url: &str, child: &mut Child) -> Result<()> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|_| GuiError::Startup)?;
    for _ in 0..30 {
        if child.try_wait().map_err(|_| GuiError::Startup)?.is_some() {
            return Err(GuiError::Startup);
        }
        if client
            .get(format!("{url}/api/auth"))
            .send()
            .is_ok_and(|reply| reply.status().is_success())
        {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    Err(GuiError::Startup)
}

fn stop(child: &mut Child) {
    if child.try_wait().is_ok_and(|status| status.is_none()) && child.kill().is_err() {
        eprintln!("Official gateway could not be stopped");
    }
    if child.wait().is_err() {
        eprintln!("Official gateway exit could not be confirmed");
    }
}

/// Called on a worker only, after viewers and the bridge have stopped.
pub(super) fn shutdown() {
    if let Ok(mut process) = PROCESS.lock() {
        if let Some(mut child) = process.take() {
            stop(&mut child);
        }
    }
}

#[cfg(not(windows))]
fn start(_app: &AppHandle) -> Result<Config> {
    Err(GuiError::OfficialBridge(
        csw_codex_desktop_bridge::Error::Unsupported,
    ))
}

#[cfg(all(test, windows))]
mod tests {
    use super::helper_command;

    #[test]
    fn helper_launches_from_the_system_path() {
        let root = tempfile::Builder::new()
            .prefix("gateway helper ")
            .tempdir()
            .unwrap();
        let runtime = root.path().join("test runtime");
        std::fs::write(
            root.path().join("Ensure-Gateway.ps1"),
            r#"param([string]$RuntimeRoot, [string]$BridgePath, [string]$Python, [switch]$PrepareOnly)
if (-not $PrepareOnly -or $RuntimeRoot -ne (Join-Path $PSScriptRoot 'test runtime')) { exit 1 }
Write-Output 'gateway-helper-ready'
"#,
        )
        .unwrap();

        let mut command = helper_command(root.path(), &runtime).unwrap();
        assert!(std::path::Path::new(command.get_program()).is_absolute());
        let output = command.env("PATH", root.path()).output().unwrap();

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "gateway-helper-ready"
        );
    }
}
