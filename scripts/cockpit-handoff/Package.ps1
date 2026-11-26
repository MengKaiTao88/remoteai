[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BridgePath,
    [Parameter(Mandatory)][string]$Python,
    [Parameter(Mandatory)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$revision = '0721aa7dafa6177751ba7e568e0ad0efee05655b'
if ((git -C $BridgePath rev-parse HEAD) -ne $revision) { throw 'BRIDGE_REVISION_MISMATCH' }
if ((& $Python --version) -notmatch '^Python 3\.12\.') { throw 'PYTHON_3_12_REQUIRED' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
if ((& $node --version) -notmatch '^v24\.') { throw 'NODE_24_REQUIRED' }
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'WINDOWS_LAUNCHER_COMPILER_REQUIRED' }
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw 'PACKAGE_DESTINATION_EXISTS' }
$app = Join-Path $Destination 'app'
$runtime = Join-Path $app 'runtime'
$pythonRoot = Split-Path -Parent (Resolve-Path -LiteralPath $Python).Path
$sourceArchive = Join-Path $Destination 'bridge.zip'
New-Item -ItemType Directory -Path (Join-Path $runtime 'python') -Force | Out-Null
git -C $BridgePath archive --format=zip -o $sourceArchive $revision
if ($LASTEXITCODE -ne 0) { throw 'BRIDGE_EXPORT_FAILED' }
Expand-Archive -LiteralPath $sourceArchive -DestinationPath (Join-Path $runtime 'codex-mobile-bridge')
Remove-Item -LiteralPath $sourceArchive
foreach ($item in (Get-ChildItem -LiteralPath $pythonRoot)) {
    if ($item.Name -in @('DLLs','Lib','python.exe','python3.dll','python312.dll','LICENSE.txt') -or
        $item.Name -like 'vcruntime140*.dll') {
        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $runtime 'python') -Recurse
    }
}
foreach ($name in @('image_archive.py','native_activity.py','native_history.py','native_permissions.py',
        'native_protocol.py','native_plugins.py','native_questions.py','native_queue.py','native_usage.py')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "../official-codex/$name") -Destination $runtime
}
Copy-Item -LiteralPath $node -Destination (Join-Path $app 'node.exe')
$nodeLicense = Join-Path (Split-Path -Parent $node) 'LICENSE'
if (Test-Path -LiteralPath $nodeLicense) { Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $app 'LICENSE.node') }
foreach ($name in @('native.py','native_composer.py','native_threads.py','vault.py')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $app
}
$launcherExe = Join-Path $app 'RemoteAIHandoff.exe'
& $compiler '/nologo' '/target:winexe' '/optimize+' "/out:$launcherExe" (Join-Path $PSScriptRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'HANDOFF_LAUNCHER_BUILD_FAILED' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Service.ps1') -Destination $Destination
& $node (Join-Path $PSScriptRoot 'bundle.mjs') (Join-Path $app 'host.mjs')
if ($LASTEXITCODE -ne 0) { throw 'HANDOFF_BUNDLE_FAILED' }
@{bridgeRevision=$revision; pythonVersion=(& $Python --version); nodeVersion=(& $node --version)} |
    ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $app 'runtime-info.json') -Encoding UTF8
Write-Output $Destination
