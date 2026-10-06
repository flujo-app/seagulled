# Seagulled coordination

Build the Electron and CLI release candidate in this checkout. Reuse the recovered swarm lineage from f9d372a through the owner-produced @flujo-app/swarm-teams package; installed dependency pins are recorded in docs/provenance.json. Keep secrets, conversations, runtime databases, private access links and account state outside Git. Never import credential files into public source. Do not mention the separate event project in public documentation.

Parent owns package.json, src/runtime.mjs, src/server.mjs, bin/, docs/, release and repo operations. Provider chat owns src/providers/ and tests/providers*. Swarm chat owns src/swarm/, tests/swarm* and retained swarm package fixes. Desktop chat owns electron/, ui/ and tests/ui*. Coordinate contract changes through COORDINATION.md; do not commit another writer's unfinished changes. Existing production service owners retain their resources. Use isolated new resources for this product only when necessary.

Acceptance: persist goals and conversation; editable goals and budgets; pause/stop and cancellation; honest provider availability and spend; no required terminal, port or deployment decisions in desktop UI; real provider path plus deterministic offline tests; packaged Electron and CLI; no secrets in public Git. Do not claim estimated spend as billed spend or fixture execution as a live provider run.
