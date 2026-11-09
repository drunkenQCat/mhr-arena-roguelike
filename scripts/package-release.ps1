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
$capabilitiesText = & node (Join-Path $PSScriptRoot 'release-capabilities.js')
if ($LASTEXITCODE -ne 0) { throw 'Release capabilities differ from the runtime sources.' }
$capabilities = $capabilitiesText | ConvertFrom-Json
$frameworkRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $FrameworkDirectory))
$stageRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $StageDirectory))
$archivePath = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputArchive))
# Never recursively delete a caller-supplied path. CI uses a fresh staging folder.
if (Test-Path -LiteralPath $stageRoot) {
    if ((Get-ChildItem -LiteralPath $stageRoot -Force | Measure-Object).Count -ne 0) {
        throw 'StageDirectory must be empty. Choose a fresh directory; existing files are never deleted.'
    }
}
if (Test-Path -LiteralPath $archivePath) { throw "Output archive already exists: $archivePath" }
$spec = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-files.json') -Raw -Encoding utf8 | ConvertFrom-Json
foreach ($entry in $spec) {
    $base = if ($entry.root -eq 'framework') { $frameworkRoot } else { $repoRoot }
    if (-not (Test-Path -LiteralPath (Join-Path $base $entry.source) -PathType Leaf)) {
        throw "Required release input missing: $($entry.source)"
    }
}
$revision = & git -C $frameworkRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify REFramework source revision.' }
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
foreach ($entry in $spec) {
    $base = if ($entry.root -eq 'framework') { $frameworkRoot } else { $repoRoot }
    $destination = Join-Path $stageRoot $entry.destination
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $base $entry.source) -Destination $destination
}
Set-Content -LiteralPath (Join-Path $stageRoot 'reframework_pictographic.mode') -Value 'Enable REFramework embedded CJK font.' -Encoding ascii
Set-Content -LiteralPath (Join-Path $stageRoot '打开电脑控制台.url') -Value "[InternetShortcut]`r`nURL=http://127.0.0.1:11777/console" -Encoding ascii
$manifest = [ordered]@{
    manifestSchemaVersion = 2
    product = 'MHR Arena Roguelike'
    version = $Version
    modRevision = $ModRevision
    sourceDirty = [bool](& git -C $repoRoot status --porcelain)
    reframeworkRevision = $revision.Trim()
    reframeworkRepository = 'https://github.com/drunkenQCat/REFramework'
    game = 'Monster Hunter Rise (Windows x64 Steam)'
    capabilitiesFile = 'release-capabilities.json'
    releaseStage = $capabilities.releaseStage
    probesIncluded = $false
    files = @(Get-ChildItem -LiteralPath $stageRoot -Recurse -File | ForEach-Object {
        [ordered]@{ path = [IO.Path]::GetRelativePath($stageRoot, $_.FullName).Replace('\','/'); bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stageRoot 'build-manifest.json') -Encoding utf8
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archivePath) | Out-Null
Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $archivePath -CompressionLevel Optimal
& (Join-Path $PSScriptRoot 'check-release.ps1') -Archive $archivePath
Write-Host "Verified player archive: $archivePath"
