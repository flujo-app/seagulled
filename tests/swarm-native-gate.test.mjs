import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../upstream/swarm-teams/fleet/controller.mjs';

const operatorToken = 'native-gate-fixture-operator-token-32-characters';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swarm-native-gate-'));
  const controller = new Controller({ registryPath: path.join(directory, 'registry.json'),
    operatorToken, publicUrl: 'http://127.0.0.1:1' });
  const registry = controller.registry;
  const goal = registry.createGoal({ id: 'goal-native-gate', text: 'Offline gate fixture' });
  const reserve = (parentId, name, ready = true) => {
    const { worker, token } = registry.reserve({ goalId: goal.id, parentId, name });
    if (ready) registry.enroll(worker.id, { kind: 'fly', app: `app-${name}`, org: 'fixture',
      machineId: `machine-${name}`, workspace: `workspace-${name}` });
    return { worker, token };
  };
  const supervisor = reserve(null, 'supervisor');
  const lead = reserve(supervisor.worker.id, 'lead');
  const sibling = reserve(supervisor.worker.id, 'sibling');
  const reserved = reserve(supervisor.worker.id, 'reserved', false);
  const run = registry.startRun({ workerId: lead.worker.id, startedBy: supervisor.worker.id,
    task: 'Original task', flowName: 'swarm_team' });
  registry.bindRunTarget(run.id, lead.worker.target);
  const claim = { runId: run.id, rootConversationId: run.conversationId,
    goalId: goal.id, workspace: lead.worker.target.workspace };
  const request = (token) => ({ headers: { authorization: `Bearer ${token}` } });
  const close = async () => {
    await controller.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { controller, registry, goal, supervisor, lead, sibling, reserved, run, claim, request, close };
};
const hasCode = (code) => (error) => error.code === code;

test('trusted native gate resolves only the original ready executing Worker and pinned private run', async () => {
  const f = fixture();
  try {
    const resolved = f.controller.resolveNativeOriginalRun(f.request(f.lead.token), f.claim);
    assert.deepEqual({
      workerId: resolved.workerId, fleetRunId: resolved.fleetRunId,
      rootConversationId: resolved.rootConversationId, goalId: resolved.goalId,
      workspace: resolved.workspace,
    }, {
      workerId: f.lead.worker.id, fleetRunId: f.run.id,
      rootConversationId: f.run.conversationId, goalId: f.goal.id,
      workspace: f.lead.worker.target.workspace,
    });
    assert.equal(Object.isFrozen(resolved), true);
    assert.equal(JSON.stringify(resolved).includes(f.lead.token), false);
    // This host gate does not consume a slot or claim child lineage. A live
    // parent and four later-proven children may all resolve the same root.
    assert.equal(Array.from({ length: 5 }, () =>
      f.controller.resolveNativeOriginalRun(f.request(f.lead.token), f.claim).fleetRunId)
      .every((id) => id === f.run.id), true);
  } finally { await f.close(); }
});

test('reserved, retired, assigning parent, sibling, operator and JSON identity claims fail closed', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(f.reserved.token), f.claim), hasCode('FORBIDDEN'));
    assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(f.supervisor.token), f.claim), hasCode('FORBIDDEN'));
    assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(f.sibling.token), f.claim), hasCode('FORBIDDEN'));
    assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(operatorToken), f.claim), hasCode('FORBIDDEN'));
    assert.throws(() => f.controller.resolveNativeOriginalRun({ headers: {} },
      { ...f.claim, actor: f.lead.worker.id }), hasCode('UNAUTHORIZED'));
    assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(f.lead.token),
      { ...f.claim, childConversationId: 'claimed-from-public-json' }), hasCode('INVALID'));
    const inheritedClaim = Object.create({ ...f.claim });
    assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(f.lead.token),
      inheritedClaim), hasCode('INVALID'));
    f.registry.retire(f.lead.worker.id);
    assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(f.lead.token), f.claim), hasCode('UNAUTHORIZED'));
  } finally { await f.close(); }
});

test('native gate rejects changed root, goal, run, workspace, target, duplicate root and non-running run', async () => {
  const f = fixture();
  try {
    for (const patch of [
      { rootConversationId: 'another-root' }, { goalId: 'another-goal' },
      { runId: 'r-unrelated' }, { workspace: 'another-workspace' },
    ]) {
      assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(f.lead.token),
        { ...f.claim, ...patch }));
    }
    f.lead.worker.target.machineId = 'replaced-machine';
    assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(f.lead.token), f.claim), hasCode('NATIVE_TARGET'));
    f.lead.worker.target.machineId = 'machine-lead';
    assert.equal(f.controller.resolveNativeOriginalRun(f.request(f.lead.token), f.claim).fleetRunId, f.run.id);
    f.registry.state.runs['r-collision'] = { ...f.run, id: 'r-collision' };
    assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(f.lead.token), f.claim), hasCode('NATIVE_ORIGIN'));
    delete f.registry.state.runs['r-collision'];
    f.registry.settleRun(f.run.id, { status: 'unknown', error: 'original outcome lost' });
    assert.throws(() => f.controller.resolveNativeOriginalRun(f.request(f.lead.token), f.claim));
  } finally { await f.close(); }
});

test('Controller pins its ready target before flow submission without creating a gateway route', async () => {
  const entered = deferred();
  const release = deferred();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swarm-native-submit-'));
  let controller;
  try {
    controller = new Controller({ registryPath: path.join(directory, 'registry.json'),
      operatorToken, publicUrl: 'http://127.0.0.1:1',
      provisioner: { connect: async () => ({ client: {
        runFlow: async ({ conversationId }) => {
          const run = Object.values(controller.registry.state.runs).find((item) => item.conversationId === conversationId);
          assert.ok(run.targetBinding?.digest, 'the exact target is saved before any flow submission');
          entered.resolve();
          await release.promise;
          return { status: 'completed', output: 'done' };
        },
      }, close: async () => undefined }) } });
    const goal = controller.registry.createGoal({ text: 'Bound before submission' });
    const { worker, token } = controller.registry.reserve({ goalId: goal.id });
    controller.registry.enroll(worker.id, { kind: 'fly', app: 'owned-fixture', org: 'fixture',
      machineId: 'machine-fixture', workspace: 'workspace-fixture' });
    const run = controller.startRun({ worker, startedBy: 'operator', task: 'work', flowName: 'swarm_team' });
    const job = controller.settled.get(run.id);
    await entered.promise;
    const savedBinding = JSON.parse(readFileSync(controller.registry.path, 'utf8'));
    assert.deepEqual(savedBinding.runs[run.id].targetBinding, run.targetBinding);
    assert.equal(controller.registry.bindRunTarget(run.id, worker.target), run);
    assert.throws(() => controller.registry.bindRunTarget(run.id,
      { ...worker.target, machineId: 'another-machine' }), hasCode('NATIVE_TARGET'));
    assert.equal(controller.resolveNativeOriginalRun({ headers: { authorization: `Bearer ${token}` } }, {
      runId: run.id, rootConversationId: run.conversationId, goalId: goal.id,
      workspace: worker.target.workspace,
    }).fleetRunId, run.id);
    release.resolve();
    await job;
    assert.equal(controller.registry.run(run.id).state, 'completed');
  } finally {
    release.resolve();
    await controller?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
