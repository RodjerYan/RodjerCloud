# Release Rules

## All releases MUST include Windows .exe

Even if you build from macOS, you must build the Windows installer too.

### Build commands

```bash
# Build for ALL platforms (recommended):
npm run build:all

# Or build separately:
npm run build:mac --arm64   # macOS ARM64
npm run build:win           # Windows x64
```

### Required assets for each release

Before creating a GitHub release, verify ALL of these exist in `dist/`:

| Platform | Files |
|----------|-------|
| Windows  | `RodjerCloud-{version}.exe`, `RodjerCloud-{version}.exe.blockmap` |
| macOS    | `RodjerCloud-{version}-arm64.dmg`, `RodjerCloud-{version}-arm64-mac.zip` |
| Both     | `latest.yml` |

### Release creation (with gh CLI)

```bash
gh release create v{version} \
  "dist/RodjerCloud-{version}.exe" \
  "dist/RodjerCloud-{version}.exe.blockmap" \
  "dist/RodjerCloud-{version}-arm64.dmg" \
  "dist/RodjerCloud-{version}-arm64-mac.zip" \
  "dist/latest.yml" \
  --title "v{version}" \
  --notes "..."
```

### Why this matters

The auto-updater (`platformAssetPattern()` in `electron/main/index.ts`) selects an asset matching the user's OS:

- **Windows**: looks for `.exe` or `-win.zip`
- **macOS ARM64**: looks for `-arm64.dmg` or `-arm64-mac.zip`

If the Windows `.exe` is missing, Windows clients see "update available" but the download silently fails (`assetId = 0`).

### Always verify

```bash
gh release view v{version} --json assets
# Check that ALL required assets appear in the list
```
