[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')][string]$Configuration = 'Release',
    [ValidateRange(0, 65535)][int]$Port = 0,
    [ValidateRange(0, 60)][int]$ObserveSeconds = 0,
    [switch]$HealthOnly,
    [string]$BinaryDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $BinaryDirectory) { $BinaryDirectory = $PSScriptRoot }
if ($Port -eq 0) {
    $reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $reservation.Start()
    $Port = $reservation.LocalEndpoint.Port
    $reservation.Stop()
} else {
    # Fail before starting if a game/test already owns this port.
    $reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $Port)
    try { $reservation.Start() } finally { $reservation.Stop() }
}
$name = if ($Configuration -eq 'Debug') { 'webconsole_dbg.exe' } else { 'webconsole_test.exe' }
$source = Join-Path $BinaryDirectory $name
if (-not (Test-Path -LiteralPath $source)) { throw "Missing $source. Run build.ps1 -Target Standalone -Configuration $Configuration first." }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('mhr-webconsole-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $temporary 'testdata') -Force | Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $temporary $name)
# Isolated fixtures: never read/write a user's game or checked-in testdata.
[IO.File]::WriteAllText((Join-Path $temporary 'console.html'), '<!doctype html><title>Native smoke test</title>')
foreach ($file in 'webconsole_state.json', 'webconsole_results.json', 'mhw_rogue_config.json') {
    [IO.File]::WriteAllText((Join-Path $temporary "testdata\$file"), '{"testMode":true}')
}
$stdout = Join-Path $temporary 'stdout.log'
$stderr = Join-Path $temporary 'stderr.log'
$process = $null
function Request([string]$Path) {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/$Path" -UseBasicParsing -TimeoutSec 2
}
try {
    $process = Start-Process -FilePath (Join-Path $temporary $name) -ArgumentList "$Port" -WorkingDirectory $temporary -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($process.HasExited) { throw "Server exited before readiness (code $($process.ExitCode))." }
        try {
            $health = Request 'api/health'
            $ready = ($health.Content | ConvertFrom-Json).plugin -eq 'webconsole'
            if ($ready) { break }
        } catch { Start-Sleep -Milliseconds 100 }
    }
    if (-not $ready) { throw "Server did not become ready on port $Port." }
    Write-Host "PASS health on port $Port"
    if (-not $HealthOnly) {
        foreach ($endpoint in 'api/state', 'api/results', 'api/config', 'console') {
            $response = Request $endpoint
            if ($response.StatusCode -ne 200) { throw "Unexpected status for $endpoint" }
            Write-Host "PASS GET /$endpoint"
        }
        $body = '{"id":"native-smoke","cmd":"getConfig"}'
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/command" -Method POST -Body $body -ContentType 'application/json' -Headers @{ Origin = "http://127.0.0.1:$Port" } -UseBasicParsing -TimeoutSec 2
        if (-not ($response.Content | ConvertFrom-Json).queued) { throw 'Command was not queued.' }
        $written = Get-Content -LiteralPath (Join-Path $temporary 'testdata\webconsole_cmd.json') -Raw | ConvertFrom-Json
        if ($written.id -ne 'native-smoke') { throw 'Mailbox did not preserve the request.' }
        Write-Host 'PASS POST /api/command and isolated mailbox'
    }
    if ($ObserveSeconds) { Start-Sleep -Seconds $ObserveSeconds }
    if ($process.HasExited) { throw "Server died during observation (code $($process.ExitCode))." }
} finally {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit()
    }
    if ($process) { $process.Dispose() }
    Write-Host "Test files/logs: $temporary"
}
