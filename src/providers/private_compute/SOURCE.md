This source adapts tracked `app.py`, `settings.py`, and `discovery.py` from the user's
`o-private-inference` checkout at commit
`496e5930fa23836f5e805ef226afe840f728b888` (October 5, 2026).

The serving model, revision, vLLM version, memory estimate, discovery
middleware, and single H100 design are retained. Seagulled requires an
isolated product app name, shortens idle and request limits, and must never
import the original project's private endpoint, token, Secret, Volumes, or
runtime account configuration. The source project did not contain a license
file at that commit; the user explicitly requested reuse of this local source.
