# Build Seagulled from source

The complete source for the Windows x64 0.1.1 app is tagged
[`v0.1.1-source.1`](https://github.com/flujo-app/seagulled/tree/v0.1.1-source.1).
Use that tag or `seagulled-0.1.1-source.zip` from the
[0.1.1 release](https://github.com/flujo-app/seagulled/releases/tag/v0.1.1).
The source tag adds build inputs and documentation to stable 0.1.1;
previously published Windows and CLI binaries are unchanged. The default
branch has a separate dependency migration and is not this build.

## Requirements and build

- Windows x64, Node.js 22 or newer, npm and Windows' `tar.exe`.
- Internet access to public npm, Electron, Python, Fly and PyPI downloads.
- Git for cloning/exporting. Building an extracted ZIP does not require Git
  or access to a private repository.
- Google Chrome for browser tests. If absent, `npx playwright install chrome`
  can install it. Chrome is needed for tests, not the packaged app.

Run these commands in PowerShell:

```powershell
git clone --branch v0.1.1-source.1 --depth 1 https://github.com/flujo-app/seagulled.git
cd seagulled
npm ci
npm run check
npm test
npm run dist
```

For the ZIP, extract it and open PowerShell inside `seagulled-0.1.1`, then
start at `npm ci`. Output: `release/Seagulled-0.1.1-x64.exe`.
`npm run package` builds the unpacked app at `release/win-unpacked`.
No developer configuration, signed-in account, prepared helper directory or
separately running service is needed to build. Windows x64 packaging is the
qualified target; macOS/Linux target entries do not establish supported builds.

Package hooks verify and stage the seven committed clips in `assets/journey`,
then download and verify public helper distributions pinned in
`docs/helpers-lock.json`. Excerpt origins/timing and hashes are in
`docs/journey-media-lock.json`. Unexpected or damaged staging directories fail
closed; preserve them and use a fresh checkout. Build hooks and offline tests
do not sign into providers or deploy resources.

For the CLI archive:

```powershell
npm run prepare:media
npm pack --ignore-scripts
```

Output: `seagulled-0.1.1.tgz`. This runtime archive differs from the full source
ZIP, which also includes tests, development scripts, locks, upstream tests and
build documentation. Binary rebuilds are not promised to be byte-identical;
packaging timestamps/toolchain details can differ.

## Source layout and upstream inputs

| Directory | Contents |
| --- | --- |
| `src/` | Runtime, server, provider adapters and swarm integration |
| `electron/`, `ui/`, `bin/` | Desktop shell, renderer and CLI |
| `upstream/` | All selected upstream source used by this version and engine tests; see [upstream/README.md](upstream/README.md) |
| `assets/journey/`, `ui/clips/`, `ui/brands/` | Media and visual build inputs |
| `tests/`, `scripts/` | Offline checks, fixtures and packaging tools |
| `docs/` | Provenance, locks and contracts |
| `package-lock.json` | Exact public npm dependency graph for `npm ci` |

Original engine hashes in `docs/provenance.json` describe the initial
extraction; the source tag and exported inventory describe the final files,
including product fixes. No submodule or private npm package is required.
External Source/FLUJO and SDK services are optional runtime integrations,
not build inputs or redistributed code. A successful build does not qualify
remote subscription forwarding, live execution or cloud deployment.
Public voice model weights download to an application cache on demand and
are not needed to package the source.

## Export and verification

From a committed Git checkout, `npm run package:source` creates:

- `release/source/seagulled-0.1.1-source.zip`
- `release/source/seagulled-0.1.1-source.inventory.json`
- `release/source/seagulled-0.1.1-source.SHA256SUMS.txt`

The exporter reads committed blobs, includes the entire committed tree and
rejects links, submodules, account-state paths and credential patterns.
Untracked/ignored files, dependencies, runtime databases, download caches
and account state are excluded. Commit intended changes before exporting;
local edits are not included. The inventory records the source commit,
every file's SHA-256 and the archive's SHA-256.

Compare downloaded ZIP/inventory hashes using `Get-FileHash -Algorithm SHA256`
with the published source checksum file. From the extracted source directory,
verify every input against the downloaded inventory:

```powershell
node scripts/verify-source.mjs C:\absolute\path\seagulled-0.1.1-source.inventory.json
```

Dependency/media licenses remain separate from the application MIT license;
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
