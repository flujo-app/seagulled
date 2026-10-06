import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.mjs';

const unavailable = reasonCode => Object.assign(new Error('PRIVATE_SOURCE_DETAIL_MUST_NOT_ESCAPE'), {
  code: 'COMPANY_UNAVAILABLE', reasonCode, publicDetail: 'PRIVATE_SOURCE_DETAIL_MUST_NOT_ESCAPE', outcome: 'not_applied',
});
function fixture(t, { prepare, execute, noAdmission = false } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-company-runtime-'));
  const seen = { stages: [], executions: 0, startup: 0, retirement: 0 };
  let sink;
  const providers = {
    discover: async () => providers.publicState(),
    publicState: () => [{ id: 'fixture', available: true, connected: true }],
    privateComputeState: async () => ({ provisionable: true, admission: { enableUsd: 6 } }),
    privateComputeEnable: async ({ admissionId }) => { seen.startup++; return { ready: true, reservation: { id: admissionId, amountUsd: 6 }, usage: { costKind: 'estimated', costUsd: 0.08 } }; },
    privateComputeLeaseGoal: async () => {},
    privateComputeDisable: async () => { seen.retirement++; return { cleanupVerified: true }; },
  };
  const sourceLease = Object.freeze({ privateSource: 'PRIVATE_BINDING_MUST_NOT_PERSIST' });
  const readyLease = Object.freeze({ privateRoute: 'PRIVATE_ROUTE_MUST_NOT_PERSIST' });
  const swarm = {
    setEventHandler: handler => { sink = handler; },
    ...(!noAdmission ? { async prepareCompany(goal, options) {
      seen.stages.push(options.stage);
      return prepare ? prepare(goal, options, seen) : options.stage === 'source' ? sourceLease : readyLease;
    } } : {}),
    async execute(input) {
      seen.executions++;
      assert.equal(input.admission, readyLease);
      return execute ? execute(input, sink, seen) : { text: 'Offline admission fixture completed.' };
    },
  };
  const app = createRuntime({ dataDir, providers, swarm });
  t.after(async () => {
    await app.close();
    assert.ok(path.resolve(dataDir).startsWith(path.join(path.resolve(tmpdir()), 'seagulled-company-runtime-')));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, seen, dataDir, providers, swarm, sourceLease, readyLease };
}

test('default company goal stays queued without admission and never dispatches a local substitute', async t => {
  const { app, seen } = fixture(t, { noAdmission: true });
  const goal = await app.chat('Build an actual company');
  const result = await app.wait(goal.id);
  assert.equal(result.executionMode, 'company');
  assert.equal(result.workerTopologyVersion, 3);
  assert.equal(result.maxWorkers, 10);
  assert.equal(result.conversationsPerWorker, 10);
  assert.equal(result.agentsPerWorker, 9);
  assert.equal(result.status, 'queued');
  assert.equal(result.execution.readiness, 'blocked');
  assert.equal(seen.executions, 0);
  assert.equal(seen.startup, 0);
  assert.equal(app.snapshot().spend.usd, 0);
  assert.equal(result.execution.verifiedWorkers, 0);
  assert.ok(!app.snapshot().conversation.some(m => /putting the team|team has started/i.test(m.text)));
});

test('failed source preflight fences H100 startup and sanitizes the blocked reason', async t => {
  const { app, seen, dataDir } = fixture(t, { prepare: () => { throw unavailable('source'); } });
  const goal = await app.chat('Private company fixture', { privateH100: true });
  const result = await app.wait(goal.id);
  assert.deepEqual(seen.stages, ['source']);
  assert.equal(result.status, 'queued');
  assert.equal(seen.startup, 0);
  assert.equal(seen.executions, 0);
  assert.equal(result.privateCompute, undefined);
  assert.ok(!readFileSync(path.join(dataDir, 'state.json'), 'utf8').includes('PRIVATE_SOURCE_DETAIL'));
});

for (const action of ['pause', 'stop']) test(`${action} cancels pending source admission before any execution or usage receipt`, async t => {
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const { app, seen } = fixture(t, { prepare: (_goal, { signal }) => new Promise((resolve, reject) => {
    started();
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Fixture cancelled'), { name: 'AbortError' })), { once: true });
  }) });
  const goal = await app.chat('Wait for owned source');
  await pending;
  assert.equal(app.snapshot().goals[0].status, 'queued');
  assert.equal(app.snapshot().goals[0].execution.readiness, 'checking');
  await app.controlGoal(goal.id, action);
  const result = await app.wait(goal.id);
  assert.equal(result.status, action === 'stop' ? 'stopped' : 'paused');
  assert.equal(seen.executions, 0);
  assert.equal(seen.startup, 0);
  assert.equal(app.snapshot().spend.usd, 0);
});

test('opaque fixture admission stays in memory and only execution events supply staffing counts', async t => {
  const publicEvents = [];
  const { app, seen, dataDir } = fixture(t, { execute: ({ goal }, sink) => {
    assert.equal(goal.execution.verifiedWorkers, 0);
    sink({ type: 'company', goalId: goal.id, verifiedWorkers: '5', verifiedChildConversations: -1 });
    assert.equal(app.snapshot().goals[0].execution.verifiedWorkers, 0);
    sink({ type: 'company', goalId: goal.id, verifiedWorkers: 5, verifiedChildConversations: 20,
      privateSource: 'PRIVATE_EVENT_MUST_NOT_ESCAPE' });
    return { text: 'Offline admission fixture completed.' };
  } });
  app.subscribe(event => publicEvents.push(event));
  const goal = await app.chat('Admission wiring fixture');
  const result = await app.wait(goal.id);
  assert.deepEqual(seen.stages, ['source', 'ready']);
  assert.equal(seen.executions, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.execution.verifiedWorkers, 5);
  assert.equal(result.execution.verifiedChildConversations, 20);
  const saved = readFileSync(path.join(dataDir, 'state.json'), 'utf8');
  assert.ok(!saved.includes('PRIVATE_BINDING'));
  assert.ok(!saved.includes('PRIVATE_ROUTE'));
  assert.ok(!JSON.stringify(publicEvents).includes('PRIVATE_EVENT'));
});

test('ready-stage refusal retires the admitted GPU and preserves its estimated receipt', async t => {
  const { app, seen } = fixture(t, { prepare: (_goal, { stage }) => {
    if (stage === 'ready') throw unavailable('provider');
    return Object.freeze({ fixtureSource: true });
  } });
  const goal = await app.chat('Private readiness fixture', { privateH100: true });
  const result = await app.wait(goal.id);
  assert.equal(result.status, 'queued');
  assert.equal(seen.startup, 1);
  assert.equal(seen.retirement, 1);
  assert.equal(seen.executions, 0);
  assert.equal(result.privateCompute.cleanupStatus, 'verified');
  assert.equal(result.spentUsd, 0.08);
  assert.equal(result.pendingUsd, 0);
});

test('later company refusal preserves accepted usage and pauses instead of automatically replaying work', async t => {
  const { app, seen } = fixture(t, { execute: ({ goal }, sink) => {
    sink({ type: 'usage', goalId: goal.id, usage: { costKind: 'reported', costUsd: 0.02 } });
    throw unavailable('provider');
  } });
  const goal = await app.chat('Hold a partially accepted fixture');
  const result = await app.wait(goal.id);
  assert.equal(result.status, 'paused');
  assert.equal(result.spentUsd, 0.02);
  await app.discover();
  assert.equal(seen.executions, 1);
});

test('restart fences a queued company whose GPU startup or cleanup has an unresolved receipt', async t => {
  const { app, dataDir, providers, swarm, seen } = fixture(t, { noAdmission: true });
  const goal = await app.chat('Interrupted private preparation fixture');
  await app.wait(goal.id); await app.close();
  const file = path.join(dataDir, 'state.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(saved.goals[0], { status: 'queued', execution: { requested: 'company', readiness: 'checking' },
    privateH100: true, pendingUsd: 6, privateCompute: { admissionId: 'fixture-gpu', reservedUsd: 6,
      reservationStatus: 'pending', cleanupStatus: 'not-started' } });
  saved.spend.pendingUsd = 6;
  writeFileSync(file, JSON.stringify(saved));
  const reopened = createRuntime({ dataDir, providers, swarm });
  try {
    await reopened.discover();
    const recovered = reopened.snapshot().goals[0];
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.recoveryHold, true);
    assert.equal(recovered.pendingUsd, 6);
    assert.equal(seen.startup, 0);
    assert.equal(seen.executions, 0);
    await assert.rejects(reopened.controlGoal(goal.id, 'stop'), /uncertain/);
  } finally { await reopened.close(); }
});

test('unfinished saved topology-v2 goals require fresh company admission without relabelling terminal history', async t => {
  const { app, dataDir, providers, swarm, seen } = fixture(t, { noAdmission: true });
  const goal = await app.chat('Migrate an unfinished goal');
  await app.wait(goal.id); await app.close();
  const file = path.join(dataDir, 'state.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.goals[0].workerTopologyVersion = 2;
  saved.goals[0].maxWorkers = 5;
  saved.goals[0].conversationsPerWorker = 5;
  saved.goals[0].agentsPerWorker = 4;
  delete saved.goals[0].executionMode;
  saved.goals[0].execution = { requested: 'company', readiness: 'ready', verifiedWorkers: 5, verifiedChildConversations: 20 };
  saved.goals.push({ ...saved.goals[0], id: 'historical-result', status: 'completed', result: 'Earlier local result', execution: undefined });
  writeFileSync(file, JSON.stringify(saved));
  const reopened = createRuntime({ dataDir, providers, swarm });
  try {
    const initial = reopened.snapshot();
    assert.equal(initial.goals[0].executionMode, 'company');
    assert.equal(initial.goals[0].execution.readiness, 'blocked');
    assert.equal(initial.goals[0].execution.verifiedWorkers, 0);
    assert.equal(initial.goals[1].executionMode, undefined);
    assert.equal(initial.goals[1].execution, undefined);
    assert.equal(initial.goals[1].result, 'Earlier local result');
    await reopened.discover();
    assert.equal((await reopened.wait(goal.id)).status, 'queued');
    assert.equal(seen.executions, 0);
  } finally { await reopened.close(); }
});

for (const unknown of [false, true]) test(`unexpected ${unknown ? 'unknown' : 'known'} preflight failure preserves outcome without exposing private error detail`, async t => {
  const { app, dataDir, seen } = fixture(t, { prepare: () => {
    throw Object.assign(new Error('PRIVATE_SDK_PATH_AND_BEARER_MUST_NOT_ESCAPE'), unknown ? { code: 'UNKNOWN', unknown: true } : {});
  } });
  const events = []; app.subscribe(event => events.push(event));
  const goal = await app.chat('Private error handling fixture');
  const result = await app.wait(goal.id);
  assert.equal(result.status, unknown ? 'interrupted' : 'failed');
  assert.equal(Boolean(result.recoveryHold), unknown);
  assert.equal(seen.executions, 0);
  assert.equal(seen.startup, 0);
  assert.ok(!readFileSync(path.join(dataDir, 'state.json'), 'utf8').includes('PRIVATE_SDK_PATH'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE_SDK_PATH'));
});
