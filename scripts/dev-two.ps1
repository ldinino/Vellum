<#
.SYNOPSIS
  Run a second Vellum against a separate machine identity, on this machine.

.DESCRIPTION
  docs/satchels-and-sync.md 5.6 (TWOPROC). Every claim in the device-handoff
  track is a unit test below the app or a source read; nothing has been observed
  in a running Vellum. Two real machines are slow to set up and slower to
  iterate on. Two processes on one machine close most of that gap.

  Each instance gets:
    - its own machine-local directory (VELLUM_MACHINE_DIR, debug builds only),
      which is what carries device.json, satchels.json, the sealed .remote blob
      and the diagnostic log - so the two are genuinely different devices;
    - its own Satchel folder, holding the SAME Satchel id, because a Satchel
      synced between two machines is one Satchel in two places;
    - its own COMPUTERNAME, which is where the device name comes from, so the
      app names itself A-DESK / B-LAPTOP in the take-over bar.

  Both are bound to one "remote": a local folder, through the same rclone crypt
  layer real providers use. That exercises the whole transport without a
  network.

  This does NOT start the dev server. Run `npm run dev` once, in its own
  window, and leave it up; both instances then share it and a close-and-relaunch
  costs seconds instead of a rebuild. Build the exe once with
  `cargo build --manifest-path src-tauri/Cargo.toml`.

  Refine stays off: Ollama's port 11435 is fixed and two instances would fight
  over it.

.PARAMETER Which
  A or B. Picks the instance's directories and machine name.

.PARAMETER Reset
  Delete this instance's directories (and, with -Which A, the shared remote and
  crypt keys) before starting, for a clean run.

.PARAMETER SeedOnly
  Write the rig files and report the paths without launching anything.

.EXAMPLE
  pwsh ./scripts/dev-two.ps1 -Which A -Reset
  pwsh ./scripts/dev-two.ps1 -Which B
#>
#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('A', 'B')][string]$Which,
    [switch]$Reset,
    [switch]$SeedOnly
)

$ErrorActionPreference = 'Stop'

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

function New-Dir { param([string]$Path) [void](New-Item -ItemType Directory -Force -Path $Path) }

# UTF-8 without BOM: serde_json copes with a BOM only where the reader strips it,
# and not every reader here does.
function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    New-Dir (Split-Path -Parent $Path)
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

$repo = Find-RepoRoot
$rig = Join-Path $env:LOCALAPPDATA 'Vellum-rig'
$remoteRoot = Join-Path $rig 'remote'          # stands in for the cloud provider
$machineDir = Join-Path $rig "$Which\machine"  # VELLUM_MACHINE_DIR
$dataDir = Join-Path $rig "$Which\data"        # the Satchel folder
$computerName = if ($Which -eq 'A') { 'A-DESK' } else { 'B-LAPTOP' }

if ($Reset) {
    Remove-Item -Recurse -Force (Join-Path $rig $Which) -ErrorAction SilentlyContinue
    if ($Which -eq 'A') {
        Remove-Item -Recurse -Force $remoteRoot -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $rig 'rig.json') -ErrorAction SilentlyContinue
    }
}

New-Dir $rig; New-Dir $remoteRoot; New-Dir $machineDir; New-Dir $dataDir

# --- The rclone sidecar, used here only to obscure the crypt passwords --------
$rclone = Join-Path $repo 'src-tauri\binaries\rclone-x86_64-pc-windows-msvc.exe'
if (-not (Test-Path $rclone)) {
    throw "rclone sidecar not found at $rclone. Run scripts/fetch-binaries.ps1."
}

# --- Shared identity: one Satchel id and one pair of crypt passwords ----------
# Written by whichever instance starts first, then read by the other. Both must
# match exactly or the second instance decrypts nothing.
$rigFile = Join-Path $rig 'rig.json'
if (Test-Path $rigFile) {
    $rigCfg = Get-Content $rigFile -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    $p1 = & $rclone obscure ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
    $p2 = & $rclone obscure ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
    if ($LASTEXITCODE -ne 0) { throw "rclone obscure failed." }
    $rigCfg = [pscustomobject]@{
        satchelId      = [guid]::NewGuid().ToString()
        cryptPassword  = "$p1".Trim()
        cryptPassword2 = "$p2".Trim()
    }
    Write-Utf8NoBom $rigFile ($rigCfg | ConvertTo-Json)
}

# --- The Satchel marker: same id on both sides, different folder --------------
Write-Utf8NoBom (Join-Path $dataDir 'satchel.json') (
    [pscustomobject]@{ id = $rigCfg.satchelId; name = 'Rig'; formatVersion = 1 } | ConvertTo-Json
)

# --- The machine-local Satchel list, already bound to the remote --------------
Write-Utf8NoBom (Join-Path $machineDir 'satchels.json') (
    [pscustomobject]@{
        activeId = $rigCfg.satchelId
        known    = @([pscustomobject]@{
                id   = $rigCfg.satchelId
                name = 'Rig'
                path = $dataDir
                sync = [pscustomobject]@{
                    remote       = 'vellumcrypt'
                    label        = 'Folder or network drive'
                    lastSyncedAt = $null
                    generation   = 0
                }
            })
    } | ConvertTo-Json -Depth 6
)

# --- The sealed remote definition --------------------------------------------
# Same shape and same seal the app writes: serde_json of RemoteConfig, then
# DPAPI at user scope with no extra entropy (src-tauri/src/sync/secrets.rs).
$remoteJson = [pscustomobject]@{
    backend        = 'local'
    label          = 'Folder or network drive'
    options        = [pscustomobject]@{}
    path           = $remoteRoot
    cryptPassword  = $rigCfg.cryptPassword
    cryptPassword2 = $rigCfg.cryptPassword2
} | ConvertTo-Json -Depth 6

Add-Type -AssemblyName System.Security
$sealed = [Security.Cryptography.ProtectedData]::Protect(
    [Text.Encoding]::UTF8.GetBytes($remoteJson), $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser)
$remoteBlob = Join-Path $machineDir "remotes\$($rigCfg.satchelId).remote"
New-Dir (Split-Path -Parent $remoteBlob)
[IO.File]::WriteAllBytes($remoteBlob, $sealed)

Write-Host "Vellum two-process rig - instance $Which"
Write-Host "  machine dir : $machineDir"
Write-Host "  satchel     : $dataDir"
Write-Host "  remote      : $remoteRoot"
Write-Host "  device name : $computerName"
Write-Host "  satchel id  : $($rigCfg.satchelId)"
Write-Host "  log         : $(Join-Path $machineDir 'logs\vellum.log')"

if ($SeedOnly) { Write-Host "Seed complete (SeedOnly)."; return }

$exe = Join-Path $repo 'src-tauri\target\debug\vellum.exe'
if (-not (Test-Path $exe)) {
    throw "$exe not found. Build it first: cargo build --manifest-path src-tauri/Cargo.toml"
}

# Environment for the child only; this shell's own COMPUTERNAME is left alone.
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.UseShellExecute = $false
$psi.WorkingDirectory = $repo
$psi.EnvironmentVariables['VELLUM_MACHINE_DIR'] = $machineDir
$psi.EnvironmentVariables['COMPUTERNAME'] = $computerName
$proc = [Diagnostics.Process]::Start($psi)

# The capture helper needs to tell the two windows apart, and both processes are
# called vellum.exe.
Write-Utf8NoBom (Join-Path $machineDir 'instance.pid') "$($proc.Id)"
Write-Host "  pid         : $($proc.Id)"
