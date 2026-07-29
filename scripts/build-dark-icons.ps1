# Generates the dark-mode icon set from the Fugue pack's *shadowless* originals.
#
# Why a generated set rather than a CSS filter: light mode keeps the shipped
# (shadowed) icons as-is, and dark mode gets purpose-built art with no inverted
# drop-shadow halo. Shadowless sources mean there is no shadow to invert in the
# first place, so no brightness-threshold guesswork is needed.
#
# The transform only touches *desaturated* pixels (the black/grey linework):
# their lightness is flipped (L -> 1-L), so black becomes white and mid-greys
# stay mid. Coloured pixels are left completely alone, which keeps the blue
# folders, pictures and diagram icons looking like themselves. Pixels already
# lighter than $MaxLightness are skipped so white highlights inside a coloured
# icon don't turn black. Alpha is always preserved.
#
# A few icons look better untouched on dark and are listed in $NoInvert below;
# they are copied straight from the shadowless original.
#
# Usage (from the repo root):
#   powershell -File scripts/build-dark-icons.ps1          # generate
#   powershell -File scripts/build-dark-icons.ps1 -Check   # verify, write nothing
#
# Re-run after adding an icon to src/assets/icons.

[CmdletBinding()]
param(
    # Report what would change and fail if anything is missing/stale, but write nothing.
    [switch]$Check,
    # Only pixels at or below this lightness are flipped (0..1).
    [double]$MaxLightness = 0.55,
    # Pixels at or above this saturation count as "coloured" and are left alone (0..1).
    [double]$ColorSaturation = 0.25
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Icons that read fine on a dark background already, and look worse flipped
# (their dark parts are shading/detail rather than linework). These are copied
# straight from the shadowless original so dark mode still drops the shadow.
$NoInvert = @(
    'exclamation',
    'printer',
    'wand',
    'wand-hat'
)

$repo = Split-Path -Parent $PSScriptRoot
$lightDir = Join-Path $repo 'src/assets/icons'
$sourceDir = Join-Path $repo 'assets/fugue-icons-3.5.6/icons-shadowless'
$outDir = Join-Path $repo 'src/assets/icons-dark'

if (-not (Test-Path $lightDir)) { throw "Missing icon folder: $lightDir" }
if (-not (Test-Path $sourceDir)) {
    throw "Missing Fugue pack at $sourceDir. /assets is gitignored, so restore the Fugue Icons 3.5.6 download there before regenerating. The generated icons in src/assets/icons-dark are committed, so this is only needed when icons change."
}
if (-not $Check -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$icons = Get-ChildItem (Join-Path $lightDir '*.png')
$missing = @()
$written = 0

foreach ($icon in $icons) {
    $src = Join-Path $sourceDir $icon.Name
    if (-not (Test-Path $src)) { $missing += $icon.Name; continue }

    $bmp = [System.Drawing.Bitmap]::FromFile($src)
    try {
        $out = New-Object System.Drawing.Bitmap $bmp.Width, $bmp.Height
        try {
            $keepAsIs = $NoInvert -contains $icon.BaseName
            for ($y = 0; $y -lt $bmp.Height; $y++) {
                for ($x = 0; $x -lt $bmp.Width; $x++) {
                    $p = $bmp.GetPixel($x, $y)
                    if ($keepAsIs -or $p.A -eq 0) { $out.SetPixel($x, $y, $p); continue }

                    $lightness = $p.GetBrightness()
                    $saturation = $p.GetSaturation()
                    if ($saturation -lt $ColorSaturation -and $lightness -le $MaxLightness) {
                        # Grey linework: flip its lightness, keep it neutral grey.
                        $v = [int][Math]::Round((1.0 - $lightness) * 255.0)
                        if ($v -lt 0) { $v = 0 } elseif ($v -gt 255) { $v = 255 }
                        $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($p.A, $v, $v, $v))
                    }
                    else {
                        $out.SetPixel($x, $y, $p)
                    }
                }
            }

            $dest = Join-Path $outDir $icon.Name
            if ($Check) {
                if (-not (Test-Path $dest)) { $missing += "$($icon.Name) (not generated)" }
            }
            else {
                $out.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
                $written++
            }
        }
        finally { $out.Dispose() }
    }
    finally { $bmp.Dispose() }
}

if ($missing.Count -gt 0) {
    Write-Warning "No shadowless source (or not generated) for: $($missing -join ', ')"
}

if ($Check) {
    $stale = (Get-ChildItem (Join-Path $outDir '*.png') -ErrorAction SilentlyContinue).Count
    Write-Host "Check: $($icons.Count) light icons, $stale dark icons."
    if ($missing.Count -gt 0) { exit 1 }
}
else {
    Write-Host "Wrote $written dark icons to src/assets/icons-dark."
}
