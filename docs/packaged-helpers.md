# Packaged sign-in helpers

Windows x64 builds include pinned Fly and Modal browser sign-in helpers so a first installation does not depend on a terminal or preinstalled CLI. Fly uses the packaged ConPTY support; Modal runs through the packaged isolated Python interpreter. Account configuration and browser sign-in state belong in the user's private application data directory and are never build inputs.

`npm run package` and `npm run dist` run `scripts/prepare-helpers.mjs`. The script downloads only public distributions listed in `helpers-lock.json`, checks their SHA-256 hashes, extracts them into `.private/helpers/win32-x64`, and records every resulting file's size and hash. Subsequent builds verify that exact inventory. A changed or unfinished bundle stops the build and is preserved for inspection.

The current bundle contains Fly 0.4.111, Python 3.13.16, Modal 1.6.1, and 29 pinned Python dependency wheels. Original license files remain alongside those dependencies. Electron copies the bundle to `resources/helpers`; the provider resolver uses absolute paths and does not fall back to host CLIs when the selected bundle is incomplete. The Windows Node-API PTY prebuild is retained and must be checked with an actual packaged spawn.

Packaged acceptance verified the helper inventory, a local PTY spawn, and enabled Fly and Modal sign-in buttons in a temporary clean profile with host CLIs absent from PATH. This verifies helper availability, not completion of browser OAuth, cloud billing, or GPU capacity. Local voice acceptance used synthetic microphone audio; it does not qualify physical microphone hardware or an approved avatar movie.

A separate actual-helper check verified that guided sign-in reuses already verified personal Fly and Modal identities without starting browser login. That read-only reuse check performed no cloud mutation or paid inference and does not replace a new-account browser OAuth check.

These bundled helpers currently support Windows x64 only. Other platform targets require their own pinned helper distributions and packaged acceptance before a release can claim first-install support.
