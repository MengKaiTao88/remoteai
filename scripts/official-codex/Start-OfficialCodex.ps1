[CmdletBinding()]
param(
    [string]$Executable = (Join-Path $PSScriptRoot 'RemoteAI-OfficialCodex.exe'),
    [string]$BridgePath = (Join-Path $PSScriptRoot 'codex-mobile-bridge'),
    [string]$Python = '',
    [int]$Port = 18797
)
$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path $PSScriptRoot 'private-runtime'
$configPath = Join-Path $runtimeRoot 'config.json'
$secretPath = Join-Path $runtimeRoot 'gateway-credential.xml'
$pidPath = Join-Path $runtimeRoot 'gateway-pid.json'
$environmentNames = @('REMOTEAI_CODEX_BRIDGE_URL', 'REMOTEAI_CODEX_BRIDGE_USERNAME',
    'REMOTEAI_CODEX_BRIDGE_PASSWORD', 'PYTHONDONTWRITEBYTECODE')
$savedEnvironment = @{}
foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }
try {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Remote AI test executable is missing.' }
    if (-not (Test-Path -LiteralPath (Join-Path $BridgePath 'run.py'))) { throw 'Codex Mobile Bridge source is missing.' }
    if (-not $Python) {
        $pythonCommand = Get-Command uv -ErrorAction SilentlyContinue
        if ($pythonCommand) { $Python = (& $pythonCommand.Source python find 3.12).Trim() }
        else {
            $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
            if ($pythonCommand) { $Python = $pythonCommand.Source }
        }
    }
    if (-not $Python -or -not (Test-Path -LiteralPath $Python)) { throw 'Python 3.12 is required. Install it using uv python install 3.12.' }
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    if (Test-Path -LiteralPath $secretPath) { $credential = Import-Clixml -LiteralPath $secretPath }
    else {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $securePassword = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
        $credential = New-Object Management.Automation.PSCredential('remoteai-bridge', $securePassword)
        $credential | Export-Clixml -LiteralPath $secretPath
    }
    $env:REMOTEAI_CODEX_BRIDGE_URL = "http://127.0.0.1:$Port"
    $env:REMOTEAI_CODEX_BRIDGE_USERNAME = $credential.UserName
    $env:REMOTEAI_CODEX_BRIDGE_PASSWORD = $credential.GetNetworkCredential().Password
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $existing = $null
    if (Test-Path -LiteralPath $pidPath) {
        $record = Get-Content -Raw -LiteralPath $pidPath | ConvertFrom-Json
        $candidate = Get-Process -Id $record.id -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.started) { $existing = $candidate }
    }
    if (-not $existing) {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
        try { $listener.Start() } finally { $listener.Stop() }
        & $Python (Join-Path $PSScriptRoot 'initialize_gateway.py') $BridgePath $configPath
        if ($LASTEXITCODE -ne 0) { throw 'Gateway configuration could not be prepared.' }
        $gatewayArguments = @('-B', ('"' + (Join-Path $BridgePath 'run.py') + '"'),
            '--config', ('"' + $configPath + '"'), '--port', $Port)
        $gateway = Start-Process -FilePath $Python -ArgumentList $gatewayArguments -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $runtimeRoot 'gateway.stdout.log') `
            -RedirectStandardError (Join-Path $runtimeRoot 'gateway.stderr.log')
        @{ id = $gateway.Id; started = $gateway.StartTime.ToUniversalTime().Ticks.ToString() } |
            ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $pidPath
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "$env:REMOTEAI_CODEX_BRIDGE_URL/api/auth" -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'Gateway did not start. See private-runtime/gateway.stderr.log.' }
    # Debug builds have a console. Hide it, then use single-instance activation to show the dashboard.
    $hostProcess = Start-Process -FilePath $Executable -WindowStyle Hidden -WorkingDirectory $PSScriptRoot -PassThru
    Start-Sleep -Milliseconds 1200
    if (-not $hostProcess.HasExited) {
        Start-Process -FilePath $Executable -WindowStyle Hidden -WorkingDirectory $PSScriptRoot | Out-Null
    }
} catch {
    $_.Exception.Message | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'startup-error.log')
    throw
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
}
