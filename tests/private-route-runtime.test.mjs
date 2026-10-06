import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.mjs';

test('large requested topology persists and H100 is never selected without its explicit switch', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-private-route-'));
  let executions = 0;
  const providers = {
    publicState: () => [{ id: 'private-h100', connected: true, available: true }],
    async discover() { return this.publicState(); }, async connect() {},
  };
  const swarm = { async execute({ goal }) { executions++; return { text: `Fixture for ${goal.providerId}.` }; } };
  const runtime = createRuntime({ executionMode: 'local', dataDir, providers, swarm });
  t.after(async () => { await runtime.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await runtime.connect({ id: 'private-h100' });
  const ordinary = await runtime.chat('Build an ordinary project.');
  assert.equal(ordinary.budgetUsd, 50); assert.equal(ordinary.maxWorkers, 10);
  assert.equal(ordinary.conversationsPerWorker, 10); assert.equal(ordinary.agentsPerWorker, 9);
  assert.equal(ordinary.workerTopologyVersion, 3);
  assert.equal(ordinary.privateH100, false); assert.equal(ordinary.providerId, null); assert.equal(executions, 0);
  assert.equal(runtime.snapshot().goals[0].status, 'queued');
  await assert.rejects(runtime.chat('Bypass the switch.', { providerId: 'private-h100' }), /Enable private/);
  await assert.rejects(runtime.chat('Ambiguous staffing.', { conversationsPerWorker: 5, agentsPerWorker: 4 }), /one conversation/);
  const privateGoal = await runtime.chat('Use the private project model.', { privateH100: true });
  const finished = await runtime.wait(privateGoal.id);
  assert.equal(finished.providerId, 'private-h100'); assert.equal(finished.privateH100, true); assert.equal(executions, 1);
  await runtime.close();
  const reopened = createRuntime({ executionMode: 'local', dataDir, providers, swarm });
  try { assert.equal(reopened.snapshot().goals[1].privateH100, true); assert.equal(reopened.snapshot().goals[1].conversationsPerWorker, 10); }
  finally { await reopened.close(); }
});
