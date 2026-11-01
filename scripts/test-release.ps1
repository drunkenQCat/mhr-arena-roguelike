[CmdletBinding()]
param([Parameter(Mandatory)][string]$Archive)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$checker = Join-Path $PSScriptRoot 'check-release.ps1'
& $checker -Archive $Archive
$cases = @(
    @{ Name = 'extra autorun probe'; Mutate = { param($zip) $null = $zip.CreateEntry('reframework/autorun/unexpected_probe.lua') } },
    @{ Name = 'missing plugin'; Mutate = { param($zip) $zip.GetEntry('reframework/plugins/webconsole.dll').Delete() } },
    @{ Name = 'modified frontend'; Mutate = { param($zip)
        $entry = $zip.GetEntry('reframework/plugins/console.html'); $entry.Delete()
        $writer = [IO.StreamWriter]::new($zip.CreateEntry('reframework/plugins/console.html').Open())
        try { $writer.Write('tampered') } finally { $writer.Dispose() }
    } }
)
foreach ($case in $cases) {
    $testArchive = Join-Path ([IO.Path]::GetTempPath()) "mhr-release-test-$([Guid]::NewGuid().ToString('N')).zip"
    try {
        Copy-Item -LiteralPath $Archive -Destination $testArchive
        $zip = [IO.Compression.ZipFile]::Open($testArchive, [IO.Compression.ZipArchiveMode]::Update)
        try { & $case.Mutate $zip } finally { $zip.Dispose() }
        $rejected = $false
        try { & $checker -Archive $testArchive } catch { $rejected = $true }
        if (-not $rejected) { throw "Release audit accepted $($case.Name)" }
        Write-Host "PASS rejection: $($case.Name)"
    } finally { if (Test-Path -LiteralPath $testArchive) { Remove-Item -LiteralPath $testArchive } }
}
