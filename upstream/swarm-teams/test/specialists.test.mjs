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

test('one total conversation installs a lead-only flow with no child subflow admission', async () => {
  const [agent, team, supervisor] = buildSpecs({ model: 'fixture-model', availableServers,
    limits: { concurrency: 0 } });
  assert.equal(agent.name, FLOW_NAMES.agent);
  for (const flow of [team, supervisor]) {
    assert.equal(flow.nodes.some((node) => node.type === 'subflow'), false);
    assert.equal(flow.edges.some((edge) => edge.to === 'agents'), false);
    assert.match(flow.nodes[0].prompt, /one lead conversation and no local agent subflows/);
  }
  const saved = [];
  await installTemplate({ workspace: 'lead-only', ensureWorkspace: async () => true,
    servers: async () => availableServers.map((name) => ({ name, disabled: false })),
    saveFlowSpec: async (spec) => { saved.push(spec); return { id: spec.name, name: spec.name }; } },
  { model: { id: 'fixture-model' }, browser: false, limits: { concurrency: 0 } });
  assert.equal(saved[1].nodes.some((node) => node.type === 'subflow'), false);
});

test('installed FLUJO inventory bounds real flow authoring tools in Worker specs', async () => {
  const saved = [];
  const inventory = ['read_flow', 'create_flow', 'get_flow_authoring_guide', 'validate_flow_spec'];
  const installed = await installTemplate({ workspace: 'partial-authoring', ensureWorkspace: async () => true,
    servers: async () => [{ name: 'flujo', disabled: false }, { name: 'filesystem', disabled: false }],
    serverTools: async () => ({ tools: inventory.map((name) => ({ name })) }),
    saveFlowSpec: async (spec) => { saved.push(spec); return { id: spec.name, name: spec.name }; } },
  { model: { id: 'fixture-model' }, browser: false, limits: { concurrency: 4 } });
  assert.deepEqual(installed.availableTools.flujo, inventory);
  const agentFlowTools = saved[0].nodes[1].servers.find((server) => server.name === 'flujo').tools;
  assert.deepEqual([...agentFlowTools].sort(), [...inventory].sort());
  assert.equal(agentFlowTools.includes('update_flow'), false);
  assert.match(saved[0].nodes[0].prompt, /Flow authoring is unavailable/);
  assert.equal(saved[1].nodes.find((node) => node.type === 'subflow').concurrencyLimit, 4);
  const complete = buildSpecs({ model: 'fixture-model', availableServers: ['flujo'],
    availableTools: { flujo: [...inventory, 'update_flow'] }, limits: { concurrency: 4 } });
  assert.ok(complete[0].nodes[1].servers[0].tools.includes('update_flow'));
  assert.ok(complete[1].nodes[1].servers[0].tools.includes('update_flow'));
  assert.match(complete[0].nodes[0].prompt, /read_flow first and use update_flow/);
});
