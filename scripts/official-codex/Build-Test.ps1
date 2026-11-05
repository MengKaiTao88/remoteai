[CmdletBinding()]
param([string]$InstalledResources = '')
$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$output = Join-Path $repositoryRoot '.artifacts/official-codex-test'
New-Item -ItemType Directory -Force -Path $output | Out-Null
Push-Location $repositoryRoot
try {
    if ($InstalledResources) {
        foreach ($name in @('remote-desktop', 'desktop-service', 'chat-connectivity', 'x-server')) {
            $source = Join-Path $InstalledResources $name
            if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Missing installed resource: $name" }
            Copy-Item -LiteralPath $source -Destination 'apps/desktop/src-tauri/resources' -Recurse -Force
        }
    } else {
        foreach ($script in @('prepare-remote-desktop-runtime.mjs', 'prepare-x-server.mjs')) {
            & node (Join-Path 'scripts' $script)
            if ($LASTEXITCODE -ne 0) { throw "Runtime preparation failed: $script" }
        }
    }
    & node scripts/prepare-desktop-service.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Desktop service preparation failed.' }
    & npm.cmd run build:desktop
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    $configuration = @{
        productName = 'Remote AI Codex Test'; identifier = 'dev.codex.switch.bridge-test'
        build = @{ beforeBuildCommand = ''; frontendDist = '../dist' }
        bundle = @{ active = $false; createUpdaterArtifacts = $false }
        plugins = @{ updater = @{ endpoints = @() } }
    }
    $configurationPath = Join-Path $output 'tauri-test.json'
    [IO.File]::WriteAllText($configurationPath, ($configuration | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Push-Location 'apps/desktop'
    try {
        $previousDebug = $env:CARGO_PROFILE_DEV_DEBUG
        $env:CARGO_PROFILE_DEV_DEBUG = '0'
        & node ../../node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle --no-sign --config $configurationPath
        if ($LASTEXITCODE -ne 0) { throw 'Windows test build failed.' }
    } finally {
        $env:CARGO_PROFILE_DEV_DEBUG = $previousDebug
        Pop-Location
    }
} finally { Pop-Location }
