$ErrorActionPreference = 'Stop'
$dir = 'C:\TechProjects\About_MyRepos\About_Games\mhr-roguelike-research\native\webconsole'
$p = Start-Process -FilePath "$dir\webconsole_test.exe" -WorkingDirectory $dir -PassThru
Start-Sleep -Seconds 3
if ($p.HasExited) {
    Write-Output ("EXITED code=" + $p.ExitCode)
    exit 1
}
Write-Output "RUNNING"
try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:11777/api/health' -UseBasicParsing -TimeoutSec 5
    Write-Output ("health: " + $r.StatusCode + " " + $r.Content)
    foreach ($ep in 'api/state','api/results','api/config') {
        try { $x = Invoke-WebRequest -Uri "http://127.0.0.1:11777/$ep" -UseBasicParsing -TimeoutSec 5; Write-Output ("GET " + $ep + ": " + $x.StatusCode) }
        catch { Write-Output ("GET " + $ep + ": HTTP " + $_.Exception.Response.StatusCode.value__) }
    }
    $body = '{"id":"t1","cmd":"setInvincible","value":true}'
    $y = Invoke-WebRequest -Uri 'http://127.0.0.1:11777/api/command' -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5
    Write-Output ("POST command: " + $y.StatusCode + " " + $y.Content)
    $z = Invoke-WebRequest -Uri 'http://127.0.0.1:11777/console' -UseBasicParsing -TimeoutSec 5
    Write-Output ("GET /console: " + $z.StatusCode)
} finally {
    Stop-Process -Id $p.Id -Force
}
