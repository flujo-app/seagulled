# RC acceptance

Seagulled 0.1.0-rc.3 is a Windows Electron app and a Node CLI with a shared durable conversation, goals, controls, provider setup and bounded team coordinator. The full live company across Fly workers is still unqualified.

The candidate is checked with 79 automated cases. Packaged Electron startup, renderer isolation, provider discovery, shared CLI access and shutdown are separate release gates; the CLI archive runs independently. Package auditing excludes private-state entries. These checks do not replace live cloud qualification.

## Qualified paths

- Actual packaged Electron 44.5.1 startup: sandboxed preload, context isolation, no renderer Node access, provider autodiscovery, shared CLI session and clean shutdown with ownership files removed.
- Browser automation: native/key setup, composer budget, goal edits, goal and team controls, pending spend, work disclosure, authenticated artifact downloads and mobile layout.
- Actual native Codex goal: four provider calls (Todd, developer, reviewer, Todd), a generated file saved through validated host materialization, independent reviewer inspection, and separately verified exact bytes and SHA-256. [Receipt](native-acceptance.json).
- Durable source checks cover single authority, damaged state preservation, graceful pause boundaries, exact resume stages, unknown holds, one-time usage, allowance holds, UTF-8 requests, API authentication and artifact integrity.
- Recovered swarm checks cover worker/depth caps, provisioning, relay transport, original run identities and uncertain cleanup. Product fixtures also exercise child-before-parent artifact capture, incomplete-capture retirement holds, and exact owned relay journals. Live Fly diagnostics are excluded from ordinary test discovery and require explicit opt-in.
- Artifact capture executes trusted collection code against a designated output tree, validates file names, bounds, links, bytes and SHA-256, then saves private receipts atomically. Tests use actual local files and Node execution; successful capture from a live Fly worker remains unqualified.
- The collector supports Fly CLI's omitted zero exit code, while explicit failure or malformed codes cannot commit artifacts. The official [Fly response type](https://github.com/superfly/fly-go/blob/main/machine_types.go) omits the zero value when serialized. This fixes a receipt compatibility defect; it does not establish the cause of the earlier live model failure.
- The exact collection command also passed in the cached immutable Linux worker image with networking disabled and a read-only fixture mount: one 33-byte file matched its expected SHA-256. This was a batch collection check, with no FLUJO service startup, provider call or Fly mutation; it does not qualify a live cloud deliverable.

## Cloud and provider scope

The isolated Fly path creates its own controller, intent journal and boot workspace. With independently usable API credentials, the recovered worker-tree engine can create up to three workers by default, at depth two, with an owned relay for remote delegation. This company path is implemented and fixture tested, but has not completed a live multi-worker acceptance run. Keyless Codex subscription mode permits one Fly worker, with a successful local boot call required before cloning. It does not qualify concurrent copies of one subscription login.

Final worker files must be saved under the designated `seagulled-output` directory. Completed workers with missing or incomplete capture retain their exact sandbox and hold new admission; failed calls retain a failure receipt and may retire without claiming delivered files. Captured outputs are private, with common credential names and linked files rejected. A renamed secret could still be generated inside this directory; filename checks do not establish secret-free content. Existing fleet writers, workers, provider identities and paid reservations are not adopted.

The initial actual Fly attempt provisioned a worker and submitted a team run, but its configured Modal workspace was disabled (HTTP 404). It produced no successful model answer. The exact worker app and isolated boot workspace were removed; its original failed run is retained privately. Preflight now checks availability before provisioning. This failed run is separate from deterministic fixtures and native-provider acceptance.

A later isolated workspace creation returned HTTP 500 before any Fly provisioning or model submission. Exact-name readback found no surviving workspace. A durable source admission hold prevents new goals from repeating that failed mutation and lets the automatic route use native providers. The FLUJO owner is investigating the source failure; a successful cloud model run remains unqualified.

A separate local FLUJO instance accepted an isolated workspace and installed the boot flow. Its first real OpenAI model call returned HTTP 429 because the account had no credits; it produced no answer, and no Fly worker was created for this check. The owned workspace was deleted and the isolated process stopped. An account-specific admission hold now prevents a successful model catalog lookup from being reported as executable. Cloud model execution remains unqualified. [Sanitized receipt](cloud-availability.json).

A later bounded subscription attempt used the existing FLUJO encrypted snapshot transfer with a fresh file-backed Codex login cache. Its local keyless Codex boot returned `READY`. One newly owned Fly worker reached ready and accepted a team run, which ended in a confirmed conversation failure. No model answer or complete remote file receipt was produced. The precise provider cause was not retained before retirement; future failed runs now retain bounded diagnostic classifications before deletion. The owned Fly app was removed, and no host login-cache rewrite was observed. This does not establish remote token validity, refresh durability or global stream exclusivity. Two local boot folders reappeared after successful API deletion responses; their isolated process is stopped and only empty directory shells remain. Automatic review blocked exact filesystem removal, so local deletion remains unresolved. There was no replay.

A new local-only tool-enabled team diagnostic was prepared to distinguish tool-free boot from full team compatibility. Automatic command review blocked startup of its fresh isolated FLUJO source, including a managed foreground alternative. Neither command executed; no diagnostic workspace, conversation, model call or Fly resource was created. No further launcher workaround was attempted. Tool-enabled FLUJO/Codex team compatibility remains unqualified.

Native subscription usage is counted separately from dollar billing. Published API token rates produce labeled estimates, not invoices. Unknown cloud cost reserves the remaining logical allowance and holds further metered work; subscription review may inspect existing results. Dollar controls are admission and output limits, not a qualified all-in Fly/Modal invoice guarantee. Pending allowance cannot be erased by reducing a budget.

Claude sign-in was discovered, but this host's native subscription execution was denied. The separate Anthropic key route is implemented and fixture tested. Antigravity is detected when installed; unattended execution was not established and is not offered as working. Modal inference setup accepts an inference Proxy Token; an ordinary account token is insufficient.

Fly cloning requires the local FLUJO source and controller host online. PC-off continuation, successful subscription hot-clone execution, concurrent cloned subscription refresh and arbitrary remote file extraction are not qualified. The local provider path saves validated generated files and allows download after checking the original hash. Copied Codex caches follow the upstream file-store and trusted transfer path; they are not treated as generic API keys. See the official [headless authentication guidance](https://learn.chatgpt.com/docs/auth) and [copied-cache concurrency guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth).

## Distribution

The Windows portable build includes Electron and needs no terminal or port configuration. Its CLI source archive requires Node 22+. The public repository and package use an allowlist of source assets; private state, account keys, conversations and databases are excluded. The Windows RC is unsigned. macOS and Linux packaging definitions are present but have not been run on this Windows host.

The public project is a source derivative of a separately retained private engine repository. GitHub private forks cannot become public independently, so the public repository has its own clean history with source provenance.
