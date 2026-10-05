import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SwarmCoordinator } from '../src/swarm/index.mjs';

const directory = () => mkdtempSync(path.join(tmpdir(), 'seagulled-swarm-'));
const goal = (patch = {}) => ({ id: 'goal-one', text: 'Ship a small feature', budgetUsd: 5, spentUsd: 0,
  providerId: 'fictional', maxWorkers: 1, ...patch });
const manager = (responses) => ({
  publicState: () => [{ id: 'fictional', name: 'Fictional provider', available: true, connected: true }],
  calls: [],
  async run(input) {
    this.calls.push(input);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { text: next, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2, costKind: 'estimated' } };
  },
});

test('Todd delegates real provider work, reviews it, critiques it, and persists one usage receipt per call', async () => {
  const providers = manager([
    JSON.stringify({ done: false, tasks: [{ role: 'developer', task: 'Build feature A' }] }),
    'Implemented feature A with evidence.',
    'Review: feature A meets the request.',
    JSON.stringify({ done: true, response: 'Feature A was implemented and reviewed.' }),
  ]);
  const events = [];
  const dataDir = directory();
  const swarm = new SwarmCoordinator({ providers, dataDir, onEvent: (event) => events.push(event) });
  const result = await swarm.execute({ goal: goal() });
  assert.equal(result.text, 'Feature A was implemented and reviewed.');
  assert.deepEqual(providers.calls.map((call) => call.role), ['lead', 'developer', 'reviewer', 'lead']);
  assert.equal(result.tasks.length, 4);
  assert.deepEqual(result.tasks.map((task) => task.status), ['completed', 'completed', 'completed', 'completed']);
  assert.equal(events.filter((event) => event.type === 'usage').length, 4);
  assert.equal(result.usage.costUsd, 0.8);
  assert.deepEqual(providers.calls.map((call) => call.maxUsd), [5, 4.8, 4.6, 4.4]);
  assert.equal((await swarm.execute({ goal: goal() })).text, result.text, 'completed goal is read, not submitted twice');
  assert.equal(providers.calls.length, 4);
  const reopened = new SwarmCoordinator({ providers, dataDir });
  assert.equal((await reopened.execute({ goal: goal() })).tasks.length, 4);
  assert.equal(providers.calls.length, 4);
});

test('an unknown provider outcome holds admission and cannot replay on restart', async () => {
  const providers = manager([Object.assign(new Error('response lost'), { outcome: 'unknown' })]);
  const dataDir = directory();
  const swarm = new SwarmCoordinator({ providers, dataDir });
  await assert.rejects(swarm.execute({ goal: goal() }), /response lost/);
  assert.equal(swarm.tasks('goal-one')[0].status, 'unknown');
  const reopened = new SwarmCoordinator({ providers, dataDir });
  await assert.rejects(reopened.execute({ goal: goal() }), /uncertain provider call/);
  assert.equal(providers.calls.length, 1);
});

test('unknown spend stops subsequent paid work after the terminal receipt', async () => {
  const providers = manager([]);
  providers.run = async (input) => {
    providers.calls.push(input);
    return { text: JSON.stringify({ done: false, tasks: [{ task: 'Follow up' }] }),
      usage: { inputTokens: 10, outputTokens: 10, costUsd: null, costKind: 'unknown' } };
  };
  const swarm = new SwarmCoordinator({ providers, dataDir: directory() });
  await assert.rejects(swarm.execute({ goal: goal() }), /spend is unknown/);
  assert.equal(providers.calls.length, 1);
  assert.equal(swarm.tasks('goal-one')[0].status, 'completed');
});

test('an already aborted goal creates no registry work', async () => {
  const providers = manager([]);
  const swarm = new SwarmCoordinator({ providers, dataDir: directory() });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(swarm.execute({ goal: goal(), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(swarm.registry.state.goals['goal-one'], undefined);
  assert.equal(providers.calls.length, 0);
});

test('pause at a completed call resumes the exact next stage with edited goal and budget', async () => {
  const providers = manager([
    JSON.stringify({ done: false, tasks: [{ task: 'Build the original feature' }] }),
    'Built the edited feature.',
    'The changed feature is verified.',
    JSON.stringify({ done: true, response: 'The changed feature is complete.' }),
  ]);
  const dataDir = directory();
  const controller = new AbortController();
  const swarm = new SwarmCoordinator({ providers, dataDir, onEvent: (event) => {
    if (event.type === 'usage' && event.usage.taskId && providers.calls.length === 1) controller.abort();
  } });
  await assert.rejects(swarm.execute({ goal: goal(), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(providers.calls.length, 1);
  const reopened = new SwarmCoordinator({ providers, dataDir });
  const result = await reopened.execute({ goal: goal({ text: 'Ship the changed feature', budgetUsd: 6, spentUsd: 0.2 }) });
  assert.equal(result.completed, true);
  assert.equal(result.tasks.length, 4);
  assert.deepEqual(providers.calls.map((call) => call.role), ['lead', 'developer', 'reviewer', 'lead']);
  assert.equal(providers.calls[1].maxUsd, 5.8);
  assert.match(providers.calls[1].prompt, /changed feature/);
  assert.equal(providers.calls.filter((call) => call.role === 'lead' && call.prompt.includes('Return JSON with {"done"')).length, 1);
});

test('six calls across a correction cycle end in Todd review without extra submission', async () => {
  const providers = manager([
    JSON.stringify({ done: false, tasks: [{ task: 'First task' }] }),
    'First result.',
    'Needs a fix.',
    JSON.stringify({ done: false, response: 'Needs correction.', nextTask: 'Fix it' }),
    'Fixed it.',
    JSON.stringify({ done: false, response: 'Still unverified.' }),
  ]);
  const swarm = new SwarmCoordinator({ providers, dataDir: directory() });
  const result = await swarm.execute({ goal: goal() });
  assert.equal(result.completed, false);
  assert.equal(result.text, 'Still unverified.');
  assert.equal(providers.calls.length, 6);
  assert.deepEqual(providers.calls.map((call) => call.role), ['lead', 'developer', 'reviewer', 'lead', 'developer', 'lead']);
  const replay = await swarm.execute({ goal: goal() });
  assert.equal(replay.completed, false);
  assert.equal(providers.calls.length, 6);
});

test('one isolated Fly developer receipt holds further paid review while cloud allowance is unknown', async () => {
  const providers = manager([
    JSON.stringify({ done: false, tasks: [{ task: 'Measure a worker' }] }),
  ]);
  const fleetCalls = [];
  const events = [];
  const dataDir = directory();
  const privateKey = 'fictional-private-key-never-saved';
  providers.fleetRoute = (providerId) => ({ available: true, providerId,
    model: { name: 'fixture-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: privateKey,
      provider: 'openai', adapter: 'openai-responses' }, verification: 'unverified', costPolicy: 'pending' });
  const swarm = new SwarmCoordinator({ providers, dataDir, fleet: 'auto',
    fleetRunner: async (input) => {
      fleetCalls.push(input);
      return { available: true, text: 'Fly worker ran Node 22 and reported its output.',
        usage: { costUsd: null, costKind: 'unknown', reservedUsd: input.maxUsd, billingPending: true },
        sandbox: { kind: 'fly', workerId: 'fictional-fly-worker', retired: true, cleanupConfirmed: true },
        artifacts: [{ path: '/fictional/fly-result.txt', bytes: 42, sha256: 'a'.repeat(64), kind: 'run-result' }] };
    }, onEvent: (event) => events.push(event) });
  await assert.rejects(swarm.execute({ goal: goal() }), /spend is unknown/);
  assert.equal(fleetCalls.length, 1);
  assert.equal(fleetCalls[0].fleetRoute.providerId, 'fictional');
  assert.equal(readFileSync(path.join(dataDir, 'swarm', 'registry.json'), 'utf8').includes(privateKey), false);
  assert.equal(swarm.tasks('goal-one')[1].sandbox.kind, 'fly');
  assert.equal(swarm.tasks('goal-one')[1].artifacts[0].kind, 'run-result');
  assert.equal(events.find((event) => event.type === 'usage' && event.usage.billingPending)?.usage.reservedUsd, 4.8);
  assert.deepEqual(providers.calls.map((call) => call.role), ['lead']);
});

test('an unavailable or mismatched selected-provider route never invokes the fleet runner', async () => {
  for (const route of [{ available: false, detail: 'not qualified' },
    { available: true, providerId: 'other', model: { apiKey: 'wrong-provider-secret' } }]) {
    const providers = manager([
      JSON.stringify({ done: false, tasks: [{ task: 'Check locally' }] }),
      'Local provider completed the task.', 'Local review completed.',
      JSON.stringify({ done: true, response: 'Locally reviewed.' }),
    ]);
    providers.fleetRoute = () => route;
    let fleetCalls = 0;
    const events = [];
    const swarm = new SwarmCoordinator({ providers, dataDir: directory(), fleet: 'auto',
      fleetRunner: async () => { fleetCalls++; throw new Error('wrong provider route'); },
      onEvent: (event) => events.push(event) });
    const result = await swarm.execute({ goal: goal() });
    assert.equal(result.completed, true);
    assert.equal(fleetCalls, 0);
    assert.deepEqual(providers.calls.map((call) => call.role), ['lead', 'developer', 'reviewer', 'lead']);
    assert.ok(events.some((event) => event.type === 'task' && /continuing locally/.test(event.task.phase ?? '')));
  }
});
