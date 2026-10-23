import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, lstatSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { Controller } from '../upstream/swarm-teams/fleet/controller.mjs';
import { createControllerNativeSourceAdmission } from '../src/native-source-admission.mjs';
import { createNativeSourceAdmissionTransport, createNativeSourceAdmissionClient } from '../src/native-source-transport.mjs';

async function equipment(task) {
  const parent = os.tmpdir();
  const directory = mkdtempSync(path.join(parent, 'seagulled-native-admission-'));
  const controller = new Controller({ registryPath: path.join(directory, 'registry.json'),
    operatorToken: 'synthetic-test-only-operator-'.repeat(2), publicUrl: 'http://127.0.0.1:1', provisioner: {} });
  const registry = controller.registry;
  const goal = registry.createGoal({ text: 'Deterministic Controller admission equipment; no SDK or cloud execution.' });
  const { worker, token } = registry.reserve({ goalId: goal.id, role: 'supervisor', name: 'owned-test-worker' });
  registry.enroll(worker.id, { kind: 'external', origin: 'http://127.0.0.1:1', workspace: 'test-workspace' });
  const run = registry.startRun({ workerId: worker.id, startedBy: 'operator', task: 'admission only', flowName: 'test-flow' });
  registry.bindRunTarget(run.id, worker.target);
  const request = { headers: { authorization: `Bearer ${token}` } };
  const claim = { runId: run.id, rootConversationId: run.conversationId, goalId: goal.id, workspace: worker.target.workspace };
  const stop = new AbortController();
  let active = true;
  let selectedPlan = { flowId: 'test-flow', flowDigest: 'a'.repeat(64), modelId: 'test-luna', modelDigest: 'b'.repeat(64) };
  const scope = { signal: stop.signal, async assertCurrent() { if (!active) throw new Error('OFF'); stop.signal.throwIfAborted(); },
    async commit(effect) { await this.assertCurrent(); return effect(); } };
  const admission = createControllerNativeSourceAdmission({ controller, scope, readPlan: async actor => {
    assert.equal(actor.workerId, worker.id); return selectedPlan;
  } });
  const expected = { conversationId: run.conversationId, runId: 'source-logical-run', workspace: worker.target.workspace, ...selectedPlan };
  try { await task({ controller, registry, goal, worker, run, request, claim, admission, expected, stop, scope,
    readPlan: async () => selectedPlan,
    pause() { active = false; }, driftPlan() { selectedPlan = { ...selectedPlan, modelDigest: 'c'.repeat(64) }; } }); }
  finally {
    admission.close(); await controller.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(parent));
    assert.match(path.basename(resolved), /^seagulled-native-admission-[A-Za-z0-9]+$/);
    assert.ok(lstatSync(resolved).isDirectory() && !lstatSync(resolved).isSymbolicLink());
    rmSync(resolved, { recursive: true, force: true });
  }
}

test('real Controller Worker authentication binds exactly one Source logical run', () => equipment(async e => {
  const context = await e.admission.admitWorker(e.request, e.claim);
  await assert.rejects(e.admission.readRoot(context, e.expected));
  await e.admission.bindRun(context, e.run.conversationId, e.expected.runId);
  const root = await e.admission.readRoot(context, e.expected);
  assert.equal(root.workerId, e.worker.id); assert.equal(root.goalId, e.goal.id);
  assert.equal(root.fleetRunId, e.run.id); assert.equal(root.logicalRunId, e.expected.runId);
  assert.equal(root.flowDigest, e.expected.flowDigest); assert.equal(root.modelDigest, e.expected.modelDigest);
  assert.equal(Object.keys(root).length, 12); assert.ok(Object.isFrozen(root));
  assert.match(root.leaseEpoch, /^[a-f0-9-]{36}$/);
  await assert.rejects(e.admission.bindRun(context, e.run.conversationId, 'different-run'));
  await assert.rejects(e.admission.readRoot({ ...context }, e.expected));
  await assert.rejects(e.admission.readRoot(context, { ...e.expected, modelDigest: 'c'.repeat(64) }));
  await assert.rejects(e.admission.readRoot(context, { ...e.expected, conversationId: undefined }));
  assert.ok(!JSON.stringify(context).includes(e.request.headers.authorization));
}));

test('private HTTP transport authenticates the actual Controller before returning a pinned root', () => equipment(async e => {
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan });
  try {
    const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token, signal: e.stop.signal });
    const context = await client.admit(e.request.headers.authorization, e.claim);
    assert.deepEqual(await client.readPlan(context), await e.readPlan());
    assert.match(client.bindingId, /^[a-f0-9]{64}$/);
    await client.bindRun(context, e.run.conversationId, e.expected.runId);
    const root = await client.readRoot(context, e.expected);
    assert.equal(root.workerId, e.worker.id); assert.equal(root.fleetRunId, e.run.id);
    assert.equal(root.logicalRunId, e.expected.runId); assert.equal(root.modelDigest, e.expected.modelDigest);
    await assert.rejects(client.readRoot({ ...context }, e.expected));
    e.driftPlan(); await assert.rejects(client.assertRun(context));
  } finally { await transport.close(); }
}));

test('independent child plan is pinned to the authenticated root and drift revokes both scopes',()=>equipment(async e=>{
  let children=[{parentNodeId:'owned-subflow',flowId:'owned-child',flowDigest:'d'.repeat(64),modelId:e.expected.modelId,modelDigest:e.expected.modelDigest}];
  const transport=await createNativeSourceAdmissionTransport({controller:e.controller,scope:e.scope,readPlan:e.readPlan,readChildren:async actor=>{
    assert.equal(actor.workerId,e.worker.id);return children;
  }});
  try{
    const client=createNativeSourceAdmissionClient(transport),context=await client.admit(e.request.headers.authorization,e.claim);
    assert.deepEqual(await client.readChildren(context),children);
    await assert.rejects(client.readChildren({...context}));
    children=[{...children[0],flowDigest:'e'.repeat(64)}];
    await assert.rejects(client.readChildren(context));await assert.rejects(client.assertRun(context));
  }finally{await transport.close();}
}));

test('repeated live admission checks reuse connections and still observe OFF',()=>equipment(async e=>{
  const transport=await createNativeSourceAdmissionTransport({controller:e.controller,scope:e.scope,readPlan:e.readPlan});
  const port=new URL(transport.url).port;let connections=0;
  const connected=channel('undici:client:connected');
  const observe=message=>{if(String(message.connectParams?.port)===port)connections++;};
  connected.subscribe(observe);
  try{
    const client=createNativeSourceAdmissionClient(transport);
    const context=await client.admit(e.request.headers.authorization,e.claim);
    for(let index=0;index<40;index++)await client.assertRun(context);
    assert.ok(connections>0&&connections<=3,`Expected reused RPC connections; observed ${connections}`);
    e.pause();await assert.rejects(client.assertRun(context));
  }finally{connected.unsubscribe(observe);await transport.close();}
}));

test('Source transport credential never substitutes for an executing Worker bearer', () => equipment(async e => {
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan });
  try {
    const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
    await assert.rejects(client.admit(`Bearer ${transport.token}`, e.claim));
    await assert.rejects(client.admit(`Bearer ${e.controller.operatorToken}`, e.claim));
    const headers = { authorization: `Bearer ${transport.token}`, 'content-type': 'application/json' };
    assert.equal((await fetch(transport.url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(transport.url, { method: 'POST', headers: { ...headers, origin: 'http://127.0.0.1' },
      body: JSON.stringify({ operation: 'admit', args: { workerAuthorization: e.request.headers.authorization, claim: e.claim } }) })).status, 403);
    for (const operation of ['commit', 'infer', 'tool', 'release']) {
      assert.equal((await fetch(transport.url, { method: 'POST', headers,
        body: JSON.stringify({ operation, args: {} }) })).status, 403);
    }
    assert.equal((await fetch(transport.url + '?context=foreign', { method: 'POST', headers, body: '{}' })).status, 404);
    assert.equal((await fetch(transport.url, { method: 'POST', headers, body: 'x'.repeat(17 * 1024) })).status, 413);
  } finally { await transport.close(); }
}));

test('the real owning abort reaches the Source signal over its private connection', () => equipment(async e => {
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan });
  let observed;
  try {
    const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
    const context = await client.admit(e.request.headers.authorization, e.claim);
    observed = await client.observe(context);
    assert.equal(observed.signal.aborted, false);
    e.stop.abort(new Error('owned scope stopped'));
    await Promise.race([observed.done, new Promise((_, reject) => {
      const deadline = setTimeout(() => reject(new Error('Source cancellation was not delivered.')), 2_000); deadline.unref();
    })]);
    assert.equal(observed.signal.aborted, true);
  } finally { await observed?.close(); await transport.close(); }
}));

test('closing the private transport retires the observed Source capability', () => equipment(async e => {
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan });
  const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
  const context = await client.admit(e.request.headers.authorization, e.claim);
  const observed = await client.observe(context);
  try { await transport.close(); await observed.done; assert.equal(observed.signal.aborted, true); }
  finally { await observed.close(); await transport.close(); }
}));

test('Source client refuses arbitrary endpoints before accepting ownership', () => {
  for (const url of ['https://127.0.0.1/native-source/admission', 'http://example.com/native-source/admission',
    'http://127.0.0.1/native-source/admission?redirect=foreign', 'http://127.0.0.1/other',
    'http://owner:secret@127.0.0.1/native-source/admission']) {
    assert.throws(() => createNativeSourceAdmissionClient({ url, token: 'a'.repeat(43) }));
  }
});

test('a redirect cannot forward the private Source credential to another listener', async () => {
  let forwarded = 0;
  const target = createServer((_request, response) => { forwarded++; response.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/native-source/admission` }); response.end();
  });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  try {
    const client = createNativeSourceAdmissionClient({ url: `http://127.0.0.1:${redirect.address().port}/native-source/admission`, token: 'a'.repeat(43) });
    await assert.rejects(client.admit('Bearer synthetic-worker', {}));
    assert.equal(forwarded, 0);
  } finally {
    for (const server of [redirect, target]) {
      const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped;
    }
  }
});

test('operator and another Worker bearer cannot admit this original root', () => equipment(async e => {
  await assert.rejects(e.admission.admitWorker({ headers: { authorization: `Bearer ${e.controller.operatorToken}` } }, e.claim));
  const other = e.registry.reserve({ goalId: e.goal.id, role: 'team', parentId: e.worker.id, name: 'other' });
  e.registry.enroll(other.worker.id, { kind: 'external', origin: 'http://127.0.0.1:1', workspace: 'other-workspace' });
  await assert.rejects(e.admission.admitWorker({ headers: { authorization: `Bearer ${other.token}` } }, e.claim));
}));

test('immutable target drift blocks mutation before its effect', () => equipment(async e => {
  const context = await e.admission.admitWorker(e.request, e.claim);
  e.worker.target.workspace = 'drifted-workspace'; e.registry.save();
  let effects = 0;
  await assert.rejects(e.admission.commit(context, async () => effects++));
  assert.equal(effects, 0);
}));

test('plan drift and parent OFF cannot publish another native root', () => equipment(async e => {
  const context = await e.admission.admitWorker(e.request, e.claim);
  await e.admission.bindRun(context, e.run.conversationId, e.expected.runId);
  e.driftPlan(); await assert.rejects(e.admission.readRoot(context, e.expected));
  e.pause(); await assert.rejects(e.admission.assertRun(context));
}));

test('run completion during an awaited mutation is detected under the owning scope', () => equipment(async e => {
  const context = await e.admission.admitWorker(e.request, e.claim);
  await assert.rejects(e.admission.commit(context, async () => {
    e.registry.settleRun(e.run.id, { status: 'completed', output: 'synthetic admission equipment' });
  }));
}));

test('cancellation and loss of the actual Controller writer lease retire admission', () => equipment(async e => {
  const context = await e.admission.admitWorker(e.request, e.claim);
  assert.equal(e.admission.signal(context), e.stop.signal);
  e.controller.releaseOwner();
  await assert.rejects(e.admission.assertRun(context), { code: 'NATIVE_SOURCE_ADMISSION' });
  e.stop.abort(new Error('stopped'));
  await assert.rejects(e.admission.admitWorker(e.request, e.claim));
}));

test('a successor Controller in the same OS process cannot inherit the old Source authority', () => equipment(async e => {
  const context = await e.admission.admitWorker(e.request, e.claim);
  e.controller.releaseOwner();
  const successor = new Controller({ registryPath: e.registry.path,
    operatorToken: 'synthetic-successor-operator-'.repeat(2), publicUrl: 'http://127.0.0.1:1', provisioner: {} });
  try { await assert.rejects(e.admission.assertRun(context), { code: 'NATIVE_SOURCE_ADMISSION' }); }
  finally { await successor.close(); }
}));

test('the owning scope receives the authenticated actor rather than Source expected values', () => equipment(async e => {
  e.scope.assertCurrent = async actor => { assert.equal(actor.goalId, e.goal.id); assert.equal(actor.workerId, e.worker.id); };
  const context = await e.admission.admitWorker(e.request, e.claim);
  await e.admission.assertRun(context);
  e.scope.assertCurrent = async actor => { assert.notEqual(actor.goalId, e.goal.id); };
  await assert.rejects(e.admission.assertRun(context));
}));

test('fresh contexts cannot rebind one actual Controller root to another Source run or plan', () => equipment(async e => {
  const first = await e.admission.admitWorker(e.request, e.claim);
  const second = await e.admission.admitWorker(e.request, e.claim);
  await e.admission.bindRun(first, e.run.conversationId, e.expected.runId);
  await assert.rejects(e.admission.bindRun(second, e.run.conversationId, 'different-source-run'));
  await e.admission.bindRun(second, e.run.conversationId, e.expected.runId);
  const root1 = await e.admission.readRoot(first, e.expected);
  const root2 = await e.admission.readRoot(second, e.expected);
  assert.equal(root1.leaseEpoch, root2.leaseEpoch);
  e.driftPlan(); await assert.rejects(e.admission.admitWorker(e.request, e.claim));
}));

test('private Source mutation keeps the actual Parent fence open throughout the callback', () => equipment(async e => {
  let held = false, holds = 0;
  e.scope.commit = async (task, actor) => {
    assert.equal(actor.workerId, e.worker.id); assert.equal(held, false);
    held = true; try { return await task(); } finally { held = false; }
  };
  e.scope.retainUncertainty = async () => { assert.equal(held, true); holds++; };
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan });
  try {
    const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
    const context = await client.admit(e.request.headers.authorization, e.claim);
    const result = await client.commit(context, async () => {
      assert.equal(held, true); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(held, true); return 'actual-callback-value';
    });
    assert.equal(result, 'actual-callback-value'); assert.equal(held, false); assert.equal(holds, 0);
  } finally { await transport.close(); }
}));

test('Source cannot perform a mutation without an owning durable uncertainty path', () => equipment(async e => {
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan });
  try {
    const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
    const context = await client.admit(e.request.headers.authorization, e.claim);
    let effects = 0;
    await assert.rejects(client.commit(context, async () => effects++)); assert.equal(effects, 0);
  } finally { await transport.close(); }
}));

test('Parent OFF during a Source mutation retains uncertainty before releasing its fence', () => equipment(async e => {
  let held = false, holds = 0;
  e.scope.commit = async task => { held = true; try { return await task(); } finally { held = false; } };
  e.scope.retainUncertainty = async (_context, evidence) => { assert.equal(held, true); assert.equal(evidence.reason, 'parent-fence-refused'); holds++; };
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan });
  try {
    const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
    const context = await client.admit(e.request.headers.authorization, e.claim);
    await assert.rejects(client.commit(context, async () => { assert.equal(held, true); e.pause(); }));
    assert.equal(holds, 1); assert.equal(held, false);
  } finally { await transport.close(); }
}));

test('a failed Source callback records possible effects before the Parent fence releases', () => equipment(async e => {
  let held = false, holds = 0;
  e.scope.commit = async task => { held = true; try { return await task(); } finally { held = false; } };
  e.scope.retainUncertainty = async (_context, evidence) => { assert.equal(held, true); assert.equal(evidence.reason, 'source-callback-failed'); holds++; };
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan });
  try {
    const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
    const context = await client.admit(e.request.headers.authorization, e.claim);
    await assert.rejects(client.commit(context, async () => { throw new Error('Source partial write failed'); }), /partial write/);
    assert.equal(holds, 1); assert.equal(held, false);
    await assert.rejects(client.assertRun(context));
    await assert.rejects(client.commit(context, async () => { assert.fail('uncertainty must block further effects'); }));
  } finally { await transport.close(); }
}));

test('a lost mutation grant expires into a retained hold rather than confirmed rollback', () => equipment(async e => {
  let held = false, holds = 0;
  e.scope.commit = async task => { held = true; try { return await task(); } finally { held = false; } };
  e.scope.retainUncertainty = async (_context, evidence) => { assert.equal(held, true); assert.equal(evidence.reason, 'deadline'); holds++; };
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan, mutationTimeoutMs: 20 });
  try {
    const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
    const context = await client.admit(e.request.headers.authorization, e.claim);
    await assert.rejects(client.commit(context, async () => { await new Promise(resolve => setTimeout(resolve, 50)); }));
    assert.equal(holds, 1); assert.equal(held, false);
  } finally { await transport.close(); }
}));

test('a mutation ticket cannot be completed by another context or replayed', () => equipment(async e => {
  e.scope.retainUncertainty = async () => { assert.fail('a legitimate completed ticket needs no hold'); };
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan });
  const rpc = async (operation, args) => fetch(transport.url, { method: 'POST',
    headers: { authorization: `Bearer ${transport.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ operation, args }) });
  try {
    const first = await (await rpc('admit', { workerAuthorization: e.request.headers.authorization, claim: e.claim })).json();
    const second = await (await rpc('admit', { workerAuthorization: e.request.headers.authorization, claim: e.claim })).json();
    const grant = await (await rpc('begin-mutation', first)).json();
    assert.equal((await rpc('finish-mutation', { ...second, ticket: grant.ticket, outcome: 'completed' })).status, 403);
    assert.equal((await rpc('finish-mutation', { ...first, ticket: grant.ticket, outcome: 'completed' })).status, 200);
    assert.equal((await rpc('finish-mutation', { ...first, ticket: grant.ticket, outcome: 'completed' })).status, 403);
  } finally { await transport.close(); }
}));

test('transport closure records a live Source mutation as uncertain before cleanup', () => equipment(async e => {
  let held = false, holds = 0, release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  e.scope.commit = async task => { held = true; try { return await task(); } finally { held = false; } };
  e.scope.retainUncertainty = async (_context, evidence) => { assert.equal(held, true); assert.equal(evidence.reason, 'transport-closed'); holds++; };
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan });
  const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
  const context = await client.admit(e.request.headers.authorization, e.claim);
  const mutation = client.commit(context, async () => { started(); await blocked; });
  const refused = assert.rejects(mutation);
  await entered; await transport.close(); release(); await refused;
  assert.equal(holds, 1); assert.equal(held, false);
}));

test('failed uncertainty persistence leaves the granted owner fence held and reports unconfirmed cleanup', () => equipment(async e => {
  let held = false, attempts = 0;
  e.scope.commit = async task => { held = true; try { return await task(); } finally { held = false; } };
  e.scope.retainUncertainty = async () => { assert.equal(held, true); attempts++; throw new Error('durable hold disk failure'); };
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan, mutationTimeoutMs: 20 });
  const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
  const context = await client.admit(e.request.headers.authorization, e.claim);
  await assert.rejects(client.commit(context, async () => { await new Promise(resolve => setTimeout(resolve, 50)); }));
  assert.equal(attempts, 1); assert.equal(held, true);
  await assert.rejects(client.assertRun(context));
  await assert.rejects(transport.close(), { code: 'UNKNOWN', outcome: 'unknown' });
  await assert.rejects(transport.close(), { code: 'UNKNOWN', outcome: 'unknown' });
  assert.equal(held, true);
}));

test('an expired admission never grants Source a mutation or claims possible applied effects', () => equipment(async e => {
  let holds = 0, effects = 0;
  e.scope.commit = async task => { await new Promise(resolve => setTimeout(resolve, 50)); return task(); };
  e.scope.retainUncertainty = async () => { holds++; };
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan, mutationTimeoutMs: 20 });
  try {
    const client = createNativeSourceAdmissionClient({ url: transport.url, token: transport.token });
    const context = await client.admit(e.request.headers.authorization, e.claim);
    await assert.rejects(client.commit(context, async () => { effects++; }));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(effects, 0); assert.equal(holds, 0);
    await client.assertRun(context);
  } finally { await transport.close(); }
}));
