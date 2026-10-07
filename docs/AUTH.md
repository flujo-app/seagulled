# Account authentication and swarm providers

The wizard connects account sessions. Deployment additionally needs a qualified inference route, product-owned source/SDK runtime and a verified Fly lease. An account marked connected does not establish those deployment capabilities.

The revised wizard checks provider and Modal/Fly account status in parallel before showing provider activation controls. Logo buttons then toggle selection immediately, without sign-in, disconnect or another discovery call. Signed-out accounts have a separate explicit Sign in action. A grey activation dot means deselected even when the account remains signed in; reactivation reuses that session. Completion persists the selected providers, and New Swarm defaults to an activated provider. At the user's final preference, dialogue clips play inside the glass dialog while the home background loop keeps playing. A top-right app X closes the Electron window, including while dialogs are open; the dialog's own X still dismisses that dialog.

Startup, account checks and explicit sign-in waits use the muted Starfield loading segment at 1:21–1:26 from the user-supplied video. Setup and swarm-settings dialog opens/closes trigger an 800 ms loading pulse with 180 ms crossfades. Concurrent checks retain the scene until all checks settle; dialog dismissal cancels sign-in and does not let an older transition hide a newer check. The loading video pauses after fading away, and provider activation remains immediate.

| Selection | Authentication | What the swarm receives today |
| --- | --- | --- |
| Modal | Reuses a verified personal CLI profile, or runs bundled `python -m modal setup` with a product-private `MODAL_CONFIG_PATH` | Account readiness only. Modal Proxy Token inference is a separate connection; the isolated private H100 route requires its own admitted deployment and probe |
| Fly | Reuses a verified personal config, or runs bundled `flyctl auth login` in a hidden PTY with product-private `FLY_CONFIG_DIR`; verifies identity afterward | A backend-only lease containing the exact bundled helper/config paths and verified account scope; credentials are not copied into product source |
| Codex | Checks `codex login status` for ChatGPT authentication; otherwise runs `codex login` and rechecks | Local native CLI session reuse. The isolated Worker subscription route remains unavailable |
| Claude | Checks `claude auth status` for `loggedIn: true` and `authMethod: "claude.ai"`; otherwise runs `claude auth login --claudeai` and rechecks | Local native CLI session reuse. The isolated Worker subscription route remains unavailable |

Codex and Claude keep their credentials in their native private stores. Product settings save the provider method/model, not subscription tokens. Native child environments remove inherited API keys, OAuth token overrides and alternate cloud-provider settings so that a subscription selection cannot silently select the inherited API route. Local subscription usage is recorded as subscription usage, not billed API spend.

`ProviderManager.fleetRoute('codex')` and `fleetRoute('claude')` deliberately return unavailable. No normal product path uploads their login files into Fly Workers. A prior experimental Codex Worker result did not qualify inference, refresh or concurrent subscription use. There is no enabled Claude remote subscription route. Connecting these logos therefore cannot yet make a subscription-backed deployed swarm run.

Fly account authentication alone also does not prove payment readiness, quota or resource permission. Admission rechecks the bundled helper and personal identity, selects a single personal organization, and journals fresh owned resource identities. Existing unrelated apps remain under their owners. Account/config paths and private access links stay backend-only.

Modal account authentication and Modal inference authentication are distinct. A CLI account session permits account operations; a Proxy Token selects a supported inference endpoint/model. The ordinary Modal inference adapter also returns an unavailable fleet route. The wizard's New Swarm Modal selection requests the separate private H100 route, which uses a newly owned endpoint and bearer with startup, spending and cleanup holds. Neither route is inferred from a successful wizard login.

The remaining deployment boundary was rechecked against current source on 2026-10-07: Electron does not supply a product Source/SDK binding, and every normal wizard selection still requires remote route qualification. Save can persist and attempt admission, but account readiness cannot satisfy that boundary. No credential upload or native subscription activation is implemented by selecting a logo.

Modal's [Shared Endpoint documentation](https://modal.com/docs/guide/shared-endpoints) requires a Proxy Token and says token rates are available when creating an endpoint and in its Usage view. Included compute credits cannot pay for Shared Endpoint token usage. The [Fly pricing page](https://docs.fly.io/about/pricing/) separately lists Machine, storage and network charges. The current Fly compute estimate therefore cannot establish an all-in swarm price; endpoint-specific inference pricing and actual usage remain required.

Verification on 2026-10-07 included 38 focused auth/provider/UI checks and real read-only recognition of existing Codex, Claude, Modal and Fly sessions. These checks performed no browser login mutation, paid inference or deployment. The rebuilt Windows package also verifies bundled Modal/Fly helper availability in an account-free profile without host CLIs on PATH. Fresh browser completion and remote subscription use remain separate acceptance work.

Implementation: [provider manager](../src/providers/index.mjs), [wizard](../ui/journey.js), [runtime admission](../src/runtime.mjs), [acceptance checklist](JOURNEY-ACCEPTANCE.md).
