# Desktop releases (GitHub Actions)

Desktop builds are published to [GitHub Releases](https://github.com/somitmittal/whatsapp-search/releases) when you push a version tag.

## Create a release

```bash
git tag v1.0.0
git push origin v1.0.0
```

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

## macOS note

CI builds are **unsigned**. Users may need Right-click → Open the first time. For distribution outside friends/family, add Apple code signing + notarization to the workflow later.
