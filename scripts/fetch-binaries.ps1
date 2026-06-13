# Fetches the runtime component binaries for local development
# (see docs/Vellum_spec.md sections 3, 9).
# Pinned versions — bump deliberately, not automatically.
#   Ollama: standalone zip (no installer, no tray app — spec requires headless spawn)
# Ollama is NOT bundled in the installer: the app downloads it on demand into
# %LOCALAPPDATA%\Vellum\runtime\ at first Refine-enable. This local copy in
# vendor\bin\ (gitignored) is for dev work and as source material for the
# component zip published to GitHub Releases.
# Grammar (Harper) is an embedded Rust crate — nothing to fetch here.

$ErrorActionPreference = 'Stop'

$OllamaVersion = 'v0.30.8'

$binDir = Join-Path $PSScriptRoot '..\vendor\bin'
New-Item -ItemType Directory -Force $binDir | Out-Null

$downloads = @(
    @{
        Name = 'ollama'
        Url  = "https://github.com/ollama/ollama/releases/download/$OllamaVersion/ollama-windows-amd64.zip"
        Zip  = Join-Path $binDir "ollama-windows-amd64-$OllamaVersion.zip"
        Dest = Join-Path $binDir 'ollama'
    }
)

# Invoke-WebRequest progress rendering slows large downloads dramatically in PS 5.1
$ProgressPreference = 'SilentlyContinue'

foreach ($d in $downloads) {
    if (Test-Path $d.Dest) {
        Write-Host "$($d.Name) already extracted at $($d.Dest), skipping."
        continue
    }
    if (-not (Test-Path $d.Zip)) {
        Write-Host "Downloading $($d.Name) from $($d.Url) ..."
        Invoke-WebRequest -Uri $d.Url -OutFile $d.Zip -UseBasicParsing
    }
    Write-Host "Extracting $($d.Name) ..."
    Expand-Archive -Path $d.Zip -DestinationPath $d.Dest
    Remove-Item $d.Zip
}

Write-Host 'Done.'
Write-Host "Ollama: vendor\bin\ollama\ollama.exe"
