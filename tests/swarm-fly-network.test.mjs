import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAppNetwork, assertNetworkVacant, assertPlannedNetworkMembers,
  readFlyOrgApps } from '../src/swarm/fly-network.mjs';

const network = 'seagulled-g-0123456789abcdef0123456789abcdef';
const app = { id: 'appabc123', name: 'seagulled-relay-abc123', network };
const response = (apps, total = apps.length, options = {}) => new Response(
  JSON.stringify({ total_apps: total, apps }), { status: 200, ...options });
const read = (fetchImpl) => readFlyOrgApps({ org: 'personal', token: 'fixture-private-token', fetchImpl });

test('bounded org inventory proves exact app and 6PN while unrelated default apps remain untouched', async () => {
  const apps = await read(async (url, options) => {
    assert.equal(url, 'https://api.machines.dev/v1/apps?org_slug=personal');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-private-token');
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    return response([{ id: 'other123', name: 'other-production-app', network: 'default' }, app]);
  });
  assert.deepEqual(assertAppNetwork(apps, { app: app.name, appId: app.id, network }), app);
  assert.throws(() => assertNetworkVacant(apps, network), /already has apps/);
  assert.throws(() => assertAppNetwork(apps, { app: app.name, appId: app.id,
    network: 'seagulled-g-other' }), /network identity changed/);
  assert.equal(apps[0].network, 'default');
});

test('compressed inventory uses the decoded byte cap without comparing encoded Content-Length', async () => {
  const bytes = JSON.stringify({ total_apps: 1, apps: [app] });
  const compressedHeader = new Response(bytes, { status: 200,
    headers: { 'content-encoding': 'gzip', 'content-length': '12' } });
  assert.deepEqual(await read(async () => compressedHeader), [app]);
  await assert.rejects(read(async () => new Response(bytes, { status: 200,
    headers: { 'content-length': '12' } })), /length changed/);
});

test('unknown, incomplete, duplicate, oversized or redirected inventory never proves isolation', async () => {
  const cases = [
    () => response([app], 2),
    () => response([{ ...app, network: undefined }]),
    () => response([app, { ...app, id: 'differentid' }]),
    () => response(Array.from({ length: 2049 }, (_, i) => ({ id: `app${i}`, name: `app-${i}`, network: 'default' }))),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 }),
    () => new Response('{}', { status: 302, headers: { Location: 'https://example.test' } }),
  ];
  for (const make of cases) await assert.rejects(read(async () => make()));
  assert.throws(() => assertNetworkVacant([app], network), /already has apps/);
  assert.throws(() => assertNetworkVacant([], 'default'), /product-private/);
});

test('planned siblings can coexist during creation while foreign network members hold the goal', () => {
  const worker = { id: 'workerabc', name: 'seagulled-worker-abc123', network };
  const plans = {
    [app.name]: { kind: 'relay', state: 'confirmed', appId: app.id,
      ownerMarker: `SEAGULLED_RELAY_OWNER_${'A'.repeat(32)}` },
    [worker.name]: { kind: 'worker', state: 'planned' },
  };
  assert.deepEqual(assertPlannedNetworkMembers([app, worker], network, plans,
    { allowPending: true }), { confirmed: 1, pending: 1 });
  assert.throws(() => assertPlannedNetworkMembers([app, worker], network, plans),
    (error) => error.code === 'NETWORK_PENDING');
  assert.throws(() => assertPlannedNetworkMembers([app, worker,
    { id: 'foreign123', name: 'foreign-app', network }], network, plans,
  { allowPending: true }), /unverified app/);
  plans[worker.name] = { kind: 'worker', state: 'confirmed', appId: worker.id,
    ownerMarker: `FLUJO_CLOUD_OWNER_${'B'.repeat(32)}` };
  assert.deepEqual(assertPlannedNetworkMembers([app, worker], network, plans),
    { confirmed: 2, pending: 0 });
  assert.throws(() => assertPlannedNetworkMembers([app, worker], network, {
    ...plans, [worker.name]: { ...plans[worker.name],
      ownerMarker: `SEAGULLED_RELAY_OWNER_${'B'.repeat(32)}` },
  }), /unverified app/);
  assert.throws(() => assertPlannedNetworkMembers([app], network, plans), /incomplete owned app receipt/);
});
