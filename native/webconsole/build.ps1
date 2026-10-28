# webconsole 构建入口（PowerShell）
# 底层：CMake（native/webconsole/CMakeLists.txt）——lua54 静态库 + 插件 DLL
# 用法：
#   .\build.ps1 -Target Plugin -Configuration Release   # 构建 webconsole.dll
#   .\build.ps1 -Target Standalone -Configuration Debug # 构建独立测试 exe
#   .\build.ps1 -Configuration Debug                    # Debug 构建
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

$work = Join-Path $PSScriptRoot ".build\$Target-$Configuration"
New-Item -ItemType Directory -Force -Path $OutputDirectory, $work | Out-Null
$stem = if ($Target -eq 'Plugin') { 'webconsole' } elseif ($Configuration -eq 'Debug') { 'webconsole_dbg' } else { 'webconsole_test' }
$extension = if ($Target -eq 'Plugin') { 'dll' } else { 'exe' }
$output = Join-Path $OutputDirectory "$stem.$extension"

Write-Host "Building $Target / $Configuration (x64) with $VisualStudioPath"
$configureInfo = [Diagnostics.ProcessStartInfo]::new()
$configureInfo.FileName = 'cmake.exe'
$configureInfo.Arguments = "-S `"$PSScriptRoot`" -B `"$work`""
$configureInfo.UseShellExecute = $false
$configure = [Diagnostics.Process]::Start($configureInfo)
$configure.WaitForExit()
if ($configure.ExitCode -ne 0) { throw "cmake configure failed with $($configure.ExitCode)" }

$buildInfo = [Diagnostics.ProcessStartInfo]::new()
$buildInfo.FileName = 'cmake.exe'
$buildInfo.Arguments = "--build `"$work`" --config $Configuration --target $stem"
$buildInfo.UseShellExecute = $false
$buildProcess = [Diagnostics.Process]::Start($buildInfo)
$buildProcess.WaitForExit()
if ($buildProcess.ExitCode -ne 0) { throw "cmake build failed with $($buildProcess.ExitCode)" }

# 构建产物拷贝到 OutputDirectory（dist/ 构建产物、游戏目录部署由上层 deploy.js 负责）
Copy-Item -Path (Join-Path $work "$stem.$extension") -Destination $output -Force
Write-Host "Output: $output"
