$ErrorActionPreference = 'Continue'
$dir = 'C:\TechProjects\About_MyRepos\About_Games\mhr-roguelike-research\native\webconsole'
$exe = Join-Path $dir 'webconsole_test.exe'
$errLog = Join-Path $dir 'stderr.log'
$outLog = Join-Path $dir 'stdout.log'
Remove-Item $errLog, $outLog -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $exe -WorkingDirectory $dir -RedirectStandardError $errLog -RedirectStandardOutput $outLog -PassThru
Start-Sleep -Seconds 3
Write-Output ("HasExited=" + $p.HasExited + " ExitCode=" + $(if ($p.HasExited) { $p.ExitCode } else { 'n/a' }))
if (-not $p.HasExited) {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:11777/api/health' -UseBasicParsing -TimeoutSec 5
        Write-Output ("health: " + $r.StatusCode + " " + $r.Content)
    } catch { Write-Output ("health failed: " + $_.Exception.Message) }
    Stop-Process -Id $p.Id -Force
}
Write-Output "--- stderr ---"
if (Test-Path $errLog) { Get-Content $errLog }
Write-Output "--- stdout ---"
if (Test-Path $outLog) { Get-Content $outLog }
