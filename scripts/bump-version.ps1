# Bumps Vellum's version in the three files that must stay in sync:
# package.json, src-tauri/Cargo.toml, and src-tauri/tauri.conf.json. The updater
# compares the tauri.conf.json version, so a release that misses one of these
# ships a broken update — this keeps them identical.
#
# Versioning is Major.Minor.Hotfix:
#   - Major  : only at the maintainer's explicit direction. Never bump on a whim.
#   - Minor  : a new button / menu item / small feature.
#   - Hotfix : a change to existing features (the common case).
#
#   powershell scripts/bump-version.ps1 0.1.1
#
# Updates version numbers only. Update CHANGELOG.md (move the [Unreleased]
# entries under a new "## [X.Y.Z] - <date>" heading) before tagging —
# release-notes.ps1 reads it to build the GitHub release body.

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Version
)

$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must be Major.Minor.Hotfix (e.g. 0.1.1), got '$Version'."
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$replacement = '${1}' + $Version + '${2}'

function Update-Version {
    param([string] $Path, [regex] $Pattern, [string] $Replacement)
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if (-not $Pattern.IsMatch($text)) { throw "No version field found in $Path" }
    $text = $Pattern.Replace($text, $Replacement, 1)
    [System.IO.File]::WriteAllText($Path, $text, [System.Text.UTF8Encoding]::new($false))
}

# "version": "..." — the first (top-level) occurrence in each JSON file.
$jsonVersion = [regex]'("version"\s*:\s*")[^"]*(")'
Update-Version (Join-Path $root 'package.json') $jsonVersion $replacement
Update-Version (Join-Path $root 'src-tauri/tauri.conf.json') $jsonVersion $replacement
# Cargo.toml — the [package] version is the only line that starts with `version =`.
Update-Version (Join-Path $root 'src-tauri/Cargo.toml') ([regex]'(?m)^(version\s*=\s*")[^"]*(")') $replacement

Write-Host "Set version to $Version in package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml."
Write-Host "Next: update CHANGELOG.md, commit, then push tag v$Version to release."
