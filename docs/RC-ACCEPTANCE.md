# RC acceptance

Seagulled 0.1.0-rc.1 is a Windows Electron app and a Node CLI with a shared durable conversation, goals, controls, provider setup and bounded team coordinator.

## Qualified paths

- Actual packaged Electron 44.5.1 startup: sandboxed preload, context isolation, no renderer Node access, provider autodiscovery, shared CLI session and clean shutdown with ownership files removed.
- Browser automation: native/key setup, composer budget, goal edits, goal and team controls, pending spend, work disclosure, authenticated artifact downloads and mobile layout.
- Actual native Codex goal: four provider calls (Todd, developer, reviewer, Todd), a generated file saved through validated host materialization, independent reviewer inspection, and separately verified exact bytes and SHA-256. [Receipt](native-acceptance.json).
- Durable source checks cover single authority, damaged state preservation, graceful pause boundaries, exact resume stages, unknown holds, one-time usage, allowance holds, UTF-8 requests, API authentication and artifact integrity.
- Recovered swarm checks cover worker/depth caps, provisioning, relay transport, original run identities and uncertain cleanup. Live Fly diagnostics are excluded from ordinary test discovery and require explicit opt-in.

## Cloud and provider scope

The isolated Fly path creates its own controller, intent journal, boot workspace and at most one new worker for a developer assignment. It captures the exact returned transcript before owned retirement. Existing fleet writers, workers, provider identities and paid reservations are not adopted.

The initial actual Fly attempt provisioned a worker and submitted a team run, but its configured Modal workspace was disabled (HTTP 404). It produced no successful model answer. The exact worker app and isolated boot workspace were removed; its original failed run is retained privately. Preflight now checks availability before provisioning. This failed run is separate from deterministic fixtures and native-provider acceptance.

A later isolated workspace creation returned HTTP 500 before any Fly provisioning or model submission. Exact-name readback found no surviving workspace. A durable source admission hold prevents new goals from repeating that failed mutation and lets the automatic route use native providers. The FLUJO owner is investigating the source failure; a successful cloud model run remains unqualified.

A separate local FLUJO instance accepted an isolated workspace and installed the boot flow. Its first real OpenAI model call returned HTTP 429 because the account had no credits; it produced no answer, and no Fly worker was created for this check. The owned workspace was deleted and the isolated process stopped. An account-specific admission hold now prevents a successful model catalog lookup from being reported as executable. Cloud model execution remains unqualified. [Sanitized receipt](cloud-availability.json).

Native subscription usage is counted separately from dollar billing. Published API token rates produce labeled estimates, not invoices. Unknown cloud cost reserves the remaining logical allowance and holds further metered work; subscription review may inspect existing results. Dollar controls are admission and output limits, not a qualified all-in Fly/Modal invoice guarantee. Pending allowance cannot be erased by reducing a budget.

Claude sign-in was discovered, but this host's native subscription execution was denied. The separate Anthropic key route is implemented and fixture tested. Antigravity is detected when installed; unattended execution was not established and is not offered as working. Modal inference setup accepts an inference Proxy Token; an ordinary account token is insufficient.

Fly cloning requires the local FLUJO source and controller host online. PC-off continuation, login-token cloning and arbitrary remote file extraction are not qualified. The local provider path saves validated generated files and allows download after checking the original hash.

## Distribution

The Windows portable build includes Electron and needs no terminal or port configuration. Its CLI source archive requires Node 22+. The public repository and package use an allowlist of source assets; private state, account keys, conversations and databases are excluded. The Windows RC is unsigned. macOS and Linux packaging definitions are present but have not been run on this Windows host.

The public project is a source derivative of a separately retained private engine repository. GitHub private forks cannot become public independently, so the public repository has its own clean history with source provenance.
