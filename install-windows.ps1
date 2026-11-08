# COre installer for Windows. Run it with "Install COre.bat" (double-click).
# It installs what COre needs, creates a Desktop shortcut and starts COre.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Green }

Write-Host "COre installer" -ForegroundColor Cyan
Write-Host "Folder: $PSScriptRoot"

# 1. Node.js 20+
Step "Checking Node.js"
if (-not (Have node)) {
  if (Have winget) {
    Write-Host "Node.js not found. Installing Node.js LTS with winget..."
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Refresh-Path
  }
  if (-not (Have node)) {
    Write-Host "Please install Node.js 20 or newer from https://nodejs.org, then run this installer again." -ForegroundColor Yellow
    exit 1
  }
}
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) {
  Write-Host "Node.js $(node -v) is too old. Install Node.js 20 or newer from https://nodejs.org and run again." -ForegroundColor Yellow
  exit 1
}
Write-Host "Node.js $(node -v) OK"

# 2. Claude Code (COre's brain, uses your Claude login, no API key)
Step "Checking Claude Code"
if (-not (Have claude)) {
  Write-Host "Installing Claude Code..."
  npm install -g @anthropic-ai/claude-code
  Refresh-Path
}
if (Have claude) { Write-Host "Claude Code $(claude --version) OK" }
else { Write-Host "Claude Code could not be installed. COre will fall back to Ollama if you have it." -ForegroundColor Yellow }

# 3. COre's own packages (also downloads the Electron runtime)
Step "Installing COre (this downloads about 150 MB the first time)"
npm install
$electron = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  npx install-electron
}
if (-not (Test-Path $electron)) { throw "Electron did not download. Check your internet connection and run the installer again." }

# 4. Desktop shortcut
Step "Creating the Desktop shortcut"
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'COre.lnk'))
$lnk.TargetPath = $electron
$lnk.Arguments = '"' + $PSScriptRoot + '"'
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.Description = 'COre desktop companion'
$lnk.Save()
Write-Host "Shortcut 'COre' added to your Desktop."

# 5. Claude login (only needed once)
Step "Claude login"
if (Have claude) {
  $answer = Read-Host "Have you already logged in to Claude Code on this PC? (y/n)"
  if ($answer -notmatch '^[yY]') {
    Write-Host "A Claude Code window will open. Type /login, finish the login in your browser, then close that window."
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'claude'
    Read-Host "Press Enter here when you have logged in"
  }
}

# 6. Start COre
Step "Starting COre"
Start-Process -FilePath $electron -ArgumentList ('"' + $PSScriptRoot + '"') -WorkingDirectory $PSScriptRoot
Write-Host ""
Write-Host "COre is running. Ctrl+Alt+Space to talk, Ctrl+Alt+S to talk about your screen, Ctrl+Alt+C to type." -ForegroundColor Cyan
Write-Host "Next time, just double-click 'COre' on your Desktop."
