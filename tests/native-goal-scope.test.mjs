import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.mjs';

// Actual runtime controls and persistence with synthetic provider/Source
// admission. These tests do not qualify Codex, an image or a live swarm.
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function equipment(t) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-native-goal-'));
  const started = gate(), done = gate();
  let scope, actor, route = { available: true, providerId: 'codex', model: { name: 'gpt-6-luna' }, verification: 'synthetic-only' };
  const providers = { publicState: () => [{ id: 'codex', available: true, connected: true }],
    async discover() { return this.publicState(); }, async fleetRoute() { return structuredClone(route); } };
  const swarm = {
    async prepareCompany(_goal, { stage }) { return stage === 'ready' ? { fleetRoute: structuredClone(route) } : {}; },
    async execute(input) { scope = input.nativeScope; actor = { goalId: input.goal.id }; started.resolve();
      await done.promise; return { text: 'Synthetic scope test only.' }; },
  };
  const app = createRuntime({ dataDir, providers, swarm });
  const goal = await app.chat('Offline native runtime fence test', { providerId: 'codex', model: 'gpt-6-luna', reasoningEffort: 'medium' });
  await started.promise;
  t.after(async () => {
    done.resolve(); await app.close();
    const target = path.resolve(dataDir), parent = path.resolve(tmpdir());
    assert.equal(path.dirname(target), parent);
    assert.match(path.basename(target), /^seagulled-native-goal-/);
    assert.equal(lstatSync(target).isSymbolicLink(), false);
    rmSync(target, { recursive: true, force: true });
  });
  return { app, dataDir, goal, scope, actor, done, revoke() { route = { ...route, available: false }; } };
}

test('actual job scope rejects another goal, revoked provider and retired execution before effects', async t => {
  const e = await equipment(t); let effects = 0;
  await e.scope.assertCurrent(e.actor);
  await assert.rejects(e.scope.commit(async () => { effects++; }, { goalId: 'other-goal' }));
  e.revoke();
  await assert.rejects(e.scope.commit(async () => { effects++; }, e.actor));
  assert.equal(effects, 0);
  assert.equal(e.app.snapshot().goals[0].recoveryHold, undefined);
  e.done.resolve(); await e.app.wait(e.goal.id);
  await assert.rejects(e.scope.assertCurrent(e.actor));
});

test('runtime serializes native mutation grants and does not persist private scopes or routes', async t => {
  const e = await equipment(t), firstStarted = gate(), releaseFirst = gate(); const order = [];
  const first = e.scope.commit(async () => { order.push('first'); firstStarted.resolve(); await releaseFirst.promise; order.push('first-finished'); }, e.actor);
  await firstStarted.promise;
  const second = e.scope.commit(async () => { order.push('second'); }, e.actor);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first']);
  releaseFirst.resolve(); await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'first-finished', 'second']);
  const saved = readFileSync(path.join(e.dataDir, 'state.json'), 'utf8');
  assert.ok(!saved.includes('synthetic-only')); assert.ok(!saved.includes('nativeScope'));
});

test('pause during an applied native callback durably retains uncertainty and prevents false completion', async t => {
  const e = await equipment(t), entered = gate(), finish = gate();
  const mutation = e.scope.commit(async () => { entered.resolve(); await finish.promise; }, e.actor);
  await entered.promise; await e.app.controlGoal(e.goal.id, 'pause'); finish.resolve();
  await assert.rejects(mutation, error => error.code === 'UNKNOWN');
  const saved = JSON.parse(readFileSync(path.join(e.dataDir, 'state.json'), 'utf8')).goals[0];
  assert.equal(saved.status, 'interrupted'); assert.equal(saved.recoveryHold, true);
  assert.equal(saved.nativeUncertainty.length, 1); assert.equal(e.scope.signal.aborted, true);
  e.done.resolve(); const terminal = await e.app.wait(e.goal.id);
  assert.equal(terminal.status, 'interrupted');
  await assert.rejects(e.app.controlGoal(e.goal.id, 'resume'), /reconciliation/);
});

test('failed callback records an unconfirmed outcome without inferring rollback or billed spend', async t => {
  const e = await equipment(t); let applied = false;
  await assert.rejects(e.scope.commit(async () => { applied = true; throw new Error('PRIVATE_SOURCE_ERROR'); }, e.actor), error => error.code === 'UNKNOWN');
  assert.equal(applied, true);
  const saved = readFileSync(path.join(e.dataDir, 'state.json'), 'utf8');
  assert.ok(!saved.includes('PRIVATE_SOURCE_ERROR'));
  assert.equal(e.app.snapshot().goals[0].spentUsd, 0);
  await assert.rejects(e.scope.commit(async () => {}, e.actor));
});

test('runtime ownership successor invalidates an existing scope before mutation', async t => {
  const e = await equipment(t), lock = path.join(e.dataDir, 'runtime.lock');
  const original = readFileSync(lock, 'utf8'); let effects = 0;
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, owner: 'successor-owner' }));
    await assert.rejects(e.scope.commit(async () => { effects++; }, e.actor));
    assert.equal(effects, 0);
  } finally { writeFileSync(lock, original); }
});
