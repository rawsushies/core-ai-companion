# Windows installer gate: silent install -> self-test the installed app ->
# silent uninstall -> verify it is gone and user data is kept.
# Usage: pwsh scripts/ci/installer-smoke.ps1 -Installer dist\COre-Setup-1.2.3.exe
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'

$root = Join-Path $env:RUNNER_TEMP 'core-installer-smoke'
$dir = Join-Path $root 'app'
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $dir, $data | Out-Null
# Software graphics: CI machines have no GPU for transparent windows.
'{"orb":{"graphics":"software"}}' | Set-Content -Encoding utf8 (Join-Path $data 'config.json')

Write-Host "Installing $Installer silently to $dir"
$p = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$dir" -PassThru -Wait
if ($p.ExitCode -ne 0) { throw "installer exited with $($p.ExitCode)" }
$exe = Join-Path $dir 'COre.exe'
if (-not (Test-Path $exe)) { throw "COre.exe not found after install" }

Write-Host 'Self-testing the installed app'
$result = Join-Path $root 'installed-smoke.json'
$p = Start-Process -FilePath $exe -ArgumentList "--smoke-test=$result", "--user-data-dir=$data" -PassThru -Wait
Get-Content $result | Write-Host
if ($p.ExitCode -ne 0) { throw "installed app smoke test failed ($($p.ExitCode))" }

Write-Host 'Checking the installed files, bundled Cortex and models'
node (Join-Path $PSScriptRoot 'check-install.js') $dir
if ($LASTEXITCODE -ne 0) { throw 'install completeness check failed' }

Write-Host 'Uninstalling silently'
$un = Join-Path $dir 'Uninstall COre.exe'
if (-not (Test-Path $un)) { throw 'uninstaller missing' }
Start-Process -FilePath $un -ArgumentList '/S' -Wait | Out-Null
# The NSIS uninstaller re-launches itself from %TEMP%; wait for it to finish.
for ($i = 0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $exe) { throw 'COre.exe still present after uninstall' }
if (-not (Test-Path (Join-Path $data 'config.json'))) { throw 'uninstall removed user data' }
Write-Host 'Installer smoke test passed'
