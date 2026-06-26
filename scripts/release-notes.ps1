# Generates GitHub release notes for a version in the maintainer's convention
# (What's New / Fixed / How to install / disclaimer). The text is used both as
# the GitHub Release body and, via tauri-action, as the in-app updater notes.
#
# CHANGELOG.md (Keep a Changelog) is the source of truth: "Added" and "Changed"
# entries map to "What's New", "Fixed" entries to "Fixed". No emoji.
#
#   powershell scripts/release-notes.ps1 0.1.0
#
# Writes the notes to stdout; the release workflow captures them.

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Version
)

$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$lines = Get-Content -LiteralPath (Join-Path $root 'CHANGELOG.md') -Encoding UTF8

# Locate "## [Version]" and capture through to the next "## " heading.
$escaped = [regex]::Escape($Version)
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^##\s*\[$escaped\]") { $start = $i; break }
}
if ($start -lt 0) {
    throw "No CHANGELOG.md section for version $Version (expected a '## [$Version]' heading)."
}
$end = $lines.Count
for ($i = $start + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^##\s') { $end = $i; break }
}

# Bucket list items by Keep a Changelog subsection. Lead text, link references,
# and Removed/Deprecated/Security are intentionally left out of user notes.
$whatsNew = [System.Collections.Generic.List[string]]::new()
$fixed = [System.Collections.Generic.List[string]]::new()
$current = ''
for ($i = $start + 1; $i -lt $end; $i++) {
    $line = $lines[$i]
    if ($line -match '^###\s+(.+?)\s*$') { $current = $matches[1].Trim(); continue }
    # Only list items and their wrapped continuation lines belong in the notes.
    if ($line -notmatch '^\s*-' -and $line -notmatch '^\s+\S') { continue }
    if ($current -match '^(Added|Changed)$') { $whatsNew.Add($line) }
    elseif ($current -eq 'Fixed') { $fixed.Add($line) }
}

$out = [System.Text.StringBuilder]::new()
[void]$out.AppendLine("What's New:")
if ($whatsNew.Count -gt 0) {
    foreach ($l in $whatsNew) { [void]$out.AppendLine($l) }
} else {
    [void]$out.AppendLine('- Maintenance and stability improvements.')
}
[void]$out.AppendLine('')
if ($fixed.Count -gt 0) {
    [void]$out.AppendLine('Fixed:')
    foreach ($l in $fixed) { [void]$out.AppendLine($l) }
    [void]$out.AppendLine('')
}
[void]$out.AppendLine('How to install:')
[void]$out.AppendLine('1. Download the Vellum setup .exe from the assets below.')
[void]$out.AppendLine('2. Run it. Vellum installs per-user, no administrator rights required.')
[void]$out.AppendLine('')
[void]$out.AppendLine('Vellum is not code-signed, so Windows SmartScreen may warn on first run. Choose "More info" then "Run anyway" to continue. Your notes are stored under Documents\Vellum.')
[void]$out.AppendLine('')
[void]$out.AppendLine('Vellum is an independent project and is not affiliated with, endorsed by, or sponsored by Microsoft. OneNote, Windows, Office, OneDrive, and Segoe UI are trademarks of Microsoft Corporation.')

Write-Output $out.ToString().TrimEnd()
