# Fetches the bundled runtime binaries (see docs/Vellum_spec.md sections 3, 9, 10).
# Pinned versions — bump deliberately, not automatically.
#   Ollama: standalone zip (no installer, no tray app — spec requires headless spawn)
#   LanguageTool: open-source desktop release, includes languagetool-server.jar
# Downloads land in vendor\bin\ which is gitignored (large, redistributed at
# bundle time via Tauri resources/sidecar config instead).

$ErrorActionPreference = 'Stop'

$OllamaVersion = 'v0.30.8'
$LanguageToolVersion = '6.6'

$binDir = Join-Path $PSScriptRoot '..\vendor\bin'
New-Item -ItemType Directory -Force $binDir | Out-Null

$downloads = @(
    @{
        Name = 'ollama'
        Url  = "https://github.com/ollama/ollama/releases/download/$OllamaVersion/ollama-windows-amd64.zip"
        Zip  = Join-Path $binDir "ollama-windows-amd64-$OllamaVersion.zip"
        Dest = Join-Path $binDir 'ollama'
    },
    @{
        Name = 'languagetool'
        Url  = "https://languagetool.org/download/LanguageTool-$LanguageToolVersion.zip"
        Zip  = Join-Path $binDir "LanguageTool-$LanguageToolVersion.zip"
        Dest = Join-Path $binDir 'languagetool'
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
Write-Host "Ollama:       vendor\bin\ollama\ollama.exe"
Write-Host "LanguageTool: vendor\bin\languagetool\LanguageTool-$LanguageToolVersion\languagetool-server.jar"
