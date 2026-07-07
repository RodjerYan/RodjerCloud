# Generate macOS .icns from resources/icon-256.png
# Run this on macOS before building DMG
# Requires macOS with sips + iconutil available

$src = Join-Path (Split-Path $PSScriptRoot -Parent) "resources"
$dest = $src

Write-Host "Generating iconset from $src\icon-256.png ..."

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "rodjercloud-iconset"
$iconset = New-Item -ItemType Directory -Path "$tmpDir\RodjerCloud.iconset" -Force

function Scale-Icon {
  param([int]$Size, [string]$Name)
  $out = Join-Path $iconset $Name
  # sips is macOS-only
  & sips -z $Size $Size "$src\icon-256.png" --out $out 2>$null
}

Scale-Icon 16  "icon_16x16.png"
Scale-Icon 32  "icon_16x16@2x.png"
Scale-Icon 32  "icon_32x32.png"
Scale-Icon 64  "icon_32x32@2x.png"
Scale-Icon 128 "icon_128x128.png"
Scale-Icon 256 "icon_128x128@2x.png"
Copy-Item "$src\icon-256.png" "$iconset\icon_256x256.png"
Scale-Icon 512 "icon_256x256@2x.png"

& iconutil -c icns "$iconset" --output "$dest\icon.icns"
Remove-Item -Recurse -Force $tmpDir

Write-Host "Done: $dest\icon.icns"
