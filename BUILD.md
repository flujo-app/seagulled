# Build Seagulled 0.2.0

Use Windows x64 and Node.js 24.22.1. Download the named source ZIP from the
0.2.0 GitHub release for all source and locked media inputs. GitHub's automatic
source archive omits the ignored dialogue clips.

```powershell
npm ci
$env:SEAGULLED_MEDIA_DIR = Join-Path (Get-Location) 'ui/journey-media'
npm run check
npm test
$env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '1'
npm run dist
```

The portable executable appears under `release/0.2.0/`. The build verifies and,
when absent, downloads public account helpers and official Node 24.22.1 using
the committed SHA256 locks. Dialogue assets must match the seven-file media
lock. No credentials, account files, conversations or runtime database are
needed for the build. Keep personal runtime data outside this source tree.

Production dependencies resolve from the lock: FLUJO 3.48.1 from npm, FACTORY
0.3.0 and flujo-cloud 0.2.0 from their versioned public GitHub releases. FACTORY
uses its public SDK exports; no private compatibility package is needed.
The Electron package unpacks dependencies so its bundled Node can start FLUJO
without a host Node installation, terminal command, port choice or deployment
configuration. The CLI requires the supported host Node runtime.

The product checks its matching official FLUJO image and pins the verified
manifest digest before provisioning. Offline tests and read-only registry
checks do not establish live cloud execution or final billed spending.
