$dir = 'C:\TechProjects\About_MyRepos\About_Games\mhr-roguelike-research\native\webconsole'
$p = Start-Process -FilePath (Join-Path $dir 'webconsole_test.exe') -WorkingDirectory $dir -PassThru
Start-Sleep -Seconds 6
if ($p.HasExited) { Write-Output ("EXITED code=" + $p.ExitCode) } else { Write-Output "RUNNING at 6s" }
try {
    $r = Invoke-WebRequest 'http://127.0.0.1:11777/api/health' -UseBasicParsing -TimeoutSec 3
    Write-Output ("health: " + $r.Content)
} catch { Write-Output "health-fail" }
Start-Sleep -Seconds 6
if (-not $p.HasExited) { Write-Output "still running at 12s - stopping"; Stop-Process -Id $p.Id -Force } else { Write-Output ("DIED code=" + $p.ExitCode) }
