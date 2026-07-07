#!/usr/bin/env bash
# Generate macOS .icns from resources/icon-256.png
# Run this on macOS before building DMG

set -euo pipefail
SRC="$(cd "$(dirname "$0")/../resources" && pwd)"
DEST="$SRC"

echo "Generating iconset from $SRC/icon-256.png ..."

ICONSET=$(mktemp -d)/RodjerCloud.iconset
mkdir -p "$ICONSET"

sips -z 16 16   "$SRC/icon-256.png" --out "$ICONSET/icon_16x16.png"
sips -z 32 32   "$SRC/icon-256.png" --out "$ICONSET/icon_16x16@2x.png"
sips -z 32 32   "$SRC/icon-256.png" --out "$ICONSET/icon_32x32.png"
sips -z 64 64   "$SRC/icon-256.png" --out "$ICONSET/icon_32x32@2x.png"
sips -z 128 128 "$SRC/icon-256.png" --out "$ICONSET/icon_128x128.png"
sips -z 256 256 "$SRC/icon-256.png" --out "$ICONSET/icon_128x128@2x.png"
cp "$SRC/icon-256.png" "$ICONSET/icon_256x256.png"
sips -z 512 512 "$SRC/icon-256.png" --out "$ICONSET/icon_256x256@2x.png"

iconutil -c icns "$ICONSET" --output "$DEST/icon.icns"
rm -rf "$(dirname "$ICONSET")"

echo "Done: $DEST/icon.icns"
