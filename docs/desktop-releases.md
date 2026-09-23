# Desktop releases (GitHub Actions)

Desktop builds are published to [GitHub Releases](https://github.com/somitmittal/whatsapp-search/releases) when you push a version tag.

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
- On Render, set **`GITHUB_TOKEN`** (read-only PAT) to avoid API rate limits
- Override repo with env `GITHUB_REPO=owner/repo` if needed

## macOS install (unsigned / ad-hoc builds)

CI builds are **not** Apple Developer–signed or notarized. Clearing quarantine with `xattr` alone is **not enough** when the download has a broken or incomplete signature — macOS will still say the app is damaged.

Open the DMG (or mount it), then run:

```bash
cp -R /Volumes/Searchable/Searchable.app /Applications/
xattr -cr /Applications/Searchable.app
codesign --force --deep --sign - /Applications/Searchable.app
open /Applications/Searchable.app
```

(You can drag Searchable into Applications instead of the `cp` line.) If Gatekeeper still blocks: right-click the app → **Open**.

For distribution beyond friends/family, add Apple Developer ID signing + notarization later (`hardenedRuntime: true`, real `identity`, entitlements, notarize).
