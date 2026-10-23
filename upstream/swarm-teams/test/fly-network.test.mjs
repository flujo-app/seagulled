import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flyProvisioner } from '../fleet/provisioners.mjs';

const network = 'swarm-g-0123456789abcdef0123456789abcdef';
const accountRef = `fly-account-sha256:${'a'.repeat(64)}`;
const owner = '11111111-2222-4333-8444-555555555555';
const attemptId = '22222222-3333-4333-8444-666666666666';
const bearer = 'fixture-private-bearer-0123456789abc';
const setup = (version = 1, ownedProxy = true) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'swarm-network-sdk-'));
  mkdirSync(path.join(root, 'lib'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(root, 'lib', 'managed.mjs'), `export class ManagedCloud {
    static privateNetworkContractVersion = ${JSON.stringify(version)};
    constructor(options) { this.env = options.env; }
    async up(options) { return globalThis.__networkSdkFixture.up(options); }
    async deployment(app) {
      const value = await globalThis.__networkSdkFixture.deployment(app);
      return { ...value, metadata: { id: app, attemptId: '${attemptId}', phase: 'ready',
        profile: 'private-workspace', ...value.metadata },
        journal: { stage: 'ready', profile: 'private-workspace', ...value.journal },
        files: value.files ?? { credentials: app + '/credentials.json' } };
    }
    async down(app) { return globalThis.__networkSdkFixture.down(app); }
    ${ownedProxy ? 'async openOwnedProxy(target) { return globalThis.__networkSdkFixture.openOwnedProxy(target); }' : ''}
    async credential(files, metadata, { required = false } = {}) {
      const value = await globalThis.__networkSdkFixture.readPrivateJson(files.credentials);
      if (!value && !required) return null;
      if (value?.format !== 'flujo-worker-credential' || value.version !== 1
        || value.id !== metadata.id || value.attemptId !== metadata.attemptId) {
        throw new Error('Worker credential does not match this managed attempt.');
      }
      return value;
    }
    paths(app) { return { credentials: app + '/credentials.json' }; }
  }`);
  writeFileSync(path.join(root, 'lib', 'process.mjs'), `export const createFlyRunner = () => ({
    proxy: async () => { throw new Error('No fixture proxy is permitted.'); }
  }); export const unusedLoopbackPort = async () => 48126;`);
  writeFileSync(path.join(root, 'lib', 'private-files.mjs'),
    'export const readPrivateJson = async () => globalThis.__networkSdkFixture.readPrivateJson();');
  writeFileSync(path.join(root, 'lib', 'snapshot.mjs'), `export const controlToken = (value) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._~+/=-]{32,}$/.test(value)) {
      throw new Error('Saved Worker credential is malformed.');
    }
    return value;
  };`);
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
};

test('Worker app is privately planned before SDK up and exact ID/network are checked before use and retirement', async () => {
  const f = setup();
  const plans = new Map();
  const calls = [];
  globalThis.__networkSdkFixture = {
    async up(options) {
      assert.equal(plans.get(options.app)?.state, 'planned');
      assert.equal(options.network, network);
      assert.equal(options.org, 'personal');
      assert.equal(options.profile, 'private-workspace');
      calls.push('up');
      return { worker: options.app, org: options.org, machineId: 'machineabc',
        workspace: 'boot', state: 'ready' };
    },
    async deployment(app) { return { metadata: { org: 'personal', network, workspace: 'boot' },
      journal: { app, appId: 'appabc', owner, org: 'personal', network, workspace: 'boot',
        machineId: 'machineabc',
        ownershipConfirmed: true, state: 'ready' } }; },
    async down() { calls.push('down'); return { state: 'destroyed' }; },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      source: 'http://127.0.0.1:4200', org: 'personal', network, accountRef,
      captureSpacingMs: 1, concurrency: 1,
      verifyFreshApp: async () => undefined, onPlannedApp: ({ app, kind, network: bound }) => {
        assert.equal(kind, 'worker'); assert.equal(bound, network);
        plans.set(app, { state: 'planned' }); calls.push('plan');
      },
      onConfirmedApp: ({ app, appId, ownerMarker }) => { assert.equal(appId, 'appabc');
        assert.equal(ownerMarker, `FLUJO_CLOUD_OWNER_${owner.replaceAll('-', '')}`);
        plans.set(app, { state: 'confirmed', appId }); calls.push('confirm'); },
      onRetiredApp: (app) => { plans.set(app, { state: 'retired' }); calls.push('retired'); },
      verifyNetwork: async () => { calls.push('membership'); },
      installTemplateImpl: async () => { calls.push('template'); },
    });
    provisioner.connect = async () => ({ client: {}, close: async () => undefined });
    const target = await provisioner.provision({ id: 'worker-one' }, {});
    assert.equal(target.network, network);
    assert.equal(target.appId, 'appabc');
    assert.deepEqual(calls.slice(0, 5), ['plan', 'membership', 'up', 'confirm', 'membership']);
    await provisioner.retire(target);
    assert.equal(plans.get(target.app).state, 'retired');
    assert.equal(calls.includes('down'), true);
  } finally { delete globalThis.__networkSdkFixture; f.close(); }
});

test('Worker awaits fresh app verification before durable plan and SDK effects', async () => {
  const f = setup();
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const calls = [];
  globalThis.__networkSdkFixture = {
    up: async () => { calls.push('up'); throw new Error('No SDK creation.'); },
    down: async () => { calls.push('down'); throw new Error('No cleanup of an unplanned app.'); },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root,
      templateWorkspace: 'boot', org: 'personal', network, accountRef,
      captureSpacingMs: 1, concurrency: 1,
      verifyFreshApp: async () => { calls.push('verify'); entered(); await held;
        throw new Error('Org inventory is incomplete.'); },
      onPlannedApp: () => { calls.push('plan'); },
      onConfirmedApp: () => undefined, onRetiredApp: () => undefined,
      verifyNetwork: async () => { calls.push('membership'); },
    });
    const provisioning = provisioner.provision({ id: 'worker-held' }, {});
    await started;
    assert.deepEqual(calls, ['verify']);
    release();
    await assert.rejects(provisioning, /inventory is incomplete/);
    assert.deepEqual(calls, ['verify']);
  } finally { delete globalThis.__networkSdkFixture; f.close(); }
});

test('unpatched SDK refuses requested network before any Worker app plan', async () => {
  const f = setup(null);
  let planned = false;
  try {
    await assert.rejects(flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      org: 'personal', network, accountRef, verifyFreshApp: async () => undefined, onPlannedApp: () => { planned = true; },
      onConfirmedApp: () => undefined, onRetiredApp: () => undefined,
      verifyNetwork: async () => undefined }), /pinned cloud SDK/);
    assert.equal(planned, false);
  } finally { f.close(); }
});

test('network-capable SDK without an owned proxy API refuses before any Worker app plan', async () => {
  const f = setup(1, false);
  let planned = false;
  try {
    await assert.rejects(flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      org: 'personal', network, accountRef, verifyFreshApp: async () => undefined, onPlannedApp: () => { planned = true; },
      onConfirmedApp: () => undefined, onRetiredApp: () => undefined,
      verifyNetwork: async () => undefined }), /pinned cloud SDK/);
    assert.equal(planned, false);
  } finally { f.close(); }
});

test('legacy Worker provisioning does not opt into the private-workspace profile', async () => {
  const f = setup();
  let options;
  globalThis.__networkSdkFixture = {
    async up(input) { options = input; throw new Error('Fixture stops before creation.'); },
    async down() { return { state: 'destroyed' }; },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root,
      templateWorkspace: 'boot', source: 'http://127.0.0.1:4200', org: 'personal',
      captureSpacingMs: 1, concurrency: 1 });
    await assert.rejects(provisioner.provision({ id: 'legacy-worker' }, {}), /Fixture stops/);
    assert.equal(options.profile, undefined);
    assert.equal(options.network, undefined);
  } finally { delete globalThis.__networkSdkFixture; f.close(); }
});

test('initial Workers exceed capture concurrency but all confirm membership before templates start', async () => {
  const f = setup();
  const plans = new Map();
  const order = [];
  globalThis.__networkSdkFixture = {
    async up(options) { order.push(`up:${options.app}`);
      return { worker: options.app, org: options.org, machineId: 'machineabc',
        workspace: 'boot', state: 'ready' }; },
    async deployment(app) { return { metadata: { org: 'personal', network, workspace: 'boot' },
      journal: { app, appId: app, owner, org: 'personal', network, workspace: 'boot',
        machineId: 'machineabc',
        ownershipConfirmed: true, state: 'ready' } }; },
    async down() { return { state: 'destroyed' }; },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      source: 'http://127.0.0.1:4200', org: 'personal', network, accountRef,
      initialWorkers: 2, concurrency: 1, captureSpacingMs: 1,
      verifyFreshApp: async () => undefined, onPlannedApp: ({ app }) => { plans.set(app, 'planned'); order.push(`plan:${app}`); },
      onConfirmedApp: ({ app }) => { plans.set(app, 'confirmed'); order.push(`confirmed:${app}`); },
      onRetiredApp: () => undefined,
      verifyNetwork: async ({ allowPending }) => {
        if (!allowPending && [...plans.values()].some((state) => state !== 'confirmed')) {
          throw Object.assign(new Error('Sibling pending'), { code: 'NETWORK_PENDING' });
        }
      },
      installTemplateImpl: async () => { order.push('template'); },
    });
    provisioner.connect = async () => ({ client: {}, close: async () => undefined });
    const [first, second] = await Promise.all([
      provisioner.provision({ id: 'one' }, {}), provisioner.provision({ id: 'two' }, {}),
    ]);
    assert.notEqual(first.app, second.app);
    const lastConfirmation = Math.max(...order.map((item, index) =>
      item.startsWith('confirmed:') ? index : -1));
    const firstTemplate = order.indexOf('template');
    assert.ok(firstTemplate > lastConfirmation);
    assert.equal(order.filter((item) => item === 'template').length, 2);
  } finally { delete globalThis.__networkSdkFixture; f.close(); }
});

test('Stop after confirmed creation retires only the exact Worker under the same account', async () => {
  for (const accountChanged of [false, true]) {
    const f = setup();
    const stop = new AbortController();
    const calls = [];
    let planned;
    let confirmed;
    globalThis.__networkSdkFixture = {
      async up(options) {
        calls.push(`up:${options.app}`);
        stop.abort();
        return { worker: options.app, org: options.org, machineId: 'machineabc',
          workspace: 'boot', state: 'ready' };
      },
      async deployment(app) { return { metadata: { org: 'personal', network, workspace: 'boot' },
        journal: { app, appId: 'exact-app-id', owner, org: 'personal', network, workspace: 'boot',
          machineId: 'machineabc',
          ownershipConfirmed: true, state: 'ready' } }; },
      async down(app) { calls.push(`down:${app}`); return { state: 'destroyed' }; },
    };
    try {
      const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
        source: 'http://127.0.0.1:4200', org: 'personal', network, accountRef,
        captureSpacingMs: 1, concurrency: 1,
        verifyFreshApp: async () => undefined, onPlannedApp: ({ app }) => { planned = app; calls.push(`plan:${app}`); },
        onConfirmedApp: ({ app, appId }) => {
          assert.equal(app, planned); assert.equal(appId, 'exact-app-id');
          confirmed = app; calls.push(`confirm:${app}`);
        },
        onRetiredApp: (app) => { assert.equal(app, confirmed); calls.push(`retired:${app}`); },
        verifyNetwork: async ({ operation = 'dispatch' }) => {
          calls.push(`fence:${operation}`);
          if (operation === 'cleanup' && accountChanged) {
            throw Object.assign(new Error('Selected account changed.'), { code: 'NETWORK_MEMBERSHIP' });
          }
          if (operation === 'dispatch' && stop.signal.aborted) {
            throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
          }
        },
        installTemplateImpl: async () => { throw new Error('No run template may start after Stop.'); },
      });
      await assert.rejects(provisioner.provision({ id: 'worker-one' }, {}), (error) => {
        assert.match(error.message, accountChanged ? /Selected account changed/ : /Cancelled.*retired/);
        assert.equal(error.cleanup.app, planned);
        assert.equal(error.cleanup.confirmed, !accountChanged);
        return true;
      });
      assert.equal(calls.filter((call) => call.startsWith('up:')).length, 1);
      assert.equal(calls.filter((call) => call.startsWith('down:')).length,
        accountChanged ? 0 : 1);
      assert.equal(calls.some((call) => call.startsWith('retired:')), !accountChanged);
      assert.ok(calls.indexOf(`confirm:${planned}`) < calls.indexOf('fence:cleanup'));
    } finally { delete globalThis.__networkSdkFixture; f.close(); }
  }
});

test('a mismatched SDK result can retire only the privately planned app', async () => {
  const f = setup();
  let planned;
  const deletions = [];
  globalThis.__networkSdkFixture = {
    async up() { return { worker: 'foreign-app', org: 'personal', machineId: 'machineabc' }; },
    async deployment() { throw new Error('A foreign result must never be inspected.'); },
    async down(app) { deletions.push(app); return { state: 'destroyed' }; },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      source: 'http://127.0.0.1:4200', org: 'personal', network, accountRef,
      captureSpacingMs: 1, concurrency: 1,
      verifyFreshApp: async () => undefined, onPlannedApp: ({ app }) => { planned = app; },
      onConfirmedApp: () => { throw new Error('No mismatched app can be confirmed.'); },
      onRetiredApp: (app) => { assert.equal(app, planned); },
      verifyNetwork: async () => undefined,
    });
    await assert.rejects(provisioner.provision({ id: 'worker-one' }, {}),
      (error) => error.cleanup.confirmed === true && error.cleanup.app === planned
        && /identity does not match/.test(error.message));
    assert.deepEqual(deletions, [planned]);
    assert.notEqual(planned, 'foreign-app');
  } finally { delete globalThis.__networkSdkFixture; f.close(); }
});

test('a created Machine differing from the SDK journal is retired before confirmation or proxy', async () => {
  const f = setup();
  let planned;
  let confirmed = false;
  const down = [];
  globalThis.__networkSdkFixture = {
    async up(options) { return { worker: options.app, org: options.org,
      machineId: 'different-machine', workspace: 'boot', state: 'ready' }; },
    async deployment(app) { return { metadata: { org: 'personal', network, workspace: 'boot' },
      journal: { app, appId: 'appabc', owner, org: 'personal', network, workspace: 'boot',
        machineId: 'machineabc', ownershipConfirmed: true, state: 'ready' } }; },
    async down(app) { down.push(app); return { state: 'destroyed' }; },
    async openOwnedProxy() { throw new Error('Mismatched Machine cannot open a proxy.'); },
    async readPrivateJson() { throw new Error('Mismatched Machine cannot read credentials.'); },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      source: 'http://127.0.0.1:4200', org: 'personal', network, accountRef,
      captureSpacingMs: 1, concurrency: 1,
      verifyFreshApp: async () => undefined, onPlannedApp: ({ app }) => { planned = app; },
      onConfirmedApp: () => { confirmed = true; },
      onRetiredApp: (app) => { assert.equal(app, planned); },
      verifyNetwork: async () => undefined,
    });
    await assert.rejects(provisioner.provision({ id: 'worker-one' }, {}),
      (error) => error.cleanup.confirmed === true && /network receipt/.test(error.message));
    assert.equal(confirmed, false);
    assert.deepEqual(down, [planned]);
  } finally { delete globalThis.__networkSdkFixture; f.close(); }
});

test('tampered target and changed current Machine fail before bearer or proxy effects', async () => {
  const f = setup();
  let machine = 'machineabc';
  let sdkChecks = 0;
  let proxyStarts = 0;
  let bearerReads = 0;
  globalThis.__networkSdkFixture = {
    async deployment(app) { return { metadata: { org: 'personal', network, workspace: 'boot' },
      journal: { app, appId: 'appabc', owner, org: 'personal', network, workspace: 'boot',
        machineId: 'machineabc', ownershipConfirmed: true, state: 'ready' } }; },
    async openOwnedProxy(target) {
      sdkChecks++;
      assert.equal(target.appId, 'appabc');
      if (machine !== target.machineId) throw new Error('Fresh owned Machine changed.');
      proxyStarts++;
      throw new Error('Fixture proxy should not start in a refusal case.');
    },
    async readPrivateJson() { bearerReads++; throw new Error('No bearer read is permitted.'); },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      org: 'personal', network, accountRef, initialWorkers: 0,
      verifyFreshApp: async () => undefined, onPlannedApp: () => undefined, onConfirmedApp: () => undefined,
      onRetiredApp: () => undefined, verifyNetwork: async () => undefined });
    const target = { kind: 'fly', app: 'swarm-worker-fixture', appId: 'appabc',
      org: 'personal', network, accountRef, machineId: 'machineabc', workspace: 'boot' };
    await assert.rejects(provisioner.connect({ ...target, machineId: 'other-machine' }),
      /network receipt/);
    await assert.rejects(provisioner.connect({ ...target, workspace: 'other-workspace' }),
      /not pinned/);
    const originalDeployment = globalThis.__networkSdkFixture.deployment;
    globalThis.__networkSdkFixture.deployment = async (app) => {
      const value = await originalDeployment(app);
      return { ...value, metadata: { ...value.metadata, profile: undefined },
        journal: { ...value.journal, profile: undefined } };
    };
    await assert.rejects(provisioner.connect(target), /network receipt/);
    globalThis.__networkSdkFixture.deployment = originalDeployment;
    assert.equal(sdkChecks, 0);
    machine = 'changed-machine';
    await assert.rejects(provisioner.connect(target), /Fresh owned Machine changed/);
    assert.equal(sdkChecks, 1);
    assert.equal(proxyStarts, 0);
    assert.equal(bearerReads, 0);
  } finally { delete globalThis.__networkSdkFixture; f.close(); }
});

test('the proposed SDK owned-proxy API supplies the only product Worker connection', async () => {
  const f = setup();
  const server = http.createServer((_, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const calls = [];
  globalThis.__networkSdkFixture = {
    async deployment(app) { return { metadata: { org: 'personal', network, workspace: 'boot' },
      journal: { app, appId: 'appabc', owner, org: 'personal', network, workspace: 'boot',
        machineId: 'machineabc', ownershipConfirmed: true, state: 'ready' } }; },
    async openOwnedProxy(target) {
      calls.push('sdk-owned-machine-and-image-check');
      assert.equal(target.machineId, 'machineabc');
      calls.push('sdk-proxy');
      return { origin: `http://127.0.0.1:${port}`, check: () => undefined,
        stop: async () => { calls.push('sdk-proxy-close'); return { childClosed: true }; } };
    },
    async readPrivateJson() { calls.push('bearer'); return { format: 'flujo-worker-credential',
      version: 1, id: 'swarm-worker-fixture', attemptId, token: bearer }; },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      org: 'personal', network, accountRef, initialWorkers: 0,
      verifyFreshApp: async () => undefined, onPlannedApp: () => undefined, onConfirmedApp: () => undefined,
      onRetiredApp: () => undefined, verifyNetwork: async () => { calls.push('membership'); } });
    const target = { kind: 'fly', app: 'swarm-worker-fixture', appId: 'appabc',
      org: 'personal', network, accountRef, machineId: 'machineabc', workspace: 'boot' };
    const connection = await provisioner.connect(target);
    assert.ok(connection.client);
    await connection.close();
    assert.deepEqual(calls.slice(0, 4), ['membership', 'sdk-owned-machine-and-image-check',
      'sdk-proxy', 'bearer']);
    assert.equal(calls.at(-1), 'sdk-proxy-close');
  } finally {
    delete globalThis.__networkSdkFixture;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    f.close();
  }
});

test('an owned proxy without observed child-close leaves an explicit cleanup hold', async () => {
  const f = setup();
  const server = http.createServer((_, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  globalThis.__networkSdkFixture = {
    async deployment(app) { return { metadata: { org: 'personal', network, workspace: 'boot' },
      journal: { app, appId: 'appabc', owner, org: 'personal', network, workspace: 'boot',
        machineId: 'machineabc', ownershipConfirmed: true, state: 'ready' } }; },
    async openOwnedProxy() { return { origin: `http://127.0.0.1:${port}`,
      check: () => undefined, stop: async () => ({ childClosed: false }) }; },
    async readPrivateJson() { return { format: 'flujo-worker-credential', version: 1,
      id: 'swarm-worker-fixture', attemptId, token: bearer }; },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      org: 'personal', network, accountRef, initialWorkers: 0,
      verifyFreshApp: async () => undefined, onPlannedApp: () => undefined, onConfirmedApp: () => undefined,
      onRetiredApp: () => undefined, verifyNetwork: async () => undefined });
    const connection = await provisioner.connect({ kind: 'fly', app: 'swarm-worker-fixture',
      appId: 'appabc', org: 'personal', network, accountRef,
      machineId: 'machineabc', workspace: 'boot' });
    await assert.rejects(connection.close(), (error) => error.code === 'PROXY_CLEANUP_UNKNOWN');
  } finally {
    delete globalThis.__networkSdkFixture;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    f.close();
  }
});

test('goal-private Worker rejects an unrelated attempt bearer before any HTTP effect', async () => {
  const f = setup();
  let requests = 0;
  let stopped = 0;
  const server = http.createServer((_, response) => {
    requests++; response.writeHead(200); response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  globalThis.__networkSdkFixture = {
    async deployment(app) { return { metadata: { org: 'personal', network, workspace: 'boot' },
      journal: { app, appId: 'appabc', owner, org: 'personal', network, workspace: 'boot',
        machineId: 'machineabc', ownershipConfirmed: true, state: 'ready' } }; },
    async openOwnedProxy() { return { origin: `http://127.0.0.1:${port}`,
      check: () => undefined, stop: async () => { stopped++; return { childClosed: true }; } }; },
    async readPrivateJson() { return { format: 'flujo-worker-credential', version: 1,
      id: 'swarm-worker-fixture', attemptId: 'different-attempt', token: bearer }; },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      org: 'personal', network, accountRef, initialWorkers: 0,
      verifyFreshApp: async () => undefined, onPlannedApp: () => undefined, onConfirmedApp: () => undefined,
      onRetiredApp: () => undefined, verifyNetwork: async () => undefined });
    await assert.rejects(provisioner.connect({ kind: 'fly', app: 'swarm-worker-fixture',
      appId: 'appabc', org: 'personal', network, accountRef, machineId: 'machineabc',
      workspace: 'boot', token: 'caller-supplied-token-0123456789abc' }), /credential does not match/);
    assert.equal(stopped, 1);
    assert.equal(requests, 0);
    globalThis.__networkSdkFixture.readPrivateJson = async () => ({
      format: 'flujo-worker-credential', version: 1,
      id: 'swarm-worker-fixture', attemptId, token: 'short',
    });
    await assert.rejects(provisioner.connect({ kind: 'fly', app: 'swarm-worker-fixture',
      appId: 'appabc', org: 'personal', network, accountRef, machineId: 'machineabc',
      workspace: 'boot', token: 'caller-supplied-token-0123456789abc' }), /credential is malformed/);
    assert.equal(stopped, 2);
    assert.equal(requests, 0);
  } finally {
    delete globalThis.__networkSdkFixture;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    f.close();
  }
});
