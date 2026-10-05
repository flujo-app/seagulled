import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.mjs';

function fixture(t, { enableFailure, cleanupFailure, deferredStartup, deferredCleanup, requestReceipt } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-gpu-lifecycle-'));
  let runtime, sink, startupResolve, cleanupResolve, enabled = false, executions = 0;
  const calls = [];
  const providers = {
    publicState: () => [{ id: 'private-h100', available: true, connected: enabled, ready: enabled }],
    async discover() { return this.publicState(); },
    async privateComputeState() { return { provisionable: true, admission: { enableUsd: 6 } }; },
    async privateComputeEnable({ admissionId, budgetUsd, workerAllowed }) {
      const saved = JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
      assert.equal(saved.goals[0].privateCompute.admissionId, admissionId);
      assert.equal(saved.goals[0].pendingUsd, 6);
      assert.equal(saved.spend.pendingUsd, 6);
      assert.equal(workerAllowed, true); assert.equal(budgetUsd, 50);
      calls.push('enable');
      if (deferredStartup) await new Promise(resolve => { startupResolve = resolve; });
      if (enableFailure) throw enableFailure;
      enabled = true;
      return { ready: true, reservation: { id: admissionId, amountUsd: 6 }, usage: { costKind: 'estimated', costUsd: 1.25 } };
    },
    privateComputeLeaseGoal(goalId) { calls.push(`lease:${goalId}`); },
    async privateComputeDisable({ goalId, signal }) {
      assert.equal(signal, undefined); calls.push(`retire:${goalId}`);
      if (deferredCleanup) await new Promise(resolve => { cleanupResolve = resolve; });
      if (cleanupFailure) throw new Error('Fixture cleanup outcome unknown.');
      enabled = false;
      return enableFailure ? { status: 'unknown', cleanupVerified: true } : { status: 'retired' };
    },
  };
  const swarm = { setEventHandler(handler) { sink = handler; }, async execute({ goal }) {
    executions++;
    assert.equal(goal.pendingUsd, 0); assert.equal(goal.spentUsd, 1.25);
    assert.ok(calls.includes(`lease:${goal.id}`));
    if (requestReceipt) {
      const reservation = { id: 'fixture-request', amountUsd: 2.5 };
      sink({ type: 'reservation', goalId: goal.id, reservation });
      sink({ type: 'reservation', goalId: goal.id, reservation });
      assert.equal(JSON.parse(readFileSync(path.join(dataDir, 'state.json'), 'utf8')).goals[0].pendingUsd, 2.5);
      const usage = { ...requestReceipt, reservationId: reservation.id };
      sink({ type: 'usage', goalId: goal.id, usage }); sink({ type: 'usage', goalId: goal.id, usage });
      if (requestReceipt.costKind === 'unknown') throw Object.assign(new Error('Fixture request outcome unknown.'), { code: 'UNKNOWN', unknown: true, usageRecorded: true });
    }
    return { text: 'Fixture goal complete.' };
  } };
  runtime = createRuntime({ dataDir, providers, swarm });
  t.after(async () => { await runtime.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { runtime, calls, get executions() { return executions; }, releaseStartup() { startupResolve(); }, releaseCleanup() { cleanupResolve(); } };
}

test('private Go reserves before mutation, estimates once, leases one goal and retires before completion', async t => {
  const f = fixture(t);
  const goal = await f.runtime.chat('Build a fixture project.', { privateH100: true });
  const result = await f.runtime.wait(goal.id);
  assert.equal(result.status, 'completed'); assert.equal(result.privateCompute.cleanupStatus, 'verified');
  assert.equal(result.pendingUsd, 0); assert.equal(f.executions, 1);
  assert.equal(f.runtime.snapshot().spend.estimatedUsd, 1.25);
  assert.equal(f.runtime.snapshot().spend.reportedUsd, 0);
  assert.deepEqual(f.calls, ['enable', `lease:${goal.id}`, `retire:${goal.id}`]);
});

test('uncertain startup preserves its allowance and replay hold even when owned cleanup is confirmed', async t => {
  const f = fixture(t, { enableFailure: Object.assign(new Error('Fixture lost response.'), { unknown: true, code: 'UNKNOWN' }) });
  const goal = await f.runtime.chat('Build with an uncertain startup.', { privateH100: true });
  const result = await f.runtime.wait(goal.id);
  assert.equal(result.status, 'interrupted'); assert.equal(result.recoveryHold, true);
  assert.equal(result.pendingUsd, 6); assert.equal(result.privateCompute.reservationStatus, 'unknown');
  assert.equal(result.privateCompute.cleanupStatus, 'verified'); assert.equal(f.executions, 0);
  assert.equal(f.runtime.snapshot().spend.unknownCalls, 1);
  await assert.rejects(f.runtime.controlGoal(goal.id, 'resume'), /reconciliation/);
});

test('unconfirmed owned cleanup prevents a completed result from clearing the recovery hold', async t => {
  const f = fixture(t, { cleanupFailure: true });
  const goal = await f.runtime.chat('Build with unconfirmed retirement.', { privateH100: true });
  const result = await f.runtime.wait(goal.id);
  assert.equal(result.status, 'interrupted'); assert.equal(result.privateCompute.cleanupStatus, 'unknown');
  assert.equal(result.recoveryHold, true);
});

test('pause during GPU startup settles the accepted preparation and retires without dispatching work', async t => {
  const f = fixture(t, { deferredStartup: true });
  const goal = await f.runtime.chat('Prepare then pause.', { privateH100: true });
  while (!f.calls.includes('enable')) await new Promise(resolve => setImmediate(resolve));
  await f.runtime.controlGoal(goal.id, 'pause'); f.releaseStartup();
  const result = await f.runtime.wait(goal.id);
  assert.equal(result.status, 'paused'); assert.equal(f.executions, 0);
  assert.equal(result.pendingUsd, 0); assert.equal(result.privateCompute.cleanupStatus, 'verified');
  assert.deepEqual(f.calls, ['enable', `retire:${goal.id}`]);
});

test('completed work is not announced as a completed private goal while resource retirement is unresolved', async t => {
  const f = fixture(t, { deferredCleanup: true });
  const goal = await f.runtime.chat('Complete then verify retirement.', { privateH100: true });
  while (!f.calls.includes(`retire:${goal.id}`)) await new Promise(resolve => setImmediate(resolve));
  const pending = f.runtime.snapshot();
  assert.equal(pending.goals[0].status, 'stopping');
  assert.equal(pending.goals[0].privateCompute.cleanupStatus, 'retiring');
  assert.equal(pending.conversation.some(message => message.text === 'Fixture goal complete.'), false);
  f.releaseCleanup();
  assert.equal((await f.runtime.wait(goal.id)).status, 'completed');
  assert.equal(f.runtime.snapshot().conversation.filter(message => message.text === 'Fixture goal complete.').length, 1);
});

test('a durably reserved private request settles exactly once from its matching terminal estimate', async t => {
  const f = fixture(t, { requestReceipt: { costKind: 'estimated', costUsd: 0.15 } });
  const goal = await f.runtime.chat('Make a bounded private request.', { privateH100: true });
  const result = await f.runtime.wait(goal.id);
  assert.equal(result.status, 'completed'); assert.equal(result.pendingUsd, 0);
  assert.equal(result.reservations['fixture-request'].status, 'settled');
  assert.equal(result.spentUsd, 1.4); assert.equal(f.runtime.snapshot().spend.reportedUsd, 0);
});

test('unknown private request receipt keeps its original hold without adding it twice', async t => {
  const f = fixture(t, { requestReceipt: { costKind: 'unknown', costUsd: null, reservedUsd: 2.5 } });
  const goal = await f.runtime.chat('Retain the uncertain request.', { privateH100: true });
  const result = await f.runtime.wait(goal.id);
  assert.equal(result.status, 'interrupted'); assert.equal(result.pendingUsd, 2.5);
  assert.equal(result.reservations['fixture-request'].status, 'unknown');
  assert.equal(result.privateCompute.cleanupStatus, 'verified');
  assert.equal(result.spentUsd, 1.25); assert.equal(f.runtime.snapshot().spend.unknownCalls, 1);
});
