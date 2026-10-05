import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { conversationFailure, fleetStatus, fleetDiagnosticStatus, fleetExecutionLimits, goalCapacity,
  fleetTopology, flyAccountLease, isolatedFlyEnvironment, bindVerifiedFlyOrganization,
  recordConfirmedQuotaHold, runFleetLeaf, staffOwnedTeam,
  verifiedLocalConversations } from '../src/swarm/fleet.mjs';
import { createOwnedRelay } from '../src/swarm/relay.mjs';
import { buildSpecs } from '../upstream/swarm-teams/template/flows.mjs';
import { Controller } from '../upstream/swarm-teams/fleet/controller.mjs';
import { flyProvisioner } from '../upstream/swarm-teams/fleet/provisioners.mjs';
import { FlujoClient } from '../upstream/swarm-teams/lib/flujo-client.mjs';

const relayNetwork = 'seagulled-g-0123456789abcdef0123456789abcdef';
const accountRef = `fly-account-sha256:${'a'.repeat(64)}`;
const relayInventory = (journal, created, network = relayNetwork) => {
  const apps = created ? [{ id: 'fixture-app-id', name: journal.app, network }] : [];
  return new Response(JSON.stringify({ total_apps: apps.length, apps }), { status: 200 });
};

test('goal capacity maps selected worker and agent counts to bounded Fly execution limits', async () => {
  assert.deepEqual(goalCapacity({}), { maxWorkers: 5, conversationsPerWorker: 5, agentsPerWorker: 4 });
  assert.deepEqual(fleetExecutionLimits({ goal: { maxWorkers: 6, conversationsPerWorker: 5 }, config: { maxWorkers: 2 } }), {
    workerCap: 6, teamLimits: { agentTurns: 6, leadTurns: 12, concurrency: 4 },
  });
  assert.deepEqual(goalCapacity({ agentsPerWorker: 10 }),
    { maxWorkers: 5, conversationsPerWorker: 11, agentsPerWorker: 10 }, 'legacy child limit is not silently reduced');
  assert.deepEqual(goalCapacity({ conversationsPerWorker: 11, agentsPerWorker: 10 }),
    { maxWorkers: 5, conversationsPerWorker: 11, agentsPerWorker: 10 }, 'migrated legacy goal remains valid');
  assert.equal(fleetExecutionLimits({ goal: { maxWorkers: 6, conversationsPerWorker: 5 }, native: true }).workerCap, 1);
  assert.equal(fleetExecutionLimits({ goal: {}, config: { maxWorkers: 4 }, diagnostic: true }).workerCap, 4);
  for (const setting of [{ maxWorkers: 0 }, { maxWorkers: 7 }, { maxWorkers: 2.5 },
    { conversationsPerWorker: 0 }, { conversationsPerWorker: 11 },
    { agentsPerWorker: 11 }, { agentsPerWorker: '4' }]) {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-invalid-capacity-'));
    assert.throws(() => goalCapacity(setting), /must be an integer/);
    await assert.rejects(runFleetLeaf({ goal: { id: 'invalid-capacity', providerId: 'openai', ...setting },
      task: 'fixture', dataDir, maxUsd: 2 }), /must be an integer/);
    assert.equal(existsSync(path.join(dataDir, 'fleet')), false);
  }
  assert.throws(() => goalCapacity({ conversationsPerWorker: 5, agentsPerWorker: 5 }), /disagree/);
  assert.deepEqual(fleetTopology({ workerTopologyVersion: 2 }, { workerCap: 5, relay: true }), {
    initialWorkers: 5, limits: { maxWorkers: 10, maxDepth: 3, maxChildren: 4, maxActiveRuns: 2 },
  });
  assert.deepEqual(fleetTopology({}, { workerCap: 5, relay: true }), {
    initialWorkers: 1, limits: { maxWorkers: 5, maxDepth: 2, maxChildren: 4, maxActiveRuns: 2 },
  }, 'already admitted goals retain the original one-starter, five-cap topology');
  assert.throws(() => goalCapacity({ workerTopologyVersion: 3 }), /must be 1 or 2/);
});

test('Fly account lease selects one verified personal config and drops inherited service credentials', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-fly-account-'));
  const flyctlPath = path.join(root, process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
  const flyConfigDir = path.join(root, 'personal-fly');
  mkdirSync(flyConfigDir);
  writeFileSync(flyctlPath, 'fixture executable');
  writeFileSync(path.join(flyConfigDir, 'config.yml'), 'fixture personal config');
  const providers = { async flyFleetLease() { return { available: true, flyctlPath, flyConfigDir,
    orgSlug: 'personal-test', scope: 'private', accountRef,
    token: 'provider-internal-token-must-not-cross-the-lease' }; } };
  const lease = await flyAccountLease(providers);
  assert.deepEqual(lease, { flyctlPath, flyConfigDir, orgSlug: 'personal-test', scope: 'private', accountRef });
  const env = isolatedFlyEnvironment(lease, { PATH: 'fixture-path', FLY_API_TOKEN: 'inherited-service-token',
    FLY_ACCESS_TOKEN: 'inherited-access-token', FLY_CONFIG_DIR: 'foreign-config',
    FLYCTL_PATH: 'foreign-helper', FLUJO_CLOUD_HOME: 'foreign-cloud-records',
    FLUJO_SNAPSHOT_CONTROL_TOKEN: 'foreign-source-token', FLUJO_LOCAL_INSTANCE_DIR: 'fixture-local-instances' });
  assert.deepEqual(env, { PATH: 'fixture-path', FLY_CONFIG_DIR: flyConfigDir, FLYCTL_PATH: flyctlPath });
  assert.equal(isolatedFlyEnvironment(lease, { FLUJO_LOCAL_INSTANCE_DIR: 'foreign' }, flyConfigDir)
    .FLUJO_LOCAL_INSTANCE_DIR, flyConfigDir, 'only the explicit product source directory crosses to the SDK');
  assert.equal(await flyAccountLease({ async flyFleetLease() { return { available: true, flyctlPath, orgSlug: 'personal-test',
    flyConfigDir: path.join(root, 'missing') }; } }), null);
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-fly-no-account-'));
  assert.deepEqual(await runFleetLeaf({ goal: { id: 'no-account', providerId: 'openai' }, dataDir }),
    { available: false, detail: 'A verified personal Fly sign-in, an unused personal organization, and the bundled Fly helper are required for isolated Workers.' });
  assert.equal(existsSync(path.join(dataDir, 'fleet')), false);
});

test('a legacy profile cannot supply the product source or redirect its verified Fly organization', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-org-boundary-'));
  const flyConfigDir = path.join(root, 'fly-auth');
  mkdirSync(flyConfigDir);
  writeFileSync(path.join(flyConfigDir, 'config.yml'), 'fixture');
  const flyctlPath = path.join(root, 'flyctl');
  writeFileSync(flyctlPath, 'fixture');
  const flyAccount = { flyctlPath, flyConfigDir, orgSlug: 'personal-test', scope: 'private', accountRef };
  const legacy = { provisioner: { kind: 'fly', org: 'production-org', region: 'iad' } };
  const bound = bindVerifiedFlyOrganization(legacy, flyAccount);
  assert.equal(bound.provisioner.org, 'personal-test');
  assert.equal(bound.provisioner.region, 'iad');
  assert.equal(legacy.provisioner.org, 'production-org');
  assert.throws(() => bindVerifiedFlyOrganization(legacy, { ...flyAccount, orgSlug: undefined }),
    /verified personal Fly sign-in/);
  const profile = path.join(root, 'legacy-profile.json');
  writeFileSync(profile, JSON.stringify({ supervisor: { origin: 'http://127.0.0.1:1' },
    provisioner: { kind: 'fly', flujoCloudPath: root, org: 'production-org' } }));
  const previous = process.env.SEAGULLED_FLEET_PROFILE;
  process.env.SEAGULLED_FLEET_PROFILE = profile;
  const fleetRoute = { available: true, providerId: 'openai', model: {
    name: 'fixture', baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture',
    provider: 'openai', adapter: 'openai-responses' } };
  try {
    const result = await runFleetLeaf({ goal: { id: 'org-boundary', providerId: 'openai' },
      dataDir: root, fleetRoute, flyAccount });
    assert.equal(result.available, false);
    assert.match(result.detail, /product-owned FLUJO source/);
    assert.equal(existsSync(path.join(root, 'fleet')), false);
  } finally {
    if (previous === undefined) delete process.env.SEAGULLED_FLEET_PROFILE;
    else process.env.SEAGULLED_FLEET_PROFILE = previous;
  }
});

test('a real loopback model catalog must contain the exact model ID before readiness', async () => {
  let catalog = '{}';
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://local').pathname;
    if (pathname === '/api/workspaces') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ workspaces: [] }));
    } else if (pathname === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(catalog);
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-catalog-shape-'));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify({ supervisor: { origin },
    provisioner: { kind: 'fly', flujoCloudPath: root },
    model: { name: 'exact-model', baseUrl: `${origin}/v1`, apiKey: 'fixture',
      provider: 'openai', adapter: 'openai' } }));
  const previous = process.env.SEAGULLED_FLEET_PROFILE;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.SEAGULLED_FLEET_PROFILE = profile;
  delete process.env.OPENAI_API_KEY;
  try {
    for (catalog of ['null', '{}', '{"data":null}', '{"data":[]}',
      '{"data":[{"name":"exact-model"}]}', '<html>not a catalog</html>']) {
      const status = await fleetDiagnosticStatus({ dataDir: root });
      assert.equal(status.available, false, `catalog ${catalog} cannot qualify model identity`);
      assert.equal(status.modelIdentityVerified, undefined);
    }
    catalog = '{"data":[{"id":"another-model"},{"id":"exact-model"}]}';
    const ready = await fleetDiagnosticStatus({ dataDir: root });
    assert.equal(ready.available, true);
    assert.equal(ready.modelIdentityVerified, true);
  } finally {
    if (previous === undefined) delete process.env.SEAGULLED_FLEET_PROFILE;
    else process.env.SEAGULLED_FLEET_PROFILE = previous;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('product fleet requires one bound private source and checks the SDK proof before any workspace call', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-bound-source-'));
  const dataDir = path.join(root, 'swarm');
  const sourceInstanceDir = path.join(root, 'instances');
  const sourceDataRoot = path.join(root, 'flujo-data');
  const sourceAppRoot = path.join(root, 'flujo-package');
  const cloudSdkRoot = path.join(root, 'cloud-sdk');
  const flyConfigDir = path.join(root, 'fly-auth');
  for (const directory of [dataDir, sourceInstanceDir, sourceDataRoot, sourceAppRoot,
    path.join(root, 'wrong-data'), path.join(root, 'wrong-app'),
    path.join(cloudSdkRoot, 'lib'), flyConfigDir]) mkdirSync(directory, { recursive: true });
  const snapshottedInstances = path.join(sourceDataRoot, 'workspaces', 'instances');
  mkdirSync(snapshottedInstances, { recursive: true });
  writeFileSync(path.join(cloudSdkRoot, 'lib', 'managed.mjs'), `export class ManagedCloud {
    constructor(options) { globalThis.__seagulledSourceFixture.options = options; this.fetch = options.fetchImpl; }
    async source(input) { globalThis.__seagulledSourceFixture.input = input;
      if (globalThis.__seagulledSourceFixture.sourceImpl) return globalThis.__seagulledSourceFixture.sourceImpl(this);
      return globalThis.__seagulledSourceFixture.proof; }
  }`);
  const flyctlPath = path.join(root, 'flyctl');
  writeFileSync(flyctlPath, 'fixture');
  writeFileSync(path.join(flyConfigDir, 'config.yml'), 'fixture');
  const flyAccount = { flyctlPath, flyConfigDir, orgSlug: 'personal-test', scope: 'private', accountRef };
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(new URL(request.url, 'http://local').pathname);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ workspaces: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sourceOrigin = `http://127.0.0.1:${server.address().port}`;
  const sourceBinding = { cloudSdkRoot, sourceOrigin, sourceInstanceDir, sourceDataRoot, sourceAppRoot };
  const fleetRoute = { available: true, providerId: 'openai', model: {
    name: 'fixture-model', baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-key',
    provider: 'openai', adapter: 'openai-responses' } };
  const previousProfile = process.env.SEAGULLED_FLEET_PROFILE;
  const previousInstances = process.env.FLUJO_LOCAL_INSTANCE_DIR;
  const previousFetch = globalThis.fetch;
  process.env.SEAGULLED_FLEET_PROFILE = path.join(root, 'missing-legacy-profile.json');
  process.env.FLUJO_LOCAL_INSTANCE_DIR = path.join(root, 'foreign-host-instances');
  let modelFetches = 0;
  globalThis.fetch = async () => { modelFetches++;
    return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { status: 200 }); };
  globalThis.__seagulledSourceFixture = { proof: { source: sourceOrigin, dataRoot: sourceDataRoot,
    appRoot: sourceAppRoot } };
  try {
    const status = (binding) => fleetStatus({ dataDir, providerId: 'openai', fleetRoute,
      flyAccount, sourceBinding: binding });
    assert.match((await status(undefined)).detail, /product-owned FLUJO source/);
    assert.match((await status({ ...sourceBinding, sourceInstanceDir: path.join(root, '..', 'host-instances') })).detail,
      /product-owned FLUJO source/);
    assert.match((await status({ ...sourceBinding, sourceInstanceDir: snapshottedInstances })).detail,
      /product-owned FLUJO source/);
    assert.deepEqual(requests, []);
    assert.equal(modelFetches, 0);
    globalThis.__seagulledSourceFixture.proof = { source: sourceOrigin,
      dataRoot: path.join(root, 'wrong-data'), appRoot: sourceAppRoot };
    assert.match((await status(sourceBinding)).detail, /identity did not match/);
    const rejected = await runFleetLeaf({ goal: { id: 'proof-mismatch', providerId: 'openai' },
      task: 'fixture', dataDir, maxUsd: 2, fleetRoute, flyAccount, sourceBinding });
    assert.equal(rejected.available, false);
    assert.match(rejected.detail, /identity did not match/);
    for (const proof of [
      { source: 'http://127.0.0.1:1', dataRoot: sourceDataRoot, appRoot: sourceAppRoot },
      { source: sourceOrigin, dataRoot: sourceDataRoot, appRoot: path.join(root, 'wrong-app') },
    ]) {
      globalThis.__seagulledSourceFixture.proof = proof;
      assert.match((await status(sourceBinding)).detail, /identity did not match/);
    }
    assert.deepEqual(requests, [], 'a mismatched proof cannot reach the workspace API');
    globalThis.__seagulledSourceFixture.proof = { source: sourceOrigin, dataRoot: sourceDataRoot,
      appRoot: sourceAppRoot };
    const ready = await status(sourceBinding);
    assert.equal(ready.available, true);
    assert.equal(ready.modelIdentityVerified, true, 'the exact model catalog was checked');
    assert.equal('config' in ready, false);
    assert.equal(JSON.stringify(ready).includes(root), false, 'private paths remain backend-only');
    assert.deepEqual(globalThis.__seagulledSourceFixture.input, { source: sourceOrigin });
    assert.equal(globalThis.__seagulledSourceFixture.options.env.FLUJO_LOCAL_INSTANCE_DIR, sourceInstanceDir);
    assert.deepEqual(requests, ['/api/workspaces']);
    assert.equal(modelFetches, 1);
    assert.equal(existsSync(path.join(dataDir, 'fleet')), false, 'discovery does not create an intent');
    const cancellation = new AbortController();
    let discoveryStarted;
    const started = new Promise((resolve) => { discoveryStarted = resolve; });
    globalThis.fetch = (_, options) => new Promise((resolve, reject) => {
      discoveryStarted();
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    globalThis.__seagulledSourceFixture.sourceImpl = (managed) => managed.fetch(sourceOrigin, {
      signal: AbortSignal.timeout(10_000) });
    const cancelled = runFleetLeaf({ goal: { id: 'cancel-discovery', providerId: 'openai' },
      task: 'fixture', dataDir, maxUsd: 2, fleetRoute, flyAccount, sourceBinding,
      signal: cancellation.signal });
    await started;
    const stoppedAt = Date.now();
    cancellation.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.ok(Date.now() - stoppedAt < 2000, 'Stop does not wait for the SDK proof timeout');
    assert.equal(existsSync(path.join(dataDir, 'fleet')), false, 'Stop before source proof creates no intent');
  } finally {
    if (previousProfile === undefined) delete process.env.SEAGULLED_FLEET_PROFILE;
    else process.env.SEAGULLED_FLEET_PROFILE = previousProfile;
    if (previousInstances === undefined) delete process.env.FLUJO_LOCAL_INSTANCE_DIR;
    else process.env.FLUJO_LOCAL_INSTANCE_DIR = previousInstances;
    globalThis.fetch = previousFetch;
    delete globalThis.__seagulledSourceFixture;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Fly provisioner gives ManagedCloud only the selected account and owned record directory', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-managed-lease-'));
  const lib = path.join(root, 'lib'); mkdirSync(lib);
  writeFileSync(path.join(lib, 'managed.mjs'), 'export class ManagedCloud { constructor(options) { globalThis.__seagulledManagedLeaseFixture = options; } }');
  writeFileSync(path.join(lib, 'process.mjs'), 'export const createFlyRunner = () => ({}); export const unusedLoopbackPort = async () => 1;');
  writeFileSync(path.join(lib, 'private-files.mjs'), 'export const readPrivateJson = async () => ({});');
  const cloudDirectory = path.join(root, 'private-product-records');
  const flyEnv = { FLYCTL_PATH: path.join(root, 'bundled-flyctl'), FLY_CONFIG_DIR: path.join(root, 'personal-config') };
  try {
    await flyProvisioner({ flujoCloudPath: root, templateWorkspace: 'fixture', flyEnv, cloudDirectory });
    assert.deepEqual(globalThis.__seagulledManagedLeaseFixture, { env: flyEnv, directory: cloudDirectory });
    const relayJournal = path.join(root, 'relay.json');
    await assert.rejects(createOwnedRelay({ journalPath: relayJournal, flujoCloudPath: root,
      org: 'personal', network: relayNetwork }), /isolated personal Fly account/);
    assert.equal(existsSync(relayJournal), false);
  } finally { delete globalThis.__seagulledManagedLeaseFixture; }
});

test('default staffing admits five actual Worker runs beneath one external supervisor', async () => {
  const registryPath = path.join(mkdtempSync(path.join(tmpdir(), 'seagulled-staff-')), 'registry.json');
  const provisioned = [];
  const controller = new Controller({ registryPath, operatorToken: 'fixture-operator-token-more-than-32-characters',
    publicUrl: 'http://127.0.0.1:1', remoteUrl: 'http://relay.fixture', maxRunsPerWorker: 1,
    provisioner: { async provision(worker, _fleet, context) {
      provisioned.push({ workerId: worker.id, limits: context.teamLimits });
      return { kind: 'fixture', workerId: worker.id };
    }, async connect() { return { client: { async runFlow({ conversationId }) {
      assert.equal(Object.values(controller.registry.state.workers).length, 6,
        'no Worker conversation starts until all five Machine slots are reserved');
      return { conversationId, status: 'completed', output: 'fixture result' };
    } }, close: async () => undefined }; } },
  });
  try {
    const goal = controller.registry.createGoal({ id: 'staff-fixture', text: 'Fixture work',
      limits: { maxWorkers: 5, maxDepth: 2, maxChildren: 4, maxActiveRuns: 2 } });
    goal.teamLimits = fleetExecutionLimits({ goal: {} }).teamLimits;
    controller.registry.save();
    const root = controller.registry.reserve({ goalId: goal.id, role: 'supervisor', name: 'Todd' }).worker;
    controller.registry.enroll(root.id, { kind: 'external', origin: 'http://127.0.0.1:1', workspace: 'fixture' });
    const { lead, runs } = staffOwnedTeam(controller, root, { task: 'Fixture work', workerCap: 5,
      localChildTarget: 4 });
    assert.equal(runs.length, 5);
    assert.equal(new Set(runs.map((run) => run.runId)).size, 5);
    assert.equal(controller.registry.worker(lead.workerId).parentId, root.id);
    assert.deepEqual(runs.slice(1).map((run) => controller.registry.worker(run.workerId).parentId),
      Array(4).fill(lead.workerId));
    assert.equal(Object.values(controller.registry.state.workers).length, 6, 'external Todd is outside the five Machine cap');
    assert.match(controller.registry.run(lead.runId).task, /start_subflow_ tool exactly 4 times/);
    assert.throws(() => staffOwnedTeam(controller, root, { task: 'Duplicate', workerCap: 5 }), /all 5 Workers/);
    await Promise.all([...controller.settled.values()]);
    assert.equal(Object.values(controller.registry.state.runs).filter((run) => run.state === 'completed').length, 5);
    assert.equal(provisioned.length, 5);
    assert.ok(provisioned.every((item) => item.limits.concurrency === 4));
    assert.throws(() => controller.startRun({ worker: controller.registry.worker(lead.workerId),
      startedBy: root.id, task: 'A second lead conversation' }), /conversation run limit/);
  } finally { await controller.close(); }
});

test('local conversation receipt accepts only the exact observed child tree', () => {
  const parent = 'lead-id';
  const items = Array.from({ length: 4 }, (_, index) => ({ id: `child-${index}`, parentConversationId: parent,
    status: 'completed' }));
  assert.deepEqual(verifiedLocalConversations({ status: 200, body: { items, total: 4, hasMore: false } }, parent, 4),
    items.map(({ id, status }) => ({ id, status })));
  assert.throws(() => verifiedLocalConversations({ status: 200, body: { items: items.slice(0, 3), total: 3,
    hasMore: false } }, parent, 4), /exactly 4/);
  assert.throws(() => verifiedLocalConversations({ status: 200, body: { items: [...items, {
    id: 'extra', parentConversationId: parent }], total: 5, hasMore: false } }, parent, 4), /exactly 4/);
  assert.throws(() => verifiedLocalConversations({ status: 200, body: { items, total: 4, hasMore: true } },
    parent, 4), /did not confirm/);
});

test('fleet deadline blocks a late Worker before any model submission', async () => {
  const registryPath = path.join(mkdtempSync(path.join(tmpdir(), 'seagulled-deadline-')), 'registry.json');
  let modelCalls = 0;
  let releaseProvisioning;
  const provisioningGate = new Promise((resolve) => { releaseProvisioning = resolve; });
  const controller = new Controller({ registryPath, operatorToken: 'fixture-operator-token-more-than-32-characters',
    publicUrl: 'http://127.0.0.1:1', deadlineAt: Number.MAX_SAFE_INTEGER,
    provisioner: { async provision(worker) {
      await provisioningGate;
      return { kind: 'fixture', workerId: worker.id };
    }, async connect() { return { client: { async runFlow() { modelCalls++; return { status: 'completed', output: 'late' }; } },
      close: async () => undefined }; } } });
  try {
    const goal = controller.registry.createGoal({ id: 'deadline-fixture', text: 'Fixture', limits: { maxWorkers: 2 } });
    const root = controller.registry.reserve({ goalId: goal.id, role: 'supervisor' }).worker;
    controller.registry.enroll(root.id, { kind: 'external', origin: 'http://127.0.0.1:1', workspace: 'fixture' });
    const run = controller.delegate(root, { name: 'late-worker', task: 'Fixture' });
    controller.deadlineAt = Date.now() - 1;
    releaseProvisioning();
    await controller.settled.get(run.runId);
    assert.equal(controller.registry.run(run.runId).state, 'failed');
    assert.equal(modelCalls, 0);
    assert.throws(() => controller.delegate(root, { name: 'too-late', task: 'Fixture' }), /deadline has passed/);
  } finally { releaseProvisioning(); await controller.close(); }
});

test('product Fly admission requires the exact selected provider binding before any probe or intent', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-route-bound-'));
  const valid = { available: true, providerId: 'openai',
    model: { name: 'fixture-model', baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-key',
      provider: 'openai', adapter: 'openai-responses' }, verification: 'unverified' };
  for (const route of [undefined, { ...valid, providerId: 'anthropic' },
    { ...valid, model: { ...valid.model, provider: 'anthropic' } },
    { ...valid, model: { ...valid.model, adapter: 'anthropic' } },
    { ...valid, model: { ...valid.model, baseUrl: 'https://alternate.example/v1' } }]) {
    const status = await fleetStatus({ dataDir, providerId: 'openai', fleetRoute: route });
    assert.equal(status.available, false);
    const result = await runFleetLeaf({ goal: { id: 'route-bound', providerId: 'openai' },
      task: 'fixture', dataDir, maxUsd: 2, fleetRoute: route });
    assert.equal(result.available, false);
    assert.equal(existsSync(path.join(dataDir, 'fleet')), false);
  }
});

test('private H100 Fly route accepts only the verified owned endpoint identity before any probe', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-private-route-'));
  const previousProfile = process.env.SEAGULLED_FLEET_PROFILE;
  process.env.SEAGULLED_FLEET_PROFILE = path.join(dataDir, 'missing-profile.json');
  const valid = { available: true, providerId: 'private-h100', verification: 'inference-verified',
    costPolicy: 'estimated-gpu-seconds', ownedAttemptId: '11111111-2222-3333-4444-555555555555',
    leaseGoalId: 'owned-goal',
    model: { name: 'qwen3.8-27b', provider: 'openai', adapter: 'openai',
      baseUrl: 'https://owner-seagulled-qwen-a1b2c3d4e5f6.modal.run/v1', apiKey: 'owned-fixture-token' } };
  try {
    const catalogOnly = await fleetStatus({ dataDir, providerId: 'private-h100',
      fleetRoute: { ...valid, verification: 'previously-verified' }, goalId: 'owned-goal' });
    assert.match(catalogOnly.detail, /no usable Fly model binding/);
    const accepted = await fleetStatus({ dataDir, providerId: 'private-h100', fleetRoute: valid, goalId: 'owned-goal' });
    assert.match(accepted.detail, /product-owned FLUJO source/, 'binding passes to owned source discovery without fetching a model');
    assert.equal((await fleetStatus({ dataDir, providerId: 'private-h100', fleetRoute: valid,
      goalId: 'different-goal' })).available, false, 'another goal cannot borrow the route');
    for (const route of [
    { ...valid, providerId: 'openai' },
    { ...valid, verification: 'unverified' },
    { ...valid, ownedAttemptId: 'missing' },
    { ...valid, model: { ...valid.model, name: 'other-model' } },
    { ...valid, model: { ...valid.model, baseUrl: 'https://original-project.modal.run/v1' } },
    { ...valid, model: { ...valid.model, baseUrl: 'http://owner-seagulled-qwen-a1b2c3d4e5f6.modal.run/v1' } },
    ]) {
      const status = await fleetStatus({ dataDir, providerId: 'private-h100', fleetRoute: route, goalId: 'owned-goal' });
      assert.equal(status.available, false);
      assert.equal(existsSync(path.join(dataDir, 'fleet')), false);
    }
  } finally {
    if (previousProfile === undefined) delete process.env.SEAGULLED_FLEET_PROFILE;
    else process.env.SEAGULLED_FLEET_PROFILE = previousProfile;
  }
});

test('a saved no-credits account hold survives a model-name change without probing', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-account-hold-'));
  const fleetDir = path.join(dataDir, 'fleet'); mkdirSync(fleetDir);
  const oldModel = { name: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', apiKey: 'same-fixture-key' };
  const fingerprint = createHash('sha256').update(`${oldModel.baseUrl}\0${oldModel.name}\0${oldModel.apiKey}`).digest('hex').slice(0, 24);
  writeFileSync(path.join(fleetDir, `model-admission-${fingerprint}.json`),
    JSON.stringify({ state: 'held', provider: 'openai-api', reason: 'no credits remaining' }));
  const route = { available: true, providerId: 'openai',
    model: { ...oldModel, name: 'another-model', provider: 'openai', adapter: 'openai-responses' } };
  const status = await fleetStatus({ dataDir, providerId: 'openai', fleetRoute: route });
  assert.equal(status.available, false);
  assert.match(status.detail, /no-credits hold/);
  assert.equal(existsSync(path.join(dataDir, 'fleet', 'route-bound')), false);
});

test('confirmed original quota denial holds the account across new goals and model names', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-confirmed-quota-'));
  const model = { name: 'first-model', baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-secret-key',
    provider: 'openai', adapter: 'openai-responses' };
  const read = { status: 200, body: { status: 'error', lastError: {
    httpStatus: 429, code: 'insufficient_quota', message: 'sensitive provider body must not be stored' } } };
  assert.equal(recordConfirmedQuotaHold({ dataDir, model, providerId: 'openai',
    goalId: 'first-goal', runId: 'original-run', read }), true);
  const accountPath = path.join(dataDir, 'fleet', `account-admission-${createHash('sha256')
    .update(`${model.baseUrl}\0${model.apiKey}`).digest('hex').slice(0, 24)}.json`);
  const saved = readFileSync(accountPath, 'utf8');
  assert.equal(JSON.parse(saved).runId, 'original-run');
  assert.equal(saved.includes(model.apiKey), false);
  assert.equal(saved.includes(read.body.lastError.message), false);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('account hold must precede fetch'); };
  try {
    for (const [goalId, name] of [['new-goal-one', 'other-model'], ['new-goal-two', 'third-model']]) {
      const fleetRoute = { available: true, providerId: 'openai', model: { ...model, name } };
      const status = await fleetStatus({ dataDir, providerId: 'openai', fleetRoute });
      assert.equal(status.available, false);
      assert.match(status.detail, /no-credits hold/);
      const result = await runFleetLeaf({ goal: { id: goalId, providerId: 'openai' },
        task: 'fixture', dataDir, maxUsd: 2, fleetRoute });
      assert.equal(result.available, false);
      assert.equal(existsSync(path.join(dataDir, 'fleet', goalId)), false);
    }
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('an ambiguous rate-limit response does not become a no-credits account hold', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-rate-limit-'));
  const model = { name: 'fixture', baseUrl: 'https://api.openai.com/v1', apiKey: 'different-key',
    provider: 'openai', adapter: 'openai-responses' };
  for (const read of [
    { status: 200, body: { status: 'error', lastError: { httpStatus: 429, code: 'rate_limit_exceeded' } } },
    { status: 200, body: { status: 'running', lastError: { httpStatus: 429, code: 'insufficient_quota' } } },
    { status: 503, body: { status: 'error', lastError: { httpStatus: 429, code: 'insufficient_quota' } } },
  ]) assert.equal(recordConfirmedQuotaHold({ dataDir, model, providerId: 'openai',
    goalId: 'original-goal', runId: 'original-run', read }), false);
  assert.equal(existsSync(path.join(dataDir, 'fleet')), false);
});

test('workspace cleanup requires stable exact-name absence beyond an HTTP 200 deletion response', async () => {
  const client = new FlujoClient({ origin: 'http://127.0.0.1:1', workspace: 'owned-boot' });
  client.servers = async () => [];
  client.api = async () => ({ status: 200, body: { deleted: true } });
  let reads = 0;
  client.workspaces = async () => ++reads === 1 ? [] : ['owned-boot'];
  await assert.rejects(client.deleteWorkspace('owned-boot', { verificationDelayMs: 0 }), /Could not confirm deletion/);
  reads = 0;client.workspaces = async () => { reads++;return []; };
  assert.deepEqual(await client.deleteWorkspace('owned-boot', { verificationDelayMs: 0 }), { deleted: true });
  assert.equal(reads,2);
});

test('Seagulled can install a bounded Fly team without changing upstream defaults', () => {
  const [agent, team] = buildSpecs({ model: 'fictional', availableServers: [], limits: { agentTurns: 6, leadTurns: 12, concurrency: 1 } });
  const [agentDefault, teamDefault] = buildSpecs({ model: 'fictional', availableServers: [] });
  assert.equal(team.nodes.find((node) => node.key === 'lead').maxTurns, 12);
  assert.equal(agent.nodes.find((node) => node.key === 'agent').maxTurns, 6);
  assert.equal(team.nodes.find((node) => node.key === 'agents').concurrencyLimit, 1);
  assert.equal(agentDefault.nodes.find((node) => node.key === 'agent').maxTurns, 200);
  assert.equal(teamDefault.nodes.find((node) => node.key === 'agents').concurrencyLimit, 10);
});

test('disabled model preflight makes no boot workspace or Fly intent', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url.startsWith('/api/workspaces')) {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"workspaces":[]}');
    } else {
      response.writeHead(404); response.end('{"error":"workspace disabled"}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-fleet-preflight-'));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify({ supervisor: { origin }, provisioner: { kind: 'fly', flujoCloudPath: root },
    model: { name: 'fictional', baseUrl: `${origin}/v1`, apiKey: 'fictional' } }));
  const previous = process.env.SEAGULLED_FLEET_PROFILE;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.SEAGULLED_FLEET_PROFILE = profile;
  delete process.env.OPENAI_API_KEY;
  try {
    const status = await fleetDiagnosticStatus();
    assert.equal(status.available, false);
    assert.match(status.detail, /HTTP 404/);
    assert.equal('config' in status, false, 'private profile never enters public state');
    const result = await runFleetLeaf({ goal: { id: 'fictional-goal', text: 'fictional' }, task: 'fictional',
      dataDir: root, maxUsd: 2, diagnostic: true });
    assert.equal(result.available, false);
    assert.equal(existsSync(path.join(root, 'fleet', 'fictional-goal')), false);
    assert.deepEqual(requests, ['/api/workspaces', '/v1/models', '/api/workspaces', '/v1/models']);
    const fingerprint = createHash('sha256').update(origin).digest('hex').slice(0, 24);
    const holds = path.join(root, 'fleet'); mkdirSync(holds);
    writeFileSync(path.join(holds, `source-admission-${fingerprint}.json`), JSON.stringify({ state: 'held' }));
    const held = await fleetDiagnosticStatus({ dataDir: root });
    assert.equal(held.available, false);
    assert.match(held.detail, /held after a confirmed failure/);
    assert.equal((await runFleetLeaf({ goal: { id: 'another-goal', text: 'fictional' }, task: 'fictional',
      dataDir: root, maxUsd: 2, diagnostic: true })).available, false);
    assert.equal(requests.length, 4, 'a held source is not re-probed or mutated');
    const accountData = path.join(root, 'held-account');
    const accountFleet = path.join(accountData, 'fleet'); mkdirSync(accountFleet, { recursive: true });
    process.env.OPENAI_API_KEY = 'fixture-key';
    const accountFingerprint = createHash('sha256').update('https://api.openai.com/v1\0gpt-4.1-mini\0fixture-key').digest('hex').slice(0, 24);
    writeFileSync(path.join(accountFleet, `model-admission-${accountFingerprint}.json`), JSON.stringify({ state: 'held' }));
    const creditHeld = await fleetDiagnosticStatus({ dataDir: accountData });
    assert.equal(creditHeld.available, false);
    assert.match(creditHeld.detail, /no credits/);
    assert.deepEqual(requests.slice(4), ['/api/workspaces', '/v1/models'], 'credit hold avoids another API catalog request');
  } finally {
    if (previous === undefined) delete process.env.SEAGULLED_FLEET_PROFILE;
    else process.env.SEAGULLED_FLEET_PROFILE = previous;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('keyless Codex boot refusal stops before Fly provisioning and deletes its own workspace', async () => {
  const requests = [];
  let model;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    requests.push(`${request.method} ${new URL(request.url, 'http://local').pathname}`);
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    const pathname = new URL(request.url, 'http://local').pathname;
    if (pathname === '/api/workspaces' && request.method === 'GET') return send(200, { workspaces: [] });
    if (pathname === '/api/workspaces' && request.method === 'POST') return send(201, { name: body.name });
    if (pathname === '/api/workspaces' && request.method === 'DELETE') return send(200, {});
    if (pathname === '/api/init') return send(200, {});
    if (pathname === '/api/model' && request.method === 'GET') return send(200, []);
    if (pathname === '/api/model' && request.method === 'POST') { model = body; return send(201, body); }
    if (pathname === '/api/flow' && request.method === 'GET') return send(200, []);
    if (pathname === '/api/flow/compile') return send(201, { flow: { id: 'boot-flow', name: 'swarm_boot' } });
    if (pathname === '/api/mcp/servers') return send(200, []);
    if (pathname === '/v1/chat/completions') return send(401, { error: 'fixture refusal' });
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-codex-preflight-'));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify({ supervisor: { origin }, provisioner: { kind: 'fly', flujoCloudPath: root },
    model: { name: 'gpt-6-luna', provider: 'codex', adapter: 'codex-cli', apiKey: '' } }));
  const previous = process.env.SEAGULLED_FLEET_PROFILE;
  process.env.SEAGULLED_FLEET_PROFILE = profile;
  try {
    const status = await fleetDiagnosticStatus({ dataDir: root });
    assert.equal(status.available, true);
    assert.equal(status.provider, 'codex-subscription-candidate');
    await assert.rejects(() => runFleetLeaf({ goal: { id: 'native-goal', text: 'fixture' }, task: 'fixture',
      dataDir: root, maxUsd: 1, diagnostic: true }), (error) => error.outcome === 'failed' && /No Fly worker/.test(error.message));
    assert.equal(model.provider, 'codex');
    assert.equal(model.adapter, 'codex-cli');
    assert.equal(model.ApiKey, '');
    assert.equal('temperature' in model, false, 'Codex model rows do not accept creativity');
    assert.ok(requests.includes('DELETE /api/workspaces'));
    assert.equal(requests.filter((entry) => entry === 'POST /v1/chat/completions').length, 1);
    assert.equal(requests.some((entry) => entry === 'GET /v1/models'), false);
  } finally {
    if (previous === undefined) delete process.env.SEAGULLED_FLEET_PROFILE;
    else process.env.SEAGULLED_FLEET_PROFILE = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Stop during local template installation cannot submit the boot model call', async () => {
  const requests = [];
  const controller = new AbortController();
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume bounded fixture requests. */ }
    const pathname = new URL(request.url, 'http://local').pathname;
    requests.push(`${request.method} ${pathname}`);
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (pathname === '/api/workspaces' && request.method === 'GET') return send(200, { workspaces: [] });
    if (pathname === '/api/workspaces' && request.method === 'POST') return send(201, {});
    if (pathname === '/api/workspaces' && request.method === 'DELETE') return send(200, {});
    if (pathname === '/api/init') return send(200, {});
    if (pathname === '/api/model' && request.method === 'GET') {
      send(200, []);
      controller.abort();
      return;
    }
    if (pathname === '/api/mcp/servers') return send(200, []);
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-stop-boot-'));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify({ supervisor: { origin }, provisioner: { kind: 'fly', flujoCloudPath: root },
    model: { name: 'gpt-6-luna', provider: 'codex', adapter: 'codex-cli', apiKey: '' } }));
  const previous = process.env.SEAGULLED_FLEET_PROFILE;
  process.env.SEAGULLED_FLEET_PROFILE = profile;
  try {
    await assert.rejects(runFleetLeaf({ goal: { id: 'stopped-boot', text: 'fixture' }, task: 'fixture',
      dataDir: root, maxUsd: 1, diagnostic: true, signal: controller.signal }),
    (error) => error.name === 'AbortError' && error.outcome === 'not_applied');
    assert.ok(requests.includes('DELETE /api/workspaces'));
    assert.equal(requests.some((entry) => entry === 'POST /v1/chat/completions'), false);
    assert.equal(requests.some((entry) => entry === 'POST /api/model'), false);
  } finally {
    if (previous === undefined) delete process.env.SEAGULLED_FLEET_PROFILE;
    else process.env.SEAGULLED_FLEET_PROFILE = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('owned relay journals before Fly mutation, forwards through its own proxy, and confirms retirement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-relay-'));
  const journalPath = path.join(root, 'relay.json');
  const flyctlPath = path.join(root, 'flyctl-fixture');
  const flyEnv = { FLYCTL_PATH: flyctlPath, FLY_CONFIG_DIR: path.join(root, 'personal-config') };
  const calls = [];
  const flyRunner = { run: async (args, { input } = {}) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'apps' && args[1] === 'create') {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      assert.equal(journal.state, 'creating-app');
      assert.equal(journal.network, relayNetwork);
      assert.deepEqual(args.slice(2), [journal.app, '--org', journal.org,
        '--network', relayNetwork, '--json', '--yes']);
    }
    if (args[0] === 'secrets' && args[1] === 'import') {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      assert.deepEqual(args.slice(2), ['--app', journal.app, '--stage']);
      assert.equal(input, `SEAGULLED_RELAY_OWNER_${journal.owner.toUpperCase()}=1\n`);
    }
    if (args[0] === 'secrets' && args[1] === 'list') {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      return JSON.stringify([{ Name: `SEAGULLED_RELAY_OWNER_${journal.owner.toUpperCase()}` }]);
    }
    if (args[0] === 'volumes' && args[1] === 'list') return '[]';
    return args[0] === 'auth' ? 'fixture-token' : '{}';
  } };
  let agentStopped = false;
  let proxyStopped = false;
  const fakeProxy = new EventEmitter();
  fakeProxy.stdin = { end: () => undefined };
  fakeProxy.kill = () => { proxyStopped = true; };
  const relay = await createOwnedRelay({ journalPath, org: 'personal', network: relayNetwork,
    flyRunner, flyEnv, flyctlPath,
    portAllocator: async () => 48121,
    spawnImpl: (binary, args, options) => {
      assert.equal(binary, flyctlPath);
      assert.deepEqual(options.env, flyEnv);
      assert.ok(args.includes('--watch-stdin')); return fakeProxy;
    },
    agentFactory: ({ controllerOrigin, lanes }) => {
      assert.equal(controllerOrigin, 'http://127.0.0.1:48122');
      assert.equal(lanes, 2);
      return { stop: () => { agentStopped = true; } };
    },
    fetchImpl: async (url, options) => {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      if (url.includes('/apps?org_slug=')) return relayInventory(journal, calls.includes('apps create'));
      if (url.endsWith('/machines') && options.method === 'POST') {
        const machine = JSON.parse(options.body);
        assert.equal(machine.config.services.length, 0);
        assert.equal(machine.config.metadata.seagulled, 'owned-relay');
        assert.equal(machine.config.metadata.seagulled_owner, journal.owner);
        return new Response(JSON.stringify({ id: 'fixturemachine' }), { status: 201 });
      }
      if (url.endsWith('/machines') && options.method === 'GET') {
        return new Response(JSON.stringify([{ id: 'fixturemachine' }]), { status: 200 });
      }
      if (url.endsWith('/machines/fixturemachine/metadata')) {
        return new Response(JSON.stringify({ seagulled: 'owned-relay', seagulled_owner: journal.owner }), { status: 200 });
      }
      if (url.endsWith('/health')) return new Response('{}', { status: 200 });
      if (url.includes('/apps/seagulled-relay-') && options.method === 'GET') {
        if (calls.includes('apps destroy')) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify({ id: 'fixture-app-id', name: journal.app,
          organization: { slug: journal.org } }), { status: 200 });
      }
      throw new Error(`Unexpected relay fixture URL: ${url}`);
    },
  });
  assert.match(relay.remoteUrl, /^http:\/\/seagulled-relay-[a-f0-9]+\.internal:4300$/);
  await relay.start('http://127.0.0.1:48122');
  assert.equal(await relay.retire(), true);
  assert.equal(agentStopped, true);
  assert.equal(proxyStopped, true);
  assert.deepEqual(calls, ['auth token', 'apps create', 'secrets import', 'secrets list',
    'secrets list', 'secrets list', 'volumes list', 'apps destroy']);
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).state, 'retired');
});

test('owned relay Machine rejection destroys only its newly created app', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-relay-failure-'));
  const journalPath = path.join(root, 'relay.json');
  const calls = [];
  await assert.rejects(() => createOwnedRelay({ journalPath, org: 'personal', network: relayNetwork,
    flyRunner: { run: async (args) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === 'secrets' && args[1] === 'list') {
        const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
        return JSON.stringify([{ name: `SEAGULLED_RELAY_OWNER_${journal.owner.toUpperCase()}` }]);
      }
      if (args[0] === 'volumes' && args[1] === 'list') return '[]';
      return args[0] === 'auth' ? 'fixture-token' : '{}';
    } },
    portAllocator: async () => 48123,
    fetchImpl: async (url, options) => {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      if (url.includes('/apps?org_slug=')) return relayInventory(journal, calls.includes('apps create'));
      if (url.endsWith('/machines') && options.method === 'POST') return new Response('{}', { status: 500 });
      if (url.endsWith('/machines') && options.method === 'GET') return new Response('[]', { status: 200 });
      if (url.includes('/apps/seagulled-relay-') && options.method === 'GET') {
        if (calls.includes('apps destroy')) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify({ id: 'fixture-app-id', name: journal.app,
          organization: { slug: journal.org } }), { status: 200 });
      }
      throw new Error(`Unexpected relay fixture URL: ${url}`);
    },
  }), /Machine creation returned HTTP 500/);
  assert.deepEqual(calls, ['auth token', 'apps create', 'secrets import', 'secrets list',
    'secrets list', 'volumes list', 'apps destroy']);
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).cleanupConfirmed, true);
});

test('relay rechecks account and network immediately before app creation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-relay-precreate-'));
  const journalPath = path.join(root, 'relay.json');
  const calls = [];
  await assert.rejects(createOwnedRelay({ journalPath, org: 'personal', network: relayNetwork,
    flyRunner: { run: async (args) => {
      calls.push(args.slice(0, 2).join(' '));
      return args[0] === 'auth' ? 'fixture-token' : '{}';
    } }, portAllocator: async () => 48124,
    fetchImpl: async (url) => {
      if (url.includes('/apps?org_slug=')) return relayInventory(
        JSON.parse(readFileSync(journalPath, 'utf8')), false);
      throw new Error(`Unexpected relay fixture URL: ${url}`);
    },
    verifyNetwork: async () => { throw new Error('Selected Fly account changed.'); },
  }), /Selected Fly account changed/);
  assert.deepEqual(calls, ['auth token']);
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).state, 'not-applied');
});

test('relay refuses a mismatched network readback before owner secret or Machine mutation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-relay-network-mismatch-'));
  const journalPath = path.join(root, 'relay.json');
  const calls = [];
  await assert.rejects(createOwnedRelay({ journalPath, org: 'personal', network: relayNetwork,
    portAllocator: async () => 48125,
    flyRunner: { run: async (args) => {
      calls.push(args.slice(0, 2).join(' '));
      return args[0] === 'auth' ? 'fixture-token' : '{}';
    } },
    fetchImpl: async (url) => {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      if (url.includes('/apps?org_slug=')) return relayInventory(journal,
        calls.includes('apps create'), 'default');
      if (url.includes('/apps/seagulled-relay-')) return new Response(JSON.stringify({
        id: 'fixture-app-id', name: journal.app, organization: { slug: journal.org },
      }), { status: 200 });
      throw new Error(`Unexpected relay fixture URL: ${url}`);
    },
  }), (error) => error.code === 'UNKNOWN');
  assert.deepEqual(calls, ['auth token', 'apps create']);
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).state, 'cleanup-unknown');
});

test('ambiguous relay app creation retains its intent and never destroys an unconfirmed app', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-relay-unknown-'));
  const journalPath = path.join(root, 'relay.json');
  const calls = [];
  await assert.rejects(() => createOwnedRelay({ journalPath, org: 'personal', network: relayNetwork,
    flyRunner: { run: async (args) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === 'apps') throw new Error('fixture connection lost');
      return 'fixture-token';
    } }, portAllocator: async () => 48123,
    fetchImpl: async (url) => {
      if (url.includes('/apps?org_slug=')) return relayInventory(
        JSON.parse(readFileSync(journalPath, 'utf8')), calls.includes('apps create'));
      throw new Error(`Unexpected relay fixture URL: ${url}`);
    },
  }), (error) => error.code === 'UNKNOWN');
  assert.deepEqual(calls, ['auth token', 'apps create']);
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).state, 'creation-unknown');
});

test('relay creation holds an app when its staged owner marker cannot be confirmed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-relay-unmarked-'));
  const journalPath = path.join(root, 'relay.json');
  const calls = [];
  await assert.rejects(() => createOwnedRelay({ journalPath, org: 'personal', network: relayNetwork,
    flyRunner: { run: async (args) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[0] === 'secrets' && args[1] === 'list') return '[]';
      return args[0] === 'auth' ? 'fixture-token' : '{}';
    } }, portAllocator: async () => 48123,
    fetchImpl: async (url) => {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      if (url.includes('/apps?org_slug=')) return relayInventory(journal, calls.includes('apps create'));
      if (url.includes('/apps/seagulled-relay-')) return new Response(JSON.stringify({
        id: 'fixture-app-id', name: journal.app, organization: { slug: journal.org },
      }), { status: 200 });
      throw new Error(`Unexpected relay fixture URL: ${url}`);
    },
  }), (error) => error.code === 'UNKNOWN');
  assert.deepEqual(calls, ['auth token', 'apps create', 'secrets import', 'secrets list']);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  assert.equal(journal.ownershipConfirmed, false);
  assert.equal(journal.state, 'cleanup-unknown');
});

test('relay retirement refuses changed app identity, network, app marker, Machine markers, or foreign volumes', async () => {
  for (const changed of ['app-id', 'network', 'app-marker', 'machine-owner', 'machine-type', 'foreign-volume']) {
    const root = mkdtempSync(path.join(tmpdir(), 'seagulled-relay-foreign-'));
    const journalPath = path.join(root, 'relay.json');
    const calls = [];
    let retired = false;
    const relay = await createOwnedRelay({ journalPath, org: 'personal', network: relayNetwork,
      portAllocator: async () => 48124,
      flyRunner: { run: async (args) => {
        calls.push(args.slice(0, 2).join(' '));
        if (args[0] === 'secrets' && args[1] === 'list') {
          const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
          return JSON.stringify([{ Name: retired && changed === 'app-marker' ? 'FOREIGN_OWNER'
            : `SEAGULLED_RELAY_OWNER_${journal.owner.toUpperCase()}` }]);
        }
        if (args[0] === 'volumes' && args[1] === 'list') {
          return retired && changed === 'foreign-volume' ? '[{"id":"foreign-volume"}]' : '[]';
        }
        return args[0] === 'auth' ? 'fixture-token' : '{}';
      } },
      fetchImpl: async (url, options) => {
        const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
        if (url.includes('/apps?org_slug=')) return relayInventory(journal, calls.includes('apps create'),
          retired && changed === 'network' ? 'default' : relayNetwork);
        if (url.endsWith('/machines') && options.method === 'POST') return new Response('{"id":"fixturemachine"}', { status: 201 });
        if (url.endsWith('/machines') && options.method === 'GET') return new Response('[{"id":"fixturemachine"}]', { status: 200 });
        if (url.endsWith('/machines/fixturemachine/metadata')) return new Response(JSON.stringify({
          seagulled: retired && changed === 'machine-type' ? 'foreign' : 'owned-relay',
          seagulled_owner: retired && changed === 'machine-owner' ? 'foreign-owner' : journal.owner,
        }), { status: 200 });
        if (url.includes('/apps/seagulled-relay-') && options.method === 'GET') return new Response(JSON.stringify({
          id: retired && changed === 'app-id' ? 'foreign-app-id' : 'fixture-app-id',
          name: journal.app, organization: { slug: journal.org },
        }), { status: 200 });
        throw new Error(`Unexpected relay fixture URL: ${url}`);
      },
    });
    retired = true;
    assert.equal(await relay.retire(), false);
    assert.equal(calls.includes('apps destroy'), false, `${changed} must not be destroyed`);
    assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).state, 'cleanup-unknown');
  }
});

test('owned worker files are collected before subtree retirement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-before-retire-'));
  const order = [];
  const controller = new Controller({ registryPath: path.join(root, 'registry.json'),
    operatorToken: 'fixture-operator-token-at-least-32-characters', publicUrl: 'http://127.0.0.1:1',
    provisioner: { retire: async (target) => { order.push(`delete:${target.app}`); } },
    beforeRetire: async ({ target }) => { order.push(`collect:${target.app}`); } });
  try {
    const goal = controller.registry.createGoal({ id: 'owned-tree', text: 'fixture', limits: { maxWorkers: 3, maxDepth: 2, maxChildren: 2 } });
    const supervisor = controller.registry.reserve({ goalId: goal.id, role: 'supervisor', name: 'Todd' }).worker;
    controller.registry.enroll(supervisor.id, { kind: 'external', origin: 'http://127.0.0.1:1', workspace: 'fixture' });
    const parent = controller.registry.reserve({ goalId: goal.id, parentId: supervisor.id, role: 'team', name: 'parent' }).worker;
    controller.registry.enroll(parent.id, { kind: 'fly', app: 'parent-app' });
    const child = controller.registry.reserve({ goalId: goal.id, parentId: parent.id, role: 'team', name: 'child' }).worker;
    controller.registry.enroll(child.id, { kind: 'fly', app: 'child-app' });
    const result = await controller.retire('operator', { workerId: parent.id });
    assert.deepEqual(result.retired, [child.id, parent.id]);
    assert.deepEqual(order, ['collect:child-app', 'delete:child-app', 'collect:parent-app', 'delete:parent-app']);
  } finally { await controller.close(); }
});

test('failed capture holds the exact owned sandbox without deleting it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-capture-hold-'));
  let deleted = false;
  const controller = new Controller({ registryPath: path.join(root, 'registry.json'),
    operatorToken: 'fixture-operator-token-at-least-32-characters', publicUrl: 'http://127.0.0.1:1',
    provisioner: { retire: async () => { deleted = true; } },
    beforeRetire: async () => { throw new Error('fixture capture failed'); } });
  try {
    const goal = controller.registry.createGoal({ id: 'capture-hold', text: 'fixture' });
    const supervisor = controller.registry.reserve({ goalId: goal.id, role: 'supervisor', name: 'Todd' }).worker;
    controller.registry.enroll(supervisor.id, { kind: 'external', origin: 'http://127.0.0.1:1', workspace: 'fixture' });
    const worker = controller.registry.reserve({ goalId: goal.id, parentId: supervisor.id, role: 'team', name: 'developer' }).worker;
    controller.registry.enroll(worker.id, { kind: 'fly', app: 'owned-app' });
    const receipt = await controller.retire('operator', { workerId: worker.id });
    assert.deepEqual(receipt.cleanupUnconfirmed, [worker.id]);
    assert.equal(deleted, false);
    assert.equal(controller.registry.worker(worker.id).target.app, 'owned-app');
    assert.equal(controller.registry.worker(worker.id).cleanup.confirmed, false);
    assert.throws(() => controller.registry.reserve({ goalId: goal.id, parentId: supervisor.id, name: 'other' }), /Unknown runs or unconfirmed cleanup/);
    await controller.retire('operator', { workerId: worker.id });
    assert.equal(deleted, false, 'repeated retirement preserves the held original sandbox');
  } finally { await controller.close(); }
});

test('failed Fly conversation preserves only bounded nonsecret diagnosis fields', () => {
  const result = conversationFailure({ status: 200, body: { status: 'error', lastError: {
    message: 'Bearer fictional-sensitive-token in provider response', code: 'api_error',
    httpStatus: 401, errorClass: 'authentication', providerType: 'CodexError',
    details: { authorization: 'fictional-sensitive-token' },
  } } });
  assert.deepEqual(result, { readStatus: 200, conversationStatus: 'error', providerHttpStatus: 401,
    code: 'api_error', errorClass: 'authentication', providerType: 'CodexError' });
  assert.equal(JSON.stringify(result).includes('fictional-sensitive-token'), false);
});
