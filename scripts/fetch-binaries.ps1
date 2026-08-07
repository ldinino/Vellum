# Fetches binaries that aren't committed to the repo.
# Pinned versions — bump deliberately, not automatically.
#
#   rclone: BUNDLED as a Tauri sidecar (docs/satchels-and-sync.md). It must exist
# before ANY cargo build: tauri-build validates `externalBin` in its build
# script, so a missing sidecar fails `cargo check`, not just `tauri build`.
# Lands in src-tauri/binaries/rclone-<target-triple>[.exe]; that folder is
# gitignored. CI runs this before building; the release workflow passes its
# cross-compilation target explicitly.
#
#   Ollama: NOT bundled — the app downloads it on demand into
# %LOCALAPPDATA%\Vellum\runtime\ at first Refine-enable. The copy in vendor/bin/
# is a local dev convenience only, so it is skipped with -RcloneOnly (CI) and on
# non-Windows hosts.
#
#   Grammar (Harper) is an embedded Rust crate — nothing to fetch.
#
# Usage:
#   powershell -File scripts/fetch-binaries.ps1                # host triple + Ollama
#   pwsh -File scripts/fetch-binaries.ps1 -RcloneOnly          # CI: host triple only
#   pwsh -File scripts/fetch-binaries.ps1 -Targets aarch64-pc-windows-msvc

[CmdletBinding()]
param(
    # Rust target triples to fetch rclone for. Defaults to the host triple.
    [string[]]$Targets,
    # Skip the Ollama dev copy (large, and only useful for local Refine work).
    [switch]$RcloneOnly
)

$ErrorActionPreference = 'Stop'

$OllamaVersion = 'v0.30.10'
$RcloneVersion = 'v1.75.0'

# $IsWindows is undefined on Windows PowerShell 5.1, which only runs on Windows.
$onWindows = $IsWindows -or ($null -eq $IsWindows)

# Rust target triple -> rclone release asset name. Only the platforms we build
# on are listed, so an unknown triple fails loudly rather than silently
# fetching the wrong architecture.
$RcloneAssets = @{
    'x86_64-pc-windows-msvc'    = 'windows-amd64'
    'aarch64-pc-windows-msvc'   = 'windows-arm64'
    'x86_64-apple-darwin'       = 'osx-amd64'
    'aarch64-apple-darwin'      = 'osx-arm64'
    'x86_64-unknown-linux-gnu'  = 'linux-amd64'
    'aarch64-unknown-linux-gnu' = 'linux-arm64'
}

function Get-HostTriple {
    # rustc is authoritative and is always present wherever we build; beats
    # inferring the triple from OS + architecture.
    $line = (& rustc -vV) | Where-Object { $_ -like 'host: *' }
    if (-not $line) { throw 'Could not determine the host target triple from rustc -vV.' }
    return ($line -replace '^host:\s*', '').Trim()
}

if (-not $Targets -or $Targets.Count -eq 0) {
    $Targets = @(Get-HostTriple)
}

$repoRoot = Join-Path $PSScriptRoot '..'
$binDir = Join-Path $repoRoot 'vendor/bin'
$sidecarDir = Join-Path $repoRoot 'src-tauri/binaries'
New-Item -ItemType Directory -Force $binDir | Out-Null
New-Item -ItemType Directory -Force $sidecarDir | Out-Null

# Invoke-WebRequest progress rendering slows large downloads dramatically in PS 5.1
$ProgressPreference = 'SilentlyContinue'

foreach ($triple in $Targets) {
    $asset = $RcloneAssets[$triple]
    if (-not $asset) {
        throw "No rclone asset mapping for target '$triple'. Add one to scripts/fetch-binaries.ps1."
    }
    $exeSuffix = if ($triple -like '*windows*') { '.exe' } else { '' }
    $sidecar = Join-Path $sidecarDir "rclone-$triple$exeSuffix"
    if (Test-Path $sidecar) {
        Write-Host "rclone for $triple already present, skipping."
        continue
    }

    $url = "https://github.com/rclone/rclone/releases/download/$RcloneVersion/rclone-$RcloneVersion-$asset.zip"
    $zip = Join-Path $binDir "rclone-$RcloneVersion-$asset.zip"
    $work = Join-Path $binDir "rclone-$asset"
    if (-not (Test-Path $zip)) {
        Write-Host "Downloading rclone for $triple from $url ..."
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    }
    Write-Host "Extracting rclone for $triple ..."
    if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
    Expand-Archive -Path $zip -DestinationPath $work -Force
    # The zip wraps everything in an rclone-<version>-<asset>/ folder.
    $exeName = if ($exeSuffix) { 'rclone.exe' } else { 'rclone' }
    $exe = Get-ChildItem -Path $work -Filter $exeName -Recurse -File | Select-Object -First 1
    if (-not $exe) { throw "$exeName not found in $zip" }
    Copy-Item $exe.FullName $sidecar
    if (-not $onWindows) { & chmod +x $sidecar }
    # Best-effort tidying: on Windows an antivirus/indexer scan can still hold a
    # freshly extracted file, and leaving a temp folder in gitignored vendor/bin
    # must never fail a build over housekeeping.
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    Remove-Item $zip -ErrorAction SilentlyContinue
    Write-Host "  -> $sidecar"
}

if (-not $RcloneOnly -and $onWindows) {
    $ollamaDest = Join-Path $binDir 'ollama'
    if (Test-Path $ollamaDest) {
        Write-Host "Ollama already extracted at $ollamaDest, skipping."
    } else {
        $url = "https://github.com/ollama/ollama/releases/download/$OllamaVersion/ollama-windows-amd64.zip"
        $zip = Join-Path $binDir "ollama-windows-amd64-$OllamaVersion.zip"
        if (-not (Test-Path $zip)) {
            Write-Host "Downloading Ollama from $url ..."
            Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        }
        Write-Host 'Extracting Ollama ...'
        Expand-Archive -Path $zip -DestinationPath $ollamaDest
        Remove-Item $zip
        Write-Host "  -> $ollamaDest/ollama.exe"
    }
}

Write-Host 'Done.'
