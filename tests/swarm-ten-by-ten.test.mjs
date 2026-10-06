import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../upstream/swarm-teams/fleet/controller.mjs';
import { buildSpecs } from '../upstream/swarm-teams/template/flows.mjs';
import { goalCapacity, fleetTopology, fleetExecutionLimits, staffOwnedTeam,
  verifiedLocalConversations, verifiedTeamStaffing } from '../src/swarm/fleet.mjs';
import { teamProfile } from '../src/swarm/team-profile.mjs';

const goal = { workerTopologyVersion: 3, maxWorkers: 10, conversationsPerWorker: 10, agentsPerWorker: 9 };
const childRead = (parent, count = 9) => ({ status: 200, body: { hasMore: false, total: count,
  items: Array.from({ length: count }, (_, i) => ({ id: `${parent}-child-${i}`, parentConversationId: parent, status: 'completed' })) } });

test('10x10 uses one nine-child gate and an exact ten-Worker tree; saved topologies retain their limits', () => {
  assert.deepEqual(goalCapacity({ workerTopologyVersion: 3 }), { maxWorkers: 10, conversationsPerWorker: 10, agentsPerWorker: 9 });
  assert.deepEqual(fleetTopology(goal, { workerCap: 10, relay: true }), {
    initialWorkers: 10, limits: { maxWorkers: 10, maxDepth: 2, maxChildren: 9, maxActiveRuns: 1 },
  });
  assert.throws(() => goalCapacity({ ...goal, maxWorkers: 11 }), /1 to 10/);
  assert.throws(() => goalCapacity({ ...goal, agentsPerWorker: 10 }), /0 to 9/);
  assert.throws(() => goalCapacity({ ...goal, conversationsPerWorker: 11, agentsPerWorker: 10 }));
  assert.throws(() => goalCapacity({ ...goal, workerTopologyVersion: 2 }), /1 to 6/);
  const limits = fleetExecutionLimits({ goal }).teamLimits;
  const specs = buildSpecs({ model: 'fixture-model', availableServers: ['filesystem', 'bash', 'fleet'], limits, specialists: teamProfile(goal) });
  const team = specs.find(spec => spec.name === 'swarm_team');
  assert.equal(team.nodes.filter(node => node.type === 'subflow').length, 1);
  assert.equal(team.nodes.find(node => node.type === 'subflow').concurrencyLimit, 9);
  assert.match(team.nodes.find(node => node.key === 'start').prompt, /independent_verifier/);
  assert.match(team.nodes.find(node => node.key === 'start').prompt, /adversarial_reviewer/);
});

test('ten original lead runs are reserved before execution; ninety completed original children make one hundred identities', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seagulled-ten-by-ten-'));
  const entries = [], provisioned = [];
  const controller = new Controller({ registryPath: path.join(dir, 'registry.json'),
    operatorToken: 'offline-fixture-operator-token-over-32-characters', publicUrl: 'http://127.0.0.1:1',
    remoteUrl: 'http://relay.fixture', maxRunsPerWorker: 1, specialists: teamProfile(goal),
    provisioner: {
      async provision(worker, _fleet, context) { provisioned.push(context); return { kind: 'fixture', workerId: worker.id }; },
      async connect(target) { return { client: { async runFlow({ conversationId }) {
        assert.equal(Object.values(controller.registry.state.workers).length, 11, 'ten Workers plus external Todd are reserved first');
        const children = verifiedLocalConversations(childRead(conversationId), conversationId, 9, { requireCompleted: true });
        entries.push({ workerId: target.workerId, leadConversationId: conversationId, children });
        return { conversationId, status: 'completed', output: 'Offline staffing fixture; no provider executed.' };
      } }, close: async () => undefined }; },
    },
  });
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  const record = controller.registry.createGoal({ id: 'ten-by-ten', text: 'Offline staffing fixture',
    limits: fleetTopology(goal, { workerCap: 10, relay: true }).limits, maxTotalWorkers: 10 });
  record.teamLimits = fleetExecutionLimits({ goal }).teamLimits;
  controller.registry.save();
  const root = controller.registry.reserve({ goalId: record.id, role: 'supervisor', name: 'Todd' }).worker;
  controller.registry.enroll(root.id, { kind: 'external', origin: 'http://127.0.0.1:1', workspace: 'fixture' });
  const { runs, lead } = staffOwnedTeam(controller, root, { workerCap: 10, localChildTarget: 9, task: 'Fixture assignment' });
  assert.equal(runs.length, 10);
  assert.equal(new Set(runs.map(run => controller.registry.worker(run.workerId).name)).size, 10);
  assert.ok(runs.every(run => /start_subflow_ tool exactly 9 times/.test(controller.registry.run(run.runId).task)));
  assert.ok(runs.every(run => /ROLE_ID/.test(controller.registry.run(run.runId).task)));
  assert.throws(() => controller.delegate(root, { name: 'extra', task: 'Overflow' }), /all 10 lifetime Workers/);
  await Promise.all([...controller.settled.values()]);
  assert.equal(provisioned.length, 10);
  assert.ok(provisioned.every(context => context.teamLimits.concurrency === 9 && context.specialists.id === 'todd_specialists_v1'));
  assert.equal(controller.registry.state.runs[runs[9].runId].state, 'completed');
  assert.throws(() => controller.startRun({ worker: controller.registry.worker(lead.workerId), startedBy: root.id, task: 'Replacement' }), /run limit/);
  assert.deepEqual(verifiedTeamStaffing(entries, 10, 9), {
    workerCount: 10, localConversationCount: 90, conversationCountVerified: 100, childCompletionVerified: true,
  });
  assert.throws(() => verifiedTeamStaffing(entries.slice(0, 9), 10, 9), /incomplete/);
  const duplicate = structuredClone(entries); duplicate[1].children[0].id = duplicate[0].children[0].id;
  assert.throws(() => verifiedTeamStaffing(duplicate, 10, 9), /repeats/);
  controller.registry.retire(runs[9].workerId);
  assert.throws(() => controller.delegate(root, { name: 'replacement', task: 'Retired slot' }), /retired slots cannot be replaced/);
  await controller.close();
  const restarted = new Controller({ registryPath: path.join(dir, 'registry.json'), operatorToken: 'offline-fixture-operator-token-over-32-characters', publicUrl: 'http://127.0.0.1:1' });
  try { assert.throws(() => restarted.delegate(restarted.registry.worker(root.id), { name: 'replacement', task: 'After restart' }), /retired slots cannot be replaced/); }
  finally { await restarted.close(); }
});

test('failed, running, unknown, missing, extra and repeated child records cannot verify 10x10 staffing', () => {
  for (const status of ['failed', 'running', 'unknown', undefined]) {
    const read = childRead('original-lead'); read.body.items[8].status = status;
    assert.throws(() => verifiedLocalConversations(read, 'original-lead', 9, { requireCompleted: true }), /not completed successfully/);
  }
  for (const count of [8, 10]) assert.throws(() => verifiedLocalConversations(childRead('original-lead', count), 'original-lead', 9, { requireCompleted: true }), /exactly 9/);
  const duplicate = childRead('original-lead'); duplicate.body.items[8].id = duplicate.body.items[0].id;
  assert.throws(() => verifiedLocalConversations(duplicate, 'original-lead', 9, { requireCompleted: true }), /invalid/);
  const incomplete = childRead('original-lead'); incomplete.body.hasMore = true;
  assert.throws(() => verifiedLocalConversations(incomplete, 'original-lead', 9, { requireCompleted: true }), /did not confirm/);
});
