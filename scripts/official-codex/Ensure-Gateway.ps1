[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$BridgePath,
    [Parameter(Mandatory = $true)][string]$Python,
    [switch]$ReadOnly,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$secretPath = Join-Path $RuntimeRoot 'gateway-credential.xml'
$configPath = Join-Path $RuntimeRoot 'config.json'
$pidPath = Join-Path $RuntimeRoot 'gateway-pid.json'
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw 'Packaged Python runtime is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $BridgePath 'run.py') -PathType Leaf)) {
    throw 'Packaged Codex bridge is missing.'
}
New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
if (Test-Path -LiteralPath $secretPath) { $credential = Import-Clixml -LiteralPath $secretPath }
else {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $securePassword = ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
    $credential = New-Object Management.Automation.PSCredential('remoteai-bridge', $securePassword)
    $credential | Export-Clixml -LiteralPath $secretPath
}
$existing = $null
if (Test-Path -LiteralPath $pidPath) {
    $record = Get-Content -Raw -LiteralPath $pidPath | ConvertFrom-Json
    $candidate = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.started) {
        $existing = $candidate
    }
}
if ($ReadOnly) {
    if (-not $existing -or -not $record.port) { throw 'Gateway is not running.' }
    @{url = "http://127.0.0.1:$($record.port)"; username = $credential.UserName;
        password = $credential.GetNetworkCredential().Password} | ConvertTo-Json -Compress
    exit 0
}
$savedEnvironment = @{}
foreach ($name in @('REMOTEAI_CODEX_BRIDGE_USERNAME', 'REMOTEAI_CODEX_BRIDGE_PASSWORD', 'PYTHONDONTWRITEBYTECODE')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
try {
    $env:REMOTEAI_CODEX_BRIDGE_USERNAME = $credential.UserName
    $env:REMOTEAI_CODEX_BRIDGE_PASSWORD = $credential.GetNetworkCredential().Password
    $env:PYTHONDONTWRITEBYTECODE = '1'
    if ($PrepareOnly) {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
        try { $listener.Start(); $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
        & $Python -B (Join-Path $PSScriptRoot 'initialize_gateway.py') $BridgePath $configPath
        if ($LASTEXITCODE -ne 0) { throw 'Gateway configuration could not be prepared.' }
        @{port = $port; username = $credential.UserName;
            password = $credential.GetNetworkCredential().Password} | ConvertTo-Json -Compress
        exit 0
    }
    if ($existing) { $port = [int]$record.port }
    else {
        $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
        try { $listener.Start(); $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
        & $Python -B (Join-Path $PSScriptRoot 'initialize_gateway.py') $BridgePath $configPath
        if ($LASTEXITCODE -ne 0) { throw 'Gateway configuration could not be prepared.' }
        $arguments = @('-B', ('"' + (Join-Path $BridgePath 'run.py') + '"'),
            '--config', ('"' + $configPath + '"'), '--port', $port)
        $gateway = Start-Process -FilePath $Python -ArgumentList $arguments -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $RuntimeRoot 'gateway.stdout.log') `
            -RedirectStandardError (Join-Path $RuntimeRoot 'gateway.stderr.log')
        @{ id = $gateway.Id; started = $gateway.StartTime.ToUniversalTime().Ticks.ToString(); port = $port } |
            ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $pidPath
    }
    $url = "http://127.0.0.1:$port"
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/auth" -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 300 }
    }
    if (-not $ready) { throw 'Gateway did not become ready.' }
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
}
