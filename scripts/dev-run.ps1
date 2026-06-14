<#
.SYNOPSIS
  Prep, build, and run Vellum for manual testing, then clean up on confirmation.

.DESCRIPTION
  One command to launch the app whenever you want to click around:
    1. Preps   - finds the repo from the script's own location (no hard-coded
                 machine paths), makes sure node/npm/cargo are reachable
                 (augmenting PATH from common install spots if needed), and runs
                 `npm install` if dependencies are missing.
    2. Restores - if a previous run left temporary edits behind (see "TEMP
                 CHANGES" below), it puts them back before starting.
    3. Builds + runs `npm run tauri dev` in its own window (compiles the Rust
                 backend and launches the app).
    4. Waits   - asks "Are you done?"; nothing is torn down until you say yes.
    5. Puts back - stops the dev server + app, frees the Vite port, and reverts
                 any temporary edits this script made.

  Nothing here is specific to one machine: paths are resolved relative to the
  script and from environment variables, and the dev port is read from
  vite.config.ts.

.PARAMETER PrepOnly
  Do the prep + report resolved tool paths, then exit without building/running.
  Handy for checking the environment on a fresh machine.

.EXAMPLE
  pwsh ./scripts/dev-run.ps1
  powershell -ExecutionPolicy Bypass -File scripts\dev-run.ps1
#>
#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$PrepOnly
)

$ErrorActionPreference = 'Stop'

# --- Locate the repo from this script's location (machine-independent) --------
function Find-RepoRoot {
    $dir = $PSScriptRoot
    while ($dir) {
        if (Test-Path (Join-Path $dir 'package.json')) { return $dir }
        $parent = Split-Path -Parent $dir
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    throw "Could not find the repo root (no package.json above $PSScriptRoot)."
}

# --- Make a tool reachable, adding common install locations to PATH if needed -
function Initialize-Tool {
    param([string]$Name, [string[]]$Candidates)
    if (Get-Command $Name -ErrorAction SilentlyContinue) { return }
    foreach ($c in $Candidates) {
        if ($c -and (Test-Path $c)) {
            $env:PATH = "$c$([IO.Path]::PathSeparator)$env:PATH"
            if (Get-Command $Name -ErrorAction SilentlyContinue) { return }
        }
    }
    throw "$Name is not on PATH and was not found in the usual places. Install it (or add it to PATH) and retry."
}

# --- Read the Vite dev port from the project (defaults to 1420) ---------------
function Get-DevPort {
    param([string]$Repo)
    $cfg = Join-Path $Repo 'vite.config.ts'
    if (Test-Path $cfg) {
        $m = Select-String -Path $cfg -Pattern 'port:\s*(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m -and $m.Matches.Count) { return [int]$m.Matches[0].Groups[1].Value }
    }
    return 1420
}

# --- Stop a dev-server process tree, the app window, and free the dev port ----
function Stop-DevRun {
    param($Proc, [int]$Port)
    if ($Proc -and -not $Proc.HasExited) {
        # /T kills the whole tree (npm -> vite/cargo -> the app exe).
        taskkill /T /F /PID $Proc.Id 2>$null | Out-Null
    }
    Get-Process -Name vellum -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        foreach ($c in (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
}

# --- Temporary-edit framework: back up before editing, restore on exit --------
# Use Set-TempFile in the "TEMP CHANGES" section to make a reversible edit. Each
# backup is a sibling "<file>.devrun.bak"; a crashed run is healed on the next
# start by Restore-Backups, which also runs in the finally block below.
$script:Backups = New-Object System.Collections.ArrayList

function Set-TempFile {
    param([string]$RelPath, [scriptblock]$Edit)
    $full = Join-Path $script:Repo $RelPath
    if (-not (Test-Path $full)) { throw "Set-TempFile: $RelPath not found." }
    $bak = "$full.devrun.bak"
    if (-not (Test-Path $bak)) { Copy-Item $full $bak -Force }
    [void]$script:Backups.Add($full)
    & $Edit $full
}

function Restore-Backups {
    # Revert anything this (or a previously crashed) run left behind. Scans only
    # source/config trees so it never walks node_modules/target.
    $scan = @('.', 'src', 'src-tauri', 'docs') | ForEach-Object { Join-Path $script:Repo $_ }
    foreach ($root in $scan) {
        if (-not (Test-Path $root)) { continue }
        $depth = if ($root -eq (Join-Path $script:Repo '.')) { 1 } else { 100 }
        Get-ChildItem -Path $root -Filter '*.devrun.bak' -File -Recurse -Depth $depth -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '[\\/](node_modules|target|dist|\.git)[\\/]' } |
            ForEach-Object {
                $orig = $_.FullName -replace '\.devrun\.bak$', ''
                Move-Item -LiteralPath $_.FullName -Destination $orig -Force
                Write-Host "  restored $([IO.Path]::GetFileName($orig))"
            }
    }
    $script:Backups.Clear()
}

# ============================ main ===========================================
$script:Repo = Find-RepoRoot
Set-Location $script:Repo

Initialize-Tool node  @("$env:ProgramFiles\nodejs", "${env:ProgramFiles(x86)}\nodejs", "$env:LOCALAPPDATA\Programs\nodejs")
Initialize-Tool npm   @("$env:ProgramFiles\nodejs", "$env:APPDATA\npm")
Initialize-Tool cargo @("$env:USERPROFILE\.cargo\bin", "$env:CARGO_HOME\bin")

$port = Get-DevPort -Repo $script:Repo

Write-Host "Vellum dev-run"
Write-Host "  repo:  $script:Repo"
Write-Host "  node:  $((Get-Command node).Source)"
Write-Host "  npm:   $((Get-Command npm).Source)"
Write-Host "  cargo: $((Get-Command cargo).Source)"
Write-Host "  port:  $port"

# Heal any temp edits a previous crashed run left behind.
Restore-Backups

# Install dependencies if missing.
if (-not (Test-Path (Join-Path $script:Repo 'node_modules'))) {
    Write-Host "Installing npm dependencies (first run)..."
    & npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}

if ($PrepOnly) {
    Write-Host "Prep complete (PrepOnly)."
    return
}

# === TEMP CHANGES (auto-reverted when you answer 'Are you done? -> yes') ======
# Make reversible edits here, e.g. to flip a flag or seed a config for testing:
#
#   Set-TempFile 'src-tauri/tauri.conf.json' {
#       param($f)
#       (Get-Content $f -Raw) -replace '"someFlag": false', '"someFlag": true' |
#           Set-Content $f -Encoding utf8
#   }
#
# None are needed right now. =================================================

$dev = $null
try {
    # Clear a stale instance/port so the build doesn't fail on "port in use".
    Stop-DevRun -Proc $null -Port $port

    Write-Host "`nBuilding and launching the app (npm run tauri dev) in a new window..."
    # Launch through cmd.exe so PATH resolves npm's launcher (npm.cmd) regardless
    # of whether `npm` points at a .ps1/.cmd; taskkill /T later kills the tree.
    $dev = Start-Process -FilePath "$env:ComSpec" -ArgumentList '/c', 'npm run tauri dev' `
        -WorkingDirectory $script:Repo -PassThru
    Write-Host "The build runs in its own window; the app appears when it finishes."

    do {
        $ans = Read-Host "`nAre you done? (y/n)"
    } while ($ans -notmatch '^(y|yes)$')
}
finally {
    Write-Host "Stopping the app and putting things back..."
    Stop-DevRun -Proc $dev -Port $port
    Restore-Backups
    Write-Host "Done."
}
