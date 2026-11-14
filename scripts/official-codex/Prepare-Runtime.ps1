[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BridgePath,
    [string]$Python = ''
)
$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$revision = '0721aa7dafa6177751ba7e568e0ad0efee05655b'
if ((& git -C $BridgePath rev-parse HEAD).Trim() -ne $revision) { throw 'Unexpected bridge revision.' }
if (-not $Python) {
    $uv = Get-Command uv -ErrorAction Stop
    $Python = (& $uv.Source python find 3.12).Trim()
}
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw 'Python 3.12 runtime is missing.' }
$destination = Join-Path $repositoryRoot 'apps/desktop/src-tauri/resources/official-codex/runtime'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$archive = Join-Path $destination 'bridge-source.zip'
& git -C $BridgePath archive --format=zip -o $archive $revision
if ($LASTEXITCODE -ne 0) { throw 'Could not export bridge source.' }
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $destination 'codex-mobile-bridge') -Force
$pythonRoot = Split-Path -Parent $Python
$pythonDestination = Join-Path $destination 'python'
New-Item -ItemType Directory -Force -Path $pythonDestination | Out-Null
Get-ChildItem -LiteralPath $pythonRoot | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $pythonDestination -Recurse -Force
}
foreach ($name in @('Ensure-Gateway.ps1', 'initialize_gateway.py', 'run_gateway.py',
    'native_history.py', 'image_archive.py', 'native_usage.py', 'native_permissions.py', 'native_protocol.py', 'native_queue.py',
    'native_questions.py')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $destination -Force
}
@{ bridgeRevision = $revision; pythonVersion = (& $Python --version) } |
    ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $destination 'runtime-info.json')
Write-Output $destination
