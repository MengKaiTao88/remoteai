[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BridgePath,
    [string]$Destination = (Join-Path $PSScriptRoot '../../.artifacts/official-codex-test')
)
$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$expectedBridgeRevision = '0721aa7dafa6177751ba7e568e0ad0efee05655b'
$actualBridgeRevision = (& git -C $BridgePath rev-parse HEAD).Trim()
if ($actualBridgeRevision -ne $expectedBridgeRevision) { throw 'Unexpected Bridge source revision.' }
$buildRoot = Join-Path $repositoryRoot 'apps/desktop/src-tauri/target/debug'
$executable = Join-Path $buildRoot 'csw.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Build the Windows test executable first.' }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$Destination = (Resolve-Path -LiteralPath $Destination).Path
Copy-Item -LiteralPath $executable -Destination (Join-Path $Destination 'RemoteAI-OfficialCodex.exe')
foreach ($folder in @($buildRoot, (Join-Path $buildRoot 'deps'))) {
    foreach ($name in @('easytier_core.dll', 'csw_chat_connectivity.dll')) {
        $library = Join-Path $folder $name
        if (Test-Path -LiteralPath $library) { Copy-Item -LiteralPath $library -Destination $Destination -Force }
    }
}
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'apps/desktop/src-tauri/resources') `
    -Destination $Destination -Recurse -Force
foreach ($name in @('Start.cmd', 'Start-OfficialCodex.ps1', 'initialize_gateway.py', 'run_gateway.py',
    'native_history.py', 'image_archive.py', 'native_usage.py', 'native_permissions.py', 'native_protocol.py')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $Destination -Force
}
$archive = Join-Path $Destination 'bridge-source.zip'
& git -C $BridgePath archive --format=zip -o $archive $expectedBridgeRevision
if ($LASTEXITCODE -ne 0) { throw 'Could not export the pinned Bridge source.' }
Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $Destination 'codex-mobile-bridge') -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'docs/official-codex-bridge.md') `
    -Destination (Join-Path $Destination 'README.md') -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE') -Destination $Destination -Force
$manifest = @{
    kind = 'remoteai-official-codex-test'
    sourceRevision = (& git -C $repositoryRoot rev-parse HEAD).Trim()
    sourceWorkingTreeDirty = [bool](& git -C $repositoryRoot status --porcelain)
    bridgeRevision = $expectedBridgeRevision
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Destination 'RemoteAI-OfficialCodex.exe')).Hash
    privateRuntimeIncludedInShareableArchive = $false
}
$manifest | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $Destination 'build-info.json')
Write-Output $Destination
