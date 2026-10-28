[CmdletBinding()]
param(
    [ValidateSet('Plugin', 'Standalone')][string]$Target = 'Plugin',
    [ValidateSet('Release', 'Debug')][string]$Configuration = 'Release',
    [string]$OutputDirectory,
    [string]$VisualStudioPath,
    [string]$VsWherePath
)
$ErrorActionPreference = 'Stop'
if (-not $OutputDirectory) { $OutputDirectory = $PSScriptRoot }

# Use Microsoft's environment setup rather than reconstructing INCLUDE/LIB/SDK paths.
if (-not $VisualStudioPath) {
    if (-not $VsWherePath) {
        $found = Get-Command vswhere.exe -ErrorAction SilentlyContinue
        if ($found) { $VsWherePath = $found.Source }
        else {
            $installerRoot = ${env:ProgramFiles(x86)}
            if (-not $installerRoot) { $installerRoot = $env:ProgramFiles }
            if ($installerRoot) { $VsWherePath = Join-Path $installerRoot 'Microsoft Visual Studio\Installer\vswhere.exe' }
        }
    }
    if ($VsWherePath -and (Test-Path -LiteralPath $VsWherePath)) {
        $VisualStudioPath = & $VsWherePath -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($LASTEXITCODE -ne 0) { throw 'vswhere failed to query Visual Studio installations.' }
        $VisualStudioPath = ($VisualStudioPath | Select-Object -First 1)
    } elseif ($env:VSINSTALLDIR) {
        $VisualStudioPath = $env:VSINSTALLDIR
    }
}
if (-not $VisualStudioPath) {
    throw 'Install Visual Studio / Build Tools with Desktop development with C++ and a Windows SDK, or pass -VisualStudioPath.'
}
$setup = Join-Path $VisualStudioPath 'VC\Auxiliary\Build\vcvarsall.bat'
if (-not (Test-Path -LiteralPath $setup)) { throw "C++ environment setup not found: $setup" }

if (-not [IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory = Join-Path (Get-Location).Path $OutputDirectory
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$work = Join-Path $PSScriptRoot ".build\$Target-$Configuration"
New-Item -ItemType Directory -Force -Path $OutputDirectory, $work | Out-Null
$stem = if ($Target -eq 'Plugin') { 'webconsole' } elseif ($Configuration -eq 'Debug') { 'webconsole_dbg' } else { 'webconsole_test' }
$extension = if ($Target -eq 'Plugin') { 'dll' } else { 'exe' }
$output = Join-Path $OutputDirectory "$stem.$extension"
$flags = @('/nologo', '/std:c++20', '/utf-8', '/EHsc', '/W3',
    ('"' + (Join-Path $PSScriptRoot 'src\plugin_main.cpp') + '"'),
    ('"' + (Join-Path $PSScriptRoot 'src\http_server.cpp') + '"'),
    ('/Fo"' + (Join-Path $work "$stem.obj") + '"'),
    ('/Fd"' + (Join-Path $work 'compiler.pdb') + '"'), ('/Fe"' + $output + '"'))
if ($Configuration -eq 'Debug') { $flags += @('/Od', '/Zi', '/MDd') }
else { $flags += @('/O2', '/MD', '/DNDEBUG') }
if ($Target -eq 'Plugin') { $flags += '/LD' }
else { $flags += '/DWEBCONSOLE_STANDALONE' }
$flags += @('/link', 'ws2_32.lib', 'crypt32.lib', '/MACHINE:X64', '/INCREMENTAL:NO',
    ('/IMPLIB:"' + (Join-Path $work "$stem.lib") + '"'))
if ($Configuration -eq 'Debug') {
    $flags += @('/DEBUG', ('/PDB:"' + (Join-Path $work "$stem.pdb") + '"'), ('/MAP:"' + (Join-Path $work "$stem.map") + '"'))
}
if ($Target -eq 'Plugin') {
    $flags += @('/EXPORT:reframework_plugin_required_version', '/EXPORT:reframework_plugin_initialize')
}
$responseFile = Join-Path $work 'compile.rsp'
# A BOM makes Unicode source/output paths unambiguous to MSVC response-file parsing.
[IO.File]::WriteAllText($responseFile, ($flags -join ' '), [Text.UTF8Encoding]::new($true))
$commandFile = Join-Path $work 'compile.cmd'
$commands = @('@echo off', 'call "%MHR_BUILD_SETUP%" x64 >nul',
    'if errorlevel 1 exit /b %errorlevel%', 'cd /d "%MHR_BUILD_WORK%"',
    'cl.exe @"%MHR_BUILD_RESPONSE%"', 'exit /b %errorlevel%')
# Keep batch contents ASCII; Unicode paths travel in the child environment.
[IO.File]::WriteAllLines($commandFile, $commands, [Text.Encoding]::ASCII)
Write-Host "Building $Target / $Configuration (x64) with $VisualStudioPath"
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $env:ComSpec
$start.Arguments = '/d /c ""' + $commandFile + '""'
$start.UseShellExecute = $false
$start.EnvironmentVariables['MHR_BUILD_SETUP'] = $setup
$start.EnvironmentVariables['MHR_BUILD_WORK'] = $work
$start.EnvironmentVariables['MHR_BUILD_RESPONSE'] = $responseFile
if ($VsWherePath -and (Test-Path -LiteralPath $VsWherePath)) {
    $start.EnvironmentVariables['PATH'] = (Split-Path -Parent $VsWherePath) + ';' + $env:PATH
}
$compiler = [Diagnostics.Process]::Start($start)
$compiler.WaitForExit()
$code = $compiler.ExitCode
$compiler.Dispose()
if ($code -ne 0) { throw "MSVC build failed ($code). If the output DLL is loaded, close the game first." }
Write-Host "Built $output"
