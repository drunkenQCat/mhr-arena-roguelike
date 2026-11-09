[CmdletBinding()]
param([Parameter(Mandatory)][string]$Archive)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$spec = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-files.json') -Raw -Encoding utf8 | ConvertFrom-Json
$allowed = @($spec.destination) + @('reframework_pictographic.mode','打开电脑控制台.url','build-manifest.json')
$zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
    $names = @($zip.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace('\','/') })
    if (($names | Sort-Object -Unique).Count -ne $names.Count) { throw 'Duplicate files in archive.' }
    foreach ($name in $names) { if ($name -cnotin $allowed) { throw "Unexpected file in player archive: $name" } }
    foreach ($name in $allowed) { if ($name -cnotin $names) { throw "Missing file in player archive: $name" } }
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'build-manifest.json' }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    $manifestPaths = @($manifest.files.path)
    if (@($manifestPaths | Sort-Object -Unique).Count -ne ($allowed.Count - 1)) { throw 'Manifest file count is incorrect.' }
    foreach ($file in $manifest.files) {
        if ($file.path -eq 'build-manifest.json' -or $file.path -cnotin $allowed) { throw 'Invalid manifest entry.' }
        $entry = $zip.Entries | Where-Object { $_.FullName.Replace('\','/') -ceq $file.path }
        if (-not $entry -or $entry.Length -ne $file.bytes) { throw "Manifest size mismatch: $($file.path)" }
        $stream = $entry.Open(); $hash = [Security.Cryptography.SHA256]::Create()
        try { $actual = [Convert]::ToHexString($hash.ComputeHash($stream)).ToLowerInvariant() } finally { $stream.Dispose(); $hash.Dispose() }
        if ($actual -cne $file.sha256) { throw "Manifest hash mismatch: $($file.path)" }
    }
    if ($manifest.manifestSchemaVersion -ne 2 -or $manifest.probesIncluded -ne $false -or $manifest.capabilitiesFile -cne 'release-capabilities.json') { throw 'Incorrect release capability manifest.' }
    foreach ($legacyField in @('multiplayerSupported','multiplayerEntryExperimental','twoClientEntryVerified')) {
        if ($manifest.PSObject.Properties.Name -contains $legacyField) { throw "Ambiguous legacy capability field: $legacyField" }
    }
    $capabilitiesEntry = $zip.GetEntry('release-capabilities.json')
    $reader = [IO.StreamReader]::new($capabilitiesEntry.Open())
    try { $capabilitiesText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $validated = $capabilitiesText | & node (Join-Path $PSScriptRoot 'release-capabilities.js') --stdin
    if ($LASTEXITCODE -ne 0) { throw 'Invalid release capabilities in archive.' }
    $capabilities = $validated | ConvertFrom-Json
    if ($manifest.releaseStage -cne $capabilities.releaseStage) { throw 'Manifest release stage differs from capabilities.' }
    Write-Host "PASS: $($names.Count) allowlisted files, all hashes verified; no probes, example autoruns, logs or build intermediates."
} finally { $zip.Dispose() }
