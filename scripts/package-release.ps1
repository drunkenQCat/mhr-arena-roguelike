[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$FrameworkDirectory,
    [Parameter(Mandatory)][string]$StageDirectory,
    [Parameter(Mandatory)][string]$OutputArchive,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$ModRevision
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$frameworkRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $FrameworkDirectory))
$stageRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $StageDirectory))
$archivePath = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputArchive))

if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stageRoot | Out-Null

function Copy-RequiredFile([string]$Source, [string]$RelativeDestination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Required build output missing: $Source"
    }
    $destination = Join-Path $stageRoot $RelativeDestination
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $destination -Force
}

function Copy-RequiredDirectory([string]$Source, [string]$RelativeDestination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Required directory missing: $Source"
    }
    $destination = Join-Path $stageRoot $RelativeDestination
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -Path (Join-Path $Source '*') -Destination $destination -Recurse -Force
}

$frameworkBuild = Join-Path $frameworkRoot 'build'
Copy-RequiredFile (Join-Path $frameworkBuild 'bin/MHRISE/dinput8.dll') 'dinput8.dll'
Copy-RequiredFile (Join-Path $frameworkRoot 'dependencies/openvr/bin/win64/openvr_api.dll') 'openvr_api.dll'
Copy-RequiredFile (Join-Path $frameworkBuild '_deps/openxr-build/src/loader/Release/openxr_loader.dll') 'openxr_loader.dll'
Copy-RequiredDirectory (Join-Path $frameworkRoot 'scripts') 'reframework/autorun'

$modBundle = Join-Path $repoRoot 'reframework/autorun/mhw_rogue.lua'
Copy-RequiredFile $modBundle 'reframework/autorun/mhw_rogue.lua'
Copy-RequiredFile (Join-Path $repoRoot 'reframework/autorun/webconsole_probe_auto.lua') 'reframework/autorun/webconsole_probe_auto.lua'
Copy-RequiredFile (Join-Path $repoRoot 'reframework/autorun/lua/webconsole_probe.lua') 'reframework/autorun/lua/webconsole_probe.lua'
Copy-RequiredDirectory (Join-Path $repoRoot 'reframework/quests') 'reframework/quests'
Copy-RequiredFile (Join-Path $repoRoot 'data/rogue_config.json') 'reframework/data/mhw_rogue_config.json'
Copy-RequiredFile (Join-Path $repoRoot 'native/webconsole/webconsole.dll') 'reframework/plugins/webconsole.dll'
Copy-RequiredFile (Join-Path $repoRoot 'console/dist/index.html') 'reframework/plugins/console.html'
Set-Content -LiteralPath (Join-Path $stageRoot 'reframework_pictographic.mode') -Value 'Enable REFramework embedded CJK font.' -Encoding ascii
Copy-RequiredFile (Join-Path $repoRoot 'native/webconsole/reframework/LICENSE') 'THIRD-PARTY-LICENSES/REFramework-plugin-api-MIT.txt'
Copy-RequiredFile (Join-Path $frameworkRoot 'LICENSE') 'THIRD-PARTY-LICENSES/REFramework-MIT.txt'

Set-Content -LiteralPath (Join-Path $stageRoot 'DELETE_OPENVR_API_DLL_IF_YOU_WANT_TO_USE_OPENXR') -Value 'Remove openvr_api.dll if you use OpenXR.' -Encoding utf8
Set-Content -LiteralPath (Join-Path $stageRoot 'reframework_revision.txt') -Value (git -C $frameworkRoot rev-parse HEAD) -Encoding ascii

$installGuide = @'
MHR Arena Roguelike

INSTALL
1. Close Monster Hunter Rise.
2. Extract this archive directly into the game's root folder, next to MonsterHunterRise.exe.
3. Start the game. REFramework and the mod load automatically.
4. Open http://127.0.0.1:11777/console for the bundled web console.

The archive contains the built REFramework fork, the mod Lua bundle, the webconsole plugin,
and its single-file HTML frontend. The HTML includes its JavaScript and CSS; no Node.js server
or separate frontend assets are needed. The webconsole routes are served by webconsole.dll.

Build information is recorded in build-manifest.json. This release was built for the Windows
x64 Steam version of Monster Hunter Rise and expects REFramework's game-folder installation.
'@
Set-Content -LiteralPath (Join-Path $stageRoot 'INSTALL.txt') -Value $installGuide -Encoding utf8

$manifest = [ordered]@{
    product = 'MHR Arena Roguelike'
    version = $Version
    modRevision = $ModRevision
    reframeworkRevision = (git -C $frameworkRoot rev-parse HEAD).Trim()
    reframeworkRepository = 'https://github.com/drunkenQCat/REFramework'
    reframeworkRef = 'plugin-script-reset'
    game = 'Monster Hunter Rise (Windows x64)'
    webConsole = 'reframework/plugins/console.html with routes served by webconsole.dll'
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stageRoot 'build-manifest.json') -Encoding utf8

if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $archivePath -CompressionLevel Optimal
Write-Host "Release archive created: $archivePath"
