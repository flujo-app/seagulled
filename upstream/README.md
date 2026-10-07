# Bundled upstream source

This directory contains all selected upstream source imported by Seagulled
0.1.1. It is committed directly; no private repository or submodule is needed
to rebuild the app.

| Location | Origin and scope |
| --- | --- |
| `swarm-teams/` | Recovered flujo-app engine at `f9d372a66dd2cb09f4bcfed34967404cf12d9007`: fleet lifecycle, ownership, provisioners, client, flows, specialists, native facade/ledger and tests, with later fixes tracked in this repository |
| `factory/receipts.mjs` | Pure receipt helper extracted from Factory `510b733f8af0305bb2969592fe25cc73549306a4` |

`docs/provenance.json` records the initial extraction and selected later
contributions. The exported source inventory hashes the final included files.
Original account state, conversations, databases and credentials are excluded.

`swarm-teams/diagnostics/live-fly*.mjs` files are opt-in live diagnostics;
builds and offline tests do not invoke them. Separately installed FLUJO/Source
and flujo-cloud SDK runtimes are not bundled and are not required for building
the Electron or CLI packages. Their live integrations retain independent
qualification and licensing requirements.

Public third-party build dependencies are pinned in `package-lock.json` and
`docs/helpers-lock.json`; see `THIRD_PARTY_NOTICES.md`.
