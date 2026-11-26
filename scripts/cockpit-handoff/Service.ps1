[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Install','Start','Stop','Status','Disable','Enable','Remove')][string]$Action
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'Remote AI Handoff'
$app = Join-Path $root 'app'
$state = Join-Path $root 'state'
$launcher = Join-Path $app 'RemoteAIHandoff.exe'
$node = Join-Path $app 'node.exe'
$hostScript = Join-Path $app 'host.mjs'
$python = Join-Path $app 'runtime/python/python.exe'
$startup = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startupName = 'Remote AI Handoff'
$startupCommand = '"' + $launcher + '"'

function StartupValue {
    $key = Get-Item -LiteralPath $startup -ErrorAction SilentlyContinue
    if ($key) { $key.GetValue($startupName) }
}

function StartupEnabled { (StartupValue) -eq $startupCommand }

function SetStartup([bool]$enabled) {
    if ($enabled) {
        if (-not (Test-Path -LiteralPath $startup)) { New-Item -Path $startup | Out-Null }
        $existing = StartupValue
        if ($null -ne $existing -and $existing -ne $startupCommand) { throw 'HANDOFF_STARTUP_NAME_IN_USE' }
        New-ItemProperty -LiteralPath $startup -Name $startupName -Value $startupCommand -PropertyType String `
            -Force | Out-Null
    } elseif (StartupEnabled) {
        Remove-ItemProperty -LiteralPath $startup -Name $startupName
    }
}

function InstalledProcess($path, $arguments = '*') {
    $name = Split-Path $path -Leaf
    Get-CimInstance Win32_Process -Filter "Name = '$name'" | Where-Object {
        $_.ExecutablePath -ieq $path -and $_.CommandLine -like $arguments
    }
}

function InstalledWorkers { InstalledProcess $node '*host.mjs* run *' }

function StopInstalledProcess($path, $arguments = '*') {
    foreach ($instance in (InstalledProcess $path $arguments)) {
        Stop-Process -Id $instance.ProcessId -ErrorAction SilentlyContinue
    }
    if (InstalledProcess $path $arguments) { throw 'HANDOFF_STOP_FAILED' }
}

function StopWorkers {
    StopInstalledProcess $launcher
    StopInstalledProcess $node '*host.mjs* run *'
    StopInstalledProcess $python '*native.py*'
}

function WorkerStatus {
    $path = Join-Path $state 'status.json'
    if (Test-Path -LiteralPath $path) { Get-Content -Raw -LiteralPath $path | ConvertFrom-Json }
}

function StartHandoff {
    if (-not (InstalledProcess $launcher)) {
        Start-Process -FilePath $launcher -WorkingDirectory $app -WindowStyle Hidden
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $status = WorkerStatus
        if ($status -and $status.stage -ne 'stopped' -and (InstalledWorkers).ProcessId -contains $status.pid) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'HANDOFF_START_FAILED'
}

function VerifyOwnedDirectory($path) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.FullName -ine [IO.Path]::GetFullPath($path) -or
        $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'HANDOFF_INSTALL_DIRECTORY_INVALID' }
}

function InstallHandoff {
    $package = Join-Path $PSScriptRoot 'app'
    if (-not (Test-Path -LiteralPath (Join-Path $package 'runtime-info.json') -PathType Leaf)) {
        throw 'HANDOFF_PACKAGE_REQUIRED'
    }
    $binding = Join-Path $state 'binding.bin'
    if (-not (Test-Path -LiteralPath $binding) -and
        (Get-Service -Name CodexSwitchRemoteDesktop -ErrorAction SilentlyContinue)) {
        throw 'HANDOFF_DEVICE_ALREADY_HAS_SERVICE'
    }
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    VerifyOwnedDirectory $root
    VerifyOwnedDirectory $state
    $stage = Join-Path $root ('stage-' + [guid]::NewGuid())
    $previous = Join-Path $root ('previous-' + [guid]::NewGuid())
    $wasEnabled = StartupEnabled
    $wasRunning = [bool](InstalledWorkers)
    $created = -not (Test-Path -LiteralPath $app)
    Copy-Item -LiteralPath $package -Destination $stage -Recurse
    & (Join-Path $stage 'node.exe') (Join-Path $stage 'host.mjs') pair $state
    if ($LASTEXITCODE -ne 0) { throw 'HANDOFF_PAIRING_FAILED' }
    StopWorkers
    if (-not $created) { VerifyOwnedDirectory $app; Move-Item -LiteralPath $app -Destination $previous }
    try {
        Move-Item -LiteralPath $stage -Destination $app
        StartHandoff
        SetStartup ($created -or $wasEnabled)
        Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $root 'Service.ps1') -Force
    } catch {
        StopWorkers
        SetStartup $wasEnabled
        if (Test-Path -LiteralPath $app) { Move-Item -LiteralPath $app -Destination $stage }
        if (Test-Path -LiteralPath $previous) {
            Move-Item -LiteralPath $previous -Destination $app
            if ($wasRunning) { StartHandoff }
        }
        throw
    }
}

switch ($Action) {
    'Install' { InstallHandoff }
    'Start' { StartHandoff }
    'Stop' { StopWorkers }
    'Status' {
        $workers = @(InstalledWorkers)
        $status = WorkerStatus
        $current = $workers.ProcessId -contains $status.pid
        $stage = if ($current -and $status) { $status.stage } elseif ($workers) { 'starting' } else { 'stopped' }
        $launcherStatus = Join-Path $state 'launcher-status.txt'
        if (-not $workers -and (InstalledProcess $launcher) -and (Test-Path -LiteralPath $launcherStatus)) {
            $stage = Get-Content -LiteralPath $launcherStatus -TotalCount 1
        }
        [pscustomobject]@{ Startup = if (StartupEnabled) { 'Enabled' } else { 'Disabled' }; Instances = $workers.Count
            Online = $current -and $status.online; Stage = $stage }
    }
    'Disable' { SetStartup $false; StopWorkers }
    'Enable' { StartHandoff; SetStartup $true }
    'Remove' {
        SetStartup $false
        StopWorkers
        if (Test-Path -LiteralPath $node) {
            & $node $hostScript unpair $state
            if ($LASTEXITCODE -ne 0) { throw 'HANDOFF_UNPAIR_FAILED' }
        }
        if (Test-Path -LiteralPath $app) {
            VerifyOwnedDirectory $root
            VerifyOwnedDirectory $app
            Remove-Item -LiteralPath $app -Recurse
        }
    }
}
