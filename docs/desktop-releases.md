# Desktop releases (GitHub Actions)

Desktop builds are published to [GitHub Releases](https://github.com/somitmittal/whatsapp-search/releases) when you push a version tag.

## Control plane (required for paid desktop)

Before tagging a release, set the repo Actions secret **`CONTROL_PLANE_URL`** to your Render public URL (same host as `CONTROL_PLANE_PUBLIC_URL`). The release workflow bakes it into `electron/control-plane.defaults.json` so installs check your hosted licenses (trial, Stripe, remote lock, min version). Without that secret, desktop builds use a local-only license DB.

See [monetization.md](./monetization.md).

## Create a release

The workflow runs when you **push a version tag** — not on ordinary commits to `main`.

```bash
# Tag must point to a commit that includes .github/workflows/release-desktop.yml
git checkout main && git pull
git tag v1.0.1
git push origin v1.0.1
```

**If you tagged before the workflow existed** (e.g. `v1.0.0` on an older commit), GitHub will show **0 workflow runs**. Fix: push a **new** tag on current `main` (`v1.0.1`, etc.) or use **Run workflow** in Actions → Release Desktop.

### Manual run (no tag)

GitHub → **Actions** → **Release Desktop** → **Run workflow** → enter tag name (e.g. `v1.0.1`).

The workflow `.github/workflows/release-desktop.yml` builds:

| Platform | Artifact |
|----------|----------|
| macOS Apple Silicon | `Searchable-x.y.z-mac-arm64.dmg` |
| macOS Intel | `Searchable-x.y.z-mac-x64.dmg` |
| Windows | `Searchable-x.y.z-win-x64.exe` |
| Linux | `Searchable-x.y.z-linux-x64.AppImage` |

## Local builds

```bash
npm run dist:mac-arm64   # or dist:mac-x64, dist:mac (both)
npm run dist:win         # on Windows or CI
npm run dist:linux       # on Linux or CI
```

## Download page

- Web: `https://your-host.onrender.com/download`
- Fetches latest release via `/api/releases/latest` (GitHub API, cached 1 hour)
- Download buttons use tracked redirects: `/api/releases/download/{mac-arm64|mac-x64|windows|linux}` (supports `utm_source`, `utm_campaign`)
- Stats: `/analytics` or `GET /api/analytics/downloads` with `Authorization: Bearer $SESSION_SECRET`
- On Render, set **`GITHUB_TOKEN`** (read-only PAT) to avoid API rate limits
- Override repo with env `GITHUB_REPO=owner/repo` if needed
- Accounts / trial / Stripe: [monetization.md](./monetization.md)

## macOS install (unsigned / ad-hoc builds)

CI builds are **not** Apple Developer–signed or notarized. Clearing quarantine with `xattr` alone is **not enough** when the download has a broken or incomplete signature — macOS will still say the app is damaged.

Open the DMG (or mount it), then run:

```bash
# Eject any older Searchable DMG first so /Volumes/Searchable is this version.
rm -rf /Applications/Searchable.app
ditto /Volumes/Searchable/Searchable.app /Applications/Searchable.app
xattr -cr /Applications/Searchable.app
codesign --force --deep --sign - /Applications/Searchable.app
open /Applications/Searchable.app
```

Do **not** add `--options runtime` unless you also sign with `build/entitlements.mac.plist`. That combination without entitlements crashes immediately; macOS then shows a misleading “check with the developer / this version of macOS” dialog.

If Gatekeeper still blocks: right-click the app → **Open**.

For distribution beyond friends/family, add Apple Developer ID signing + notarization later (`hardenedRuntime: true`, real `identity`, entitlements, notarize).
