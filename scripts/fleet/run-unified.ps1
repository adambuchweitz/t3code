param([switch]$BuildOnly, [switch]$DeployOnly, [switch]$Force, [switch]$SkipPull)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:T3CODE_FORK_UNIFIED_INPUT = Join-Path $PSScriptRoot 'unified-input.json'
$config = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$env:T3CODE_FORK_ORIGINAL_PATH = $env:PATH
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$visualStudio) { throw 'Visual Studio C++ build tools are unavailable.' }
$devCmd = Join-Path $visualStudio 'Common7\Tools\VsDevCmd.bat'
$environment = & $env:ComSpec /d /s /c "`"`"$devCmd`" -arch=x64 -host_arch=x64 >nul && set`""
if ($LASTEXITCODE -ne 0) { throw 'Could not load the MSVC build environment.' }
foreach ($line in $environment) {
    if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
$arguments = @((Join-Path $PSScriptRoot 'update-unified.mjs'))
if ($BuildOnly) { $arguments += '--build-only' }
if ($DeployOnly) { $arguments += '--deploy-only' }
if ($Force) { $arguments += '--force' }
if ($SkipPull) { $arguments += '--skip-pull' }
& (Join-Path $config.nodeDirectory 'node.exe') @arguments
exit $LASTEXITCODE
