import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.mjs';
import { createServer } from '../src/server.mjs';

function fixture(t, { connected = true, mode = 'complete', receipt, providerIds = ['fixture'] } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-runtime-'));
  let sink;
  let available = true;
  const providers = {
    async discover() { return this.publicState(); },
    publicState() { return providerIds.map(id => ({ id, name: 'Scripted fixture', available, connected, methods: ['key'] })); },
    async connect() { connected = true; }, async disconnect() { connected = false; },
  };
  const swarm = {
    setEventHandler(handler) { sink = handler; },
    async execute({ goal, signal }) {
      sink({ type: 'task', goalId: goal.id, task: { id: 'owned-task', role: 'developer', status: 'running' } });
      if (mode === 'wait') await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Owned process terminated'), { name: 'AbortError' })), { once: true }));
      if (mode === 'unknown') throw Object.assign(new Error('Remote response lost'), { code: 'UNKNOWN' });
      if (mode === 'denied') {
        available = false;
        throw Object.assign(new Error('Provider credits unavailable'), { outcome: 'not_applied' });
      }
      if (mode === 'slow-complete') await new Promise(resolve => setTimeout(resolve, 25));
      const usage = receipt ?? { costKind: 'reported', costUsd: 0.03, inputTokens: 10, outputTokens: 20 };
      sink({ type: 'usage', goalId: goal.id, usage });
      let artifacts;
      if (mode === 'artifact') {
        const workspace = path.join(dataDir, 'providers', 'workspaces', goal.id);
        mkdirSync(workspace, { recursive: true });
        const file = path.join(workspace, 'proof.txt'); writeFileSync(file, 'proof');
        artifacts = [{ path: file, bytes: 5, sha256: createHash('sha256').update('proof').digest('hex') }];
      }
      sink({ type: 'task', goalId: goal.id, task: { id: 'owned-task', role: 'developer', status: 'completed', ...(artifacts ? { artifacts } : {}) } });
      return { text: 'Checked fixture output', usage };
    },
  };
  const app = createRuntime({ executionMode: 'local', dataDir, providers, swarm });
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { app, dataDir, providers, swarm };
}

test('unlimited goals persist null allowance and require a finite budget when disabled', async t => {
  const { app, dataDir, providers, swarm } = fixture(t, { connected: false });
  const goal = await app.chat('Run without a planning allowance', { unlimited: true, budgetUsd: null });
  assert.equal(goal.maxWorkers, 10); assert.equal(goal.conversationsPerWorker, 10);
  assert.equal(goal.memoryMb, 4096); assert.equal(goal.budgetUsd, null);
  assert.equal(goal.budget.unlimited, true);
  await assert.rejects(app.updateGoal(goal.id, { unlimited: false }), /finite budget/);
  assert.equal(app.snapshot().goals[0].unlimited, true);
  await app.close();
  const reopened = createRuntime({ executionMode: 'local', dataDir, providers, swarm });
  try {
    assert.equal(reopened.snapshot().goals[0].budgetUsd, null);
    const edited = await reopened.updateGoal(goal.id, { budgetUsd: 100, unlimited: false, conversationsPerWorker: 2 });
    assert.equal(edited.budgetUsd, 100); assert.equal(edited.unlimited, false);
    assert.equal(edited.memoryMb, 1024);
  } finally { await reopened.close(); }
});

test('selecting a native provider clears the old private compute route flag', async t => {
  const { app } = fixture(t, { connected: false, providerIds: ['codex', 'private-h100'] });
  const goal = await app.chat('Select one provider', { privateH100: true });
  assert.equal(goal.privateH100, true);
  const edited = await app.updateGoal(goal.id, { providerId: 'codex', privateH100: false });
  assert.equal(edited.providerId, 'codex'); assert.equal(edited.privateH100, false);
});

test('swarm deletion preserves receipts and conversation across reopening and forbids revival', async t => {
  const { app, dataDir, providers, swarm } = fixture(t);
  const goal = await app.chat('Keep the original evidence');
  await app.wait(goal.id);
  const before = app.snapshot();
  const deleted = await app.deleteGoal(goal.id);
  assert.ok(deleted.deletedAt);
  assert.equal((await app.deleteGoal(goal.id)).deletedAt, deleted.deletedAt);
  assert.deepEqual(app.snapshot().conversation, before.conversation);
  assert.deepEqual(app.snapshot().spend, before.spend);
  assert.deepEqual(deleted.tasks, before.goals[0].tasks);
  await assert.rejects(app.controlGoal(goal.id, 'resume'), /deleted/);
  await assert.rejects(app.updateGoal(goal.id, { text: 'Revive' }), /deleted/);
  await app.close();
  const reopened = createRuntime({ executionMode: 'local', dataDir, providers, swarm });
  try { assert.equal(reopened.snapshot().goals[0].deletedAt, deleted.deletedAt); }
  finally { await reopened.close(); }
});

test('swarm deletion stops active execution before marking removal', async t => {
  const { app } = fixture(t, { mode: 'wait' });
  const goal = await app.chat('Stop my owned execution');
  const deleted = await app.deleteGoal(goal.id);
  assert.equal(deleted.status, 'stopped');
  assert.ok(deleted.deletedAt);
});

test('swarm deletion cannot conceal unknown outcomes or pending billing', async t => {
  const unknown = fixture(t, { mode: 'unknown' });
  const goal = await unknown.app.chat('Unknown original');
  await unknown.app.wait(goal.id);
  await assert.rejects(unknown.app.deleteGoal(goal.id), /reconciliation/);
  assert.equal(unknown.app.snapshot().goals[0].deletedAt, undefined);
  const pending = fixture(t, { receipt: { costKind: 'unknown', costUsd: null, reservedUsd: 0.5, billingPending: true } });
  const held = await pending.app.chat('Keep billing hold');
  await pending.app.wait(held.id);
  await assert.rejects(pending.app.deleteGoal(held.id), /reconciliation/);
  assert.equal(pending.app.snapshot().goals[0].deletedAt, undefined);
  assert.equal(pending.app.snapshot().goals[0].pendingUsd, 0.5);
});

test('swarm HTTP deletion requires session authentication and persists removal', async t => {
  const { app } = fixture(t, { connected: false });
  const goal = await app.chat('Remove queued card');
  const server = await createServer({ runtime: app });
  t.after(() => server.close());
  const url = `${server.url}/api/goals/${goal.id}`;
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 401);
  assert.equal(app.snapshot().goals[0].deletedAt, undefined);
  const response = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).deletedAt);
});

test('swarm planning API is authenticated and never creates work or alters spend', async t => {
  const { app } = fixture(t, { connected: false });
  const server = await createServer({ runtime: app });
  t.after(() => server.close());
  const before = app.snapshot();
  const url = `${server.url}/api/budget/plan`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ workers: 100, agents: 10, unlimited: true }) });
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.workers, 100); assert.equal(plan.memoryMb, 4096);
  assert.equal(plan.budgetUsd, null); assert.equal(plan.estimate.totalUsd, null);
  assert.deepEqual(app.snapshot(), before);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ workers: 101 }) })).status, 400);
});

test('durable goal and conversation count emitted usage once, not aggregate twice', async t => {
  const { app, dataDir, providers, swarm } = fixture(t);
  const goal = await app.chat('Build a checked output', { budgetUsd: 2 });
  assert.equal((await app.wait(goal.id)).status, 'completed');
  assert.equal(app.snapshot().spend.usd, 0.03);
  assert.equal(app.snapshot().goals[0].tasks.length, 1);
  await app.close();
  const reopened = createRuntime({ executionMode: 'local', dataDir, providers, swarm });
  assert.equal(reopened.snapshot().goals[0].result, 'Checked fixture output');
  assert.equal(reopened.snapshot().conversation.filter(m => m.role === 'user').length, 1);
  await reopened.close();
});

test('invalid monetary receipts stay unpriced and preserve pending spend across reopening', async t => {
  for (const costUsd of [null, undefined, '0', NaN, -1]) {
    const receipt = { costKind: 'reported', costUsd, inputTokens: 10, outputTokens: 20, reservedUsd: 0.5 };
    const { app, dataDir, providers, swarm } = fixture(t, { receipt });
    const goal = await app.chat('Complete with an unpriced receipt');
    assert.equal((await app.wait(goal.id)).status, 'completed');
    const state = app.snapshot();
    assert.equal(state.spend.usd, 0);
    assert.equal(state.spend.reportedUsd, 0);
    assert.equal(state.spend.unknownCalls, 1);
    assert.equal(state.spend.pendingUsd, 0.5);
    assert.deepEqual(state.goals[0].usage, { inputTokens: 10, outputTokens: 20, costKind: 'unknown' });
    await app.close();
    const reopened = createRuntime({ executionMode: 'local', dataDir, providers, swarm });
    assert.equal(reopened.snapshot().spend.unknownCalls, 1);
    assert.equal(reopened.snapshot().goals[0].pendingUsd, 0.5);
    assert.equal(reopened.snapshot().goals[0].billingPending, true);
    await reopened.close();
  }
});

test('an explicit numeric zero receipt remains reported rather than unpriced', async t => {
  const { app } = fixture(t, { receipt: { costKind: 'reported', costUsd: 0 } });
  const goal = await app.chat('Complete with a measured zero receipt');
  await app.wait(goal.id);
  assert.equal(app.snapshot().spend.unknownCalls, 0);
  assert.equal(app.snapshot().goals[0].usage.costKind, 'reported');
});

test('known provider denial refreshes availability without an unknown execution hold', async t => {
  const { app } = fixture(t, { mode: 'denied' });
  const first = await app.chat('Rejected account request');
  const result = await app.wait(first.id);
  assert.equal(result.status, 'failed');
  assert.equal(Boolean(result.recoveryHold), false);
  assert.equal(app.snapshot().providers[0].available, false);
  const next = await app.chat('A fresh goal waits for a working provider');
  assert.equal(next.status, 'queued');
  assert.equal(app.snapshot().spend.usd, 0);
  assert.equal(app.snapshot().spend.unknownCalls, 0);
});

test('explicit provider connection selects future goals and survives reopening without changing existing goals', async t => {
  const { app, dataDir, providers, swarm } = fixture(t, { providerIds: ['native-first', 'selected-api'] });
  const original = await app.chat('Use discovered provider');
  await app.wait(original.id);
  assert.equal(app.snapshot().goals[0].providerId, 'native-first');
  await app.connect({ id: 'selected-api', method: 'key' });
  const selected = await app.chat('Use explicitly connected API');
  await app.wait(selected.id);
  assert.equal(app.snapshot().goals[1].providerId, 'selected-api');
  assert.equal(app.snapshot().goals[0].providerId, 'native-first');
  const explicit = await app.chat('Override this one goal', { providerId: 'native-first' });
  await app.wait(explicit.id);
  assert.equal(app.snapshot().goals[2].providerId, 'native-first');
  await app.close();
  const reopened = createRuntime({ executionMode: 'local', dataDir, providers, swarm });
  const next = await reopened.chat('Keep selected API');
  await reopened.wait(next.id);
  assert.equal(reopened.snapshot().goals[3].providerId, 'selected-api');
  await reopened.disconnect('selected-api');
  assert.equal(reopened.snapshot().preferredProviderId, undefined);
  await reopened.close();
});

test('queued goal waits for provider; budget and goal edit persist', async t => {
  const { app } = fixture(t, { connected: false });
  const goal = await app.chat('Original goal');
  assert.equal(goal.status, 'queued');
  await app.updateGoal(goal.id, { text: 'Edited goal', budgetUsd: 1.5 });
  await app.connect({ id: 'fixture', method: 'key' });
  const result = await app.wait(goal.id);
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'Edited goal'); assert.equal(result.budgetUsd, 1.5);
  await assert.rejects(app.updateGoal(goal.id, { budgetUsd: NaN }), /budget/);
});

test('pause requests a safe boundary and stop terminates owned execution', async t => {
  const { app } = fixture(t, { mode: 'wait' });
  const goal = await app.chat('Work until cancelled');
  assert.equal(app.snapshot().goals[0].status, 'running');
  const paused = await app.controlGoal(goal.id, 'pause');
  assert.equal(paused.status, 'pausing');
  assert.equal((await app.controlGoal(goal.id, 'stop')).status, 'stopped');
  await assert.rejects(app.controlGoal(goal.id, 'resume'), /paused/);
});

test('unknown remote execution holds new admission and refuses button-based clearing', async t => {
  const { app } = fixture(t, { mode: 'unknown' });
  const goal = await app.chat('Uncertain execution');
  const result = await app.wait(goal.id);
  assert.equal(result.status, 'interrupted'); assert.equal(result.recoveryHold, true);
  await assert.rejects(app.controlGoal(goal.id, 'resume'), /reconciliation/);
  await assert.rejects(app.controlGoal(goal.id, 'stop'), /uncertain/);
  const next = await app.chat('Another goal');
  assert.equal(next.status, 'queued'); assert.match(next.error, /reconciliation/);
});

test('reopening accepted running intent retains interrupted hold and never auto dispatches', async t => {
  const { app, dataDir, providers, swarm } = fixture(t);
  await app.close();
  const stored = JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  stored.goals.push({ id: 'accepted-original', text: 'Original', status: 'running', tasks: [], spentUsd: 0, budgetUsd: 5 });
  writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(stored));
  const recovered = createRuntime({ executionMode: 'local', dataDir, providers, swarm });
  await recovered.discover();
  assert.equal(recovered.snapshot().goals[0].status, 'interrupted');
  assert.equal(recovered.snapshot().goals[0].recoveryHold, true);
  await recovered.close();
});

test('single runtime owns state; corrupt state stays byte-exact', async t => {
  const { app, dataDir, providers, swarm } = fixture(t);
  assert.throws(() => createRuntime({ executionMode: 'local', dataDir, providers, swarm }), /already running/);
  await app.close();
  writeFileSync(path.join(dataDir, 'state.json'), '{broken');
  assert.throws(() => createRuntime({ executionMode: 'local', dataDir, providers, swarm }), /preserved/);
  assert.equal(readFileSync(path.join(dataDir, 'state.json'), 'utf8'), '{broken');
});

test('team pause fences new admission until explicit team resume', async t => {
  const { app } = fixture(t);
  await app.controlSwarm('pause');
  const goal = await app.chat('Wait behind the team pause');
  assert.equal(goal.status, 'queued');
  assert.equal(app.snapshot().swarm.admissionPaused, true);
  await assert.rejects(app.controlGoal(goal.id, 'resume'), /team is paused/);
  await app.controlSwarm('resume');
  assert.equal((await app.wait(goal.id)).status, 'completed');
  assert.equal(app.snapshot().swarm.admissionPaused, false);
});

test('graceful pause retains terminal usage before fencing the next task', async t => {
  const { app } = fixture(t, { mode: 'slow-complete' });
  const goal = await app.chat('Pause at a saved receipt');
  assert.equal((await app.controlGoal(goal.id, 'pause')).status, 'pausing');
  const result = await app.wait(goal.id);
  assert.equal(result.status, 'paused');
  assert.equal(result.tasks[0].status, 'completed');
  assert.equal(result.spentUsd, 0.03);
  assert.equal(result.recoveryHold, undefined);
});

test('artifact download verifies owned scope and immutable receipt', async t => {
  const { app } = fixture(t, { mode: 'artifact' });
  const goal = await app.chat('Produce a downloadable file');
  const result = await app.wait(goal.id);
  const receipt = app.readArtifact(goal.id, 'owned-task', 0);
  assert.equal(Buffer.from(receipt.data, 'base64').toString(), 'proof');
  writeFileSync(result.tasks[0].artifacts[0].path, 'changed');
  assert.throws(() => app.readArtifact(goal.id, 'owned-task', 0), /changed after verification/);
  assert.throws(() => app.readArtifact(goal.id, 'owned-task', 2), /could not be found/);
});

test('local HTTP API authenticates reads, rejects foreign origins, and updates goals', async t => {
  const { app } = fixture(t, { connected: false });
  const service = await createServer({ runtime: app }); t.after(() => service.close());
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${service.url}/api/state`)).status, 401);
  assert.equal((await fetch(`${service.url}/api/state`, { headers: { ...headers, Origin: 'https://foreign.example' } })).status, 403);
  const created = await fetch(`${service.url}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ text: 'HTTP goal', budgetUsd: 3 }) });
  assert.equal(created.status, 202); const goal = await created.json();
  const edited = await fetch(`${service.url}/api/goals/${goal.id}`, { method: 'PATCH', headers, body: JSON.stringify({ budgetUsd: 2 }) });
  assert.equal(edited.status, 200); assert.equal((await edited.json()).budgetUsd, 2);
  const state = await fetch(`${service.url}/api/state`, { headers });
  assert.equal((await state.json()).goals.length, 1);
  const payload = Buffer.from(JSON.stringify({ text: 'café' }));
  const split = payload.indexOf(Buffer.from('é')) + 1;
  await new Promise((resolve, reject) => {
    const req = http.request(`${service.url}/api/chat`, { method: 'POST', headers }, res => {
      res.resume(); res.on('end', () => { assert.equal(res.statusCode, 202); resolve(); });
    });
    req.on('error', reject); req.write(payload.subarray(0, split)); setTimeout(() => req.end(payload.subarray(split)), 10);
  });
  assert.equal(app.snapshot().goals[1].text, 'café');
});
