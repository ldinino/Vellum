# Fetches third-party styling references used in Phase 0 (see docs/Vellum_spec.md).
# These are reference material only — values (colors, gradients) are extracted
# into our own CSS custom properties. They are NOT committed to this repo:
# Office-Ribbon-2010 carries no code license, so its code must not be vendored
# or redistributed. makeaero is MIT but is also kept reference-only.

$ErrorActionPreference = 'Stop'
$refDir = Join-Path $PSScriptRoot '..\vendor\reference'
New-Item -ItemType Directory -Force $refDir | Out-Null

$repos = @(
    @{ Name = 'Office-Ribbon-2010'; Url = 'https://github.com/OkGoDoIt/Office-Ribbon-2010' },
    @{ Name = 'makeaero';           Url = 'https://github.com/Visnalize/makeaero' }
)

foreach ($repo in $repos) {
    $dest = Join-Path $refDir $repo.Name
    if (Test-Path $dest) {
        Write-Host "$($repo.Name) already present, skipping."
    } else {
        git clone --depth 1 $repo.Url $dest
    }
}

Write-Host "Done. References in vendor\reference\"
Write-Host "Office-Ribbon-2010 LESS source: vendor\reference\Office-Ribbon-2010\custom-color.chirp.less.css"
Write-Host "Compiled CSS (silver/blue + red themes): vendor\reference\Office-Ribbon-2010\ribbon\"
