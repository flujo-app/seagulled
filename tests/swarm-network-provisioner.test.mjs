import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flyProvisioner } from '../upstream/swarm-teams/fleet/provisioners.mjs';

const network = 'seagulled-g-0123456789abcdef0123456789abcdef';
const accountRef = `fly-account-sha256:${'a'.repeat(64)}`;
const owner = '11111111-2222-4333-8444-555555555555';
const setup = (version = 1) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'swarm-network-sdk-'));
  mkdirSync(path.join(root, 'lib'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(root, 'lib', 'managed.mjs'), `export class ManagedCloud {
    static privateNetworkContractVersion = ${JSON.stringify(version)};
    constructor(options) { this.env = options.env; }
    async up(options) { return globalThis.__networkSdkFixture.up(options); }
    async deployment(app) { return globalThis.__networkSdkFixture.deployment(app); }
    async down(app) { return globalThis.__networkSdkFixture.down(app); }
  }`);
  writeFileSync(path.join(root, 'lib', 'process.mjs'), `export const createFlyRunner = () => ({
    proxy: async () => { throw new Error('No fixture proxy is permitted.'); }
  }); export const unusedLoopbackPort = async () => 48126;`);
  writeFileSync(path.join(root, 'lib', 'private-files.mjs'),
    'export const readPrivateJson = async () => { throw new Error("No fixture credential read."); };');
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
      calls.push('up');
      return { worker: options.app, org: options.org, machineId: 'machineabc', state: 'ready' };
    },
    async deployment(app) { return { metadata: { org: 'personal', network },
      journal: { app, appId: 'appabc', owner, org: 'personal', network,
        ownershipConfirmed: true, state: 'ready' } }; },
    async down() { calls.push('down'); return { state: 'destroyed' }; },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      source: 'http://127.0.0.1:4200', org: 'personal', network, accountRef,
      captureSpacingMs: 1, concurrency: 1,
      onPlannedApp: ({ app, kind, network: bound }) => {
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

test('unpatched SDK refuses product network before any Worker app plan', async () => {
  const f = setup(null);
  let planned = false;
  try {
    await assert.rejects(flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      org: 'personal', network, accountRef, onPlannedApp: () => { planned = true; },
      onConfirmedApp: () => undefined, onRetiredApp: () => undefined,
      verifyNetwork: async () => undefined }), /pinned cloud SDK/);
    assert.equal(planned, false);
  } finally { f.close(); }
});

test('both initial Workers must confirm group membership before either starts its run template', async () => {
  const f = setup();
  const plans = new Map();
  const order = [];
  globalThis.__networkSdkFixture = {
    async up(options) { order.push(`up:${options.app}`);
      return { worker: options.app, org: options.org, machineId: 'machineabc', state: 'ready' }; },
    async deployment(app) { return { metadata: { org: 'personal', network },
      journal: { app, appId: app, owner, org: 'personal', network,
        ownershipConfirmed: true, state: 'ready' } }; },
    async down() { return { state: 'destroyed' }; },
  };
  try {
    const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
      source: 'http://127.0.0.1:4200', org: 'personal', network, accountRef,
      initialWorkers: 2, concurrency: 2, captureSpacingMs: 1,
      onPlannedApp: ({ app }) => { plans.set(app, 'planned'); order.push(`plan:${app}`); },
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
        return { worker: options.app, org: options.org, machineId: 'machineabc', state: 'ready' };
      },
      async deployment(app) { return { metadata: { org: 'personal', network },
        journal: { app, appId: 'exact-app-id', owner, org: 'personal', network,
          ownershipConfirmed: true, state: 'ready' } }; },
      async down(app) { calls.push(`down:${app}`); return { state: 'destroyed' }; },
    };
    try {
      const provisioner = await flyProvisioner({ flujoCloudPath: f.root, templateWorkspace: 'boot',
        source: 'http://127.0.0.1:4200', org: 'personal', network, accountRef,
        captureSpacingMs: 1, concurrency: 1,
        onPlannedApp: ({ app }) => { planned = app; calls.push(`plan:${app}`); },
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
      onPlannedApp: ({ app }) => { planned = app; },
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
