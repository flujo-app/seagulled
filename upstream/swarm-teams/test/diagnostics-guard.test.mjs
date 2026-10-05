import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const name of ['live-fly.mjs', 'live-fly-probe.mjs', 'live-fly-inspect.mjs']) {
  test(`unopted ${name} stops before cloud discovery or provisioning`, () => {
    const script = fileURLToPath(new URL(`../diagnostics/${name}`, import.meta.url));
    const { SWARM_ALLOW_LIVE_FLY, ...env } = process.env;
    const result = spawnSync(process.execPath, [script], {
      env: { ...env, FLUJO_CLOUD_PATH: 'missing-cloud-checkout', FLYCTL_PATH: 'missing-flyctl' },
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SWARM_ALLOW_LIVE_FLY=yes/);
    assert.doesNotMatch(result.stderr, /missing-cloud-checkout|missing-flyctl|journal|connect/i);
  });
}
