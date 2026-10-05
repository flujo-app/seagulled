// Source-only template checks. These fixtures do not contact a provider or Fly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecs, FLOW_NAMES } from '../template/flows.mjs';
import { CASE_SPECIALISTS_V1 } from '../template/specialists.mjs';
import { installTemplate } from '../install.mjs';

const availableServers = ['bash', 'filesystem', 'browser', 'flujo', 'fleet'];

test('optional specialist profile keeps the recovered three flows and one shared local gate', () => {
  const ordinary = buildSpecs({ model: 'fixture-model', availableServers });
  const specialized = buildSpecs({ model: 'fixture-model', availableServers,
    specialists: CASE_SPECIALISTS_V1, limits: { agentTurns: 6, leadTurns: 12, concurrency: 10 } });
  assert.deepEqual(specialized.map((flow) => flow.name), [FLOW_NAMES.agent, FLOW_NAMES.team, FLOW_NAMES.supervisor]);
  assert.equal(ordinary[1].nodes.filter((node) => node.type === 'subflow').length, 1);
  assert.equal(ordinary[1].nodes.find((node) => node.type === 'subflow').concurrencyLimit, 10);
  for (const flow of specialized.slice(1)) {
    assert.equal(flow.nodes.filter((node) => node.type === 'subflow').length, 1,
      'roles share the existing bounded queue rather than creating independent gates');
    assert.equal(flow.nodes.find((node) => node.type === 'subflow').concurrencyLimit, 9,
      'nine specialist subflows share one bounded node; the lead is the tenth conversation');
    assert.match(flow.nodes[0].prompt, /independent_verifier/);
    assert.match(flow.nodes[0].prompt, /adversarial_reviewer/);
    assert.match(flow.nodes[0].prompt, /CASE_ID, AGENT_ID, ROLE_ID/);
  }
  assert.equal(specialized[0].nodes[1].maxTurns, 6);
  assert.equal(specialized[1].nodes[1].maxTurns, 12);
  assert.equal(specialized[0].nodes[1].model, 'fixture-model');
  assert.match(specialized[0].nodes[0].prompt, /context_mapper/);
  assert.deepEqual(specialized[0].nodes[1].servers.map((server) => server.name), availableServers);
  assert.doesNotMatch(ordinary[0].nodes[0].prompt, /SPECIALIST PROFILE/);
  assert.equal(CASE_SPECIALISTS_V1.topologyTarget.workers *
    (1 + CASE_SPECIALISTS_V1.topologyTarget.specialistSubflowsPerWorker), 100);
});

test('specialist profile rejects an unconnected required tool or per-role binding without installing a workspace', async () => {
  assert.throws(() => buildSpecs({ model: 'fixture-model', availableServers: ['bash'],
    specialists: CASE_SPECIALISTS_V1 }), /requires connected server/);
  const invalid = structuredClone(CASE_SPECIALISTS_V1);
  invalid.roles[0].model = 'unapproved-other-model';
  let mutated = false;
  await assert.rejects(installTemplate({ ensureWorkspace: async () => { mutated = true; } },
    { model: { id: 'fixture-model' }, specialists: invalid }), /Per-role model or tool bindings need a shared scheduler/);
  assert.equal(mutated, false);
});

test('installer saves only the existing three specialized FlowSpecs', async () => {
  const saved = [];
  const client = {
    workspace: 'fixture-specialists',
    ensureWorkspace: async () => true,
    servers: async () => availableServers.map((name) => ({ name, disabled: false })),
    saveFlowSpec: async (spec) => { saved.push(spec); return { id: spec.name, name: spec.name }; },
  };
  const installed = await installTemplate(client, { model: { id: 'fixture-model' }, browser: false,
    specialists: CASE_SPECIALISTS_V1, limits: { agentTurns: 6, leadTurns: 12, concurrency: 10 } });
  assert.equal(saved.length, 3);
  assert.deepEqual(Object.keys(installed.flows), [FLOW_NAMES.agent, FLOW_NAMES.team, FLOW_NAMES.supervisor]);
  assert.equal(saved[1].nodes.find((node) => node.type === 'subflow').concurrencyLimit, 9);
  assert.equal(saved[0].nodes[1].model, 'fixture-model');
});
