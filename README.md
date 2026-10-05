# seagulled
<img width="1024" height="559" alt="image" src="https://github.com/user-attachments/assets/06f52b10-7bd4-40a1-a5a6-7a0beaacb651" />

Talk to Todd. He delegates your goal to a team, checks what they bring back, and occasionally comes in and shits on everything.

Seagulled is an Electron desktop app and CLI for the FLUJO ecosystem. The conversation is the front door. Goals, budgets and work details stay within reach; infrastructure stays behind the scenes.

## Start

Download the Windows portable app from [Releases](https://github.com/flujo-app/seagulled/releases). Open it and tell Todd what you want done. Existing supported provider sign-ins are discovered locally. When a connection is needed, choose a provider in the setup dialog. Native login remains with the provider; API keys are handled by the local trusted process.

Use the goal sidebar to change a goal or its budget, pause, resume or stop. Task details show what was actually attempted. Spending updates as terminal provider usage arrives, with subscription and unpriced usage shown separately. Estimated amounts are not provider invoices.

Interrupted requests retain their original identities. Uncertain remote execution or cleanup holds further admission until reconciled; stopping the UI does not turn an unknown remote outcome into a successful cancellation.

## Development and CLI

Requires Node 22 or later. The desktop bundle includes its own Node runtime.

```sh
npm ci
npm start
npm run cli -- goal "Draft a concrete launch plan" --budget 2
npm run cli -- status
npm run cli -- pause GOAL_ID
npm run cli -- resume GOAL_ID
npm run cli -- stop GOAL_ID
npm test
npm run check
npm run dist
```

Desktop and CLI share private state in `~/.seagulled` (override with `SEAGULLED_HOME`). Only one runtime owns it; the CLI connects to an existing desktop session automatically. Credentials and conversations are excluded from source and release artifacts.

## Reuse

The recovered FLUJO/Fly worker-tree engine is included under `upstream/swarm-teams`. It provides bounded reservation, durable run identities and recovery holds. The Factory receipt helper is included under `upstream/factory`; Factory, O and Brain also inform supervision, accounting and presentation. Native Codex work is live verified. A complete company across Fly workers and successful subscription hot-cloning remain unqualified. See [source notices](THIRD_PARTY_NOTICES.md), [provenance](docs/provenance.json) and [RC acceptance](docs/RC-ACCEPTANCE.md) for precise implementation and validation scope.

This is an independent, unofficial parody interface, with a fictional Todd persona. No affiliation or endorsement is implied.
