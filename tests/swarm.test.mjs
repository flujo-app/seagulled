import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const offlineCompany = (providers, options = {}) => {
  const dataDir = options.dataDir ?? directory();
  const accountDir = path.join(dataDir, 'account');
  mkdirSync(accountDir);
  const flyctlPath = path.join(dataDir, 'flyctl');
  writeFileSync(flyctlPath, 'offline fixture');
  writeFileSync(path.join(accountDir, 'config.yml'), 'offline fixture');
  providers.flyFleetLease = async () => ({ available: true, flyctlPath,
    flyConfigDir: accountDir, orgSlug: 'personal-fixture' });
  const sourceBinding = options.sourceBinding ?? { cloudSdkRoot: '/fixture/sdk', sourceOrigin: 'http://127.0.0.1:1',
    sourceInstanceDir: '/fixture/instances', sourceDataRoot: '/fixture/data', sourceAppRoot: '/fixture/app' };
  const swarm = new SwarmCoordinator({ providers, dataDir, fleet: 'auto', ...options,
    sourceProvider: options.sourceProvider ?? (async () => sourceBinding),
    sourceInspector: options.sourceInspector ?? (async () => ({ available: true, binding: sourceBinding })),
    readyInspector: options.readyInspector ?? (async () => ({ available: true })) });
  const admit = async (input) => {
    const source = await swarm.prepareCompany(input, { stage: 'source' });
    return swarm.prepareCompany(input, { stage: 'ready', priorAdmission: source });
  };
  return { swarm, admit, sourceBinding, dataDir };
};

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
  assert.deepEqual(events.filter((event) => event.type === 'task' && event.task.status === 'running'
    && ['working', 'reviewing'].includes(event.task.phase)).map((event) => event.task.phase),
  ['working', 'working', 'reviewing', 'working']);
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

test('a private request reservation survives an unknown inference outcome as pending usage', async () => {
  const providers = manager([]);
  const events = [];
  providers.run = async (input) => {
    providers.calls.push(input);
    assert.equal(events.filter((event) => event.type === 'reservation').length, 1,
      'private allowance is held before request submission');
    throw Object.assign(new Error('private response lost'), { outcome: 'unknown',
      reservation: { id: input.requestId, amountUsd: 2.5, kind: 'estimated-upper' } });
  };
  const swarm = new SwarmCoordinator({ providers, dataDir: directory(), onEvent: (event) => events.push(event) });
  await assert.rejects(swarm.execute({ goal: goal({ providerId: 'private-h100' }) }), /private response lost/);
  const receipt = Object.values(swarm.registry.state.runs).find((run) => run.goalId === 'goal-one');
  assert.equal(receipt.state, 'unknown');
  assert.equal(receipt.usage.costUsd, null);
  assert.equal(receipt.usage.costKind, 'unknown');
  assert.equal(receipt.usage.reservedUsd, 2.5);
  assert.equal(receipt.usage.billingPending, true);
  assert.equal(receipt.usage.reservationId, receipt.id);
  assert.equal(events.find((event) => event.type === 'reservation').reservation.id, receipt.id);
  assert.equal(providers.calls[0].requestId, receipt.id);
  assert.equal(providers.calls[0].goalId, 'goal-one');
  assert.equal(events.filter((event) => event.type === 'usage').length, 1);
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

test('invalid worker and per-worker agent settings create no provider or registry work', async () => {
  for (const patch of [{ maxWorkers: 7 }, { maxWorkers: 1.5 }, { conversationsPerWorker: 0 },
    { conversationsPerWorker: 11 }, { agentsPerWorker: 11 }, { agentsPerWorker: '3' }]) {
    const providers = manager([]);
    const swarm = new SwarmCoordinator({ providers, dataDir: directory() });
    await assert.rejects(swarm.execute({ goal: goal(patch) }), /must be an integer/);
    assert.equal(swarm.registry.state.goals['goal-one'], undefined);
    assert.equal(providers.calls.length, 0);
  }
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
  const result = await reopened.execute({ goal: goal({ text: 'Ship the changed feature', budgetUsd: 6,
    spentUsd: 0.2, maxWorkers: 3, agentsPerWorker: 4 }) });
  assert.equal(result.completed, true);
  assert.equal(result.tasks.length, 4);
  assert.deepEqual(providers.calls.map((call) => call.role), ['lead', 'developer', 'reviewer', 'lead']);
  assert.equal(providers.calls[1].maxUsd, 5.8);
  assert.equal(reopened.registry.goal('goal-one').limits.maxWorkers, 3);
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
  const sourceBinding = { cloudSdkRoot: '/fixture/sdk', sourceOrigin: 'http://127.0.0.1:1',
    sourceInstanceDir: '/fixture/instances', sourceDataRoot: '/fixture/data', sourceAppRoot: '/fixture/app' };
  const privateKey = 'fictional-private-key-never-saved';
  providers.fleetRoute = (providerId) => ({ available: true, providerId,
    model: { name: 'fixture-model', baseUrl: 'http://127.0.0.1:1/v1', apiKey: privateKey,
      provider: 'openai', adapter: 'openai-responses' }, verification: 'unverified', costPolicy: 'pending' });
  const { swarm, admit, dataDir } = offlineCompany(providers, { sourceBinding,
    fleetRunner: async (input) => {
      fleetCalls.push(input);
      input.onCompany({ verifiedWorkers: 6, verifiedChildConversations: 24 });
      return { available: true, text: 'Fly worker ran Node 22 and reported its output.',
        usage: { costUsd: null, costKind: 'unknown', reservedUsd: input.maxUsd, billingPending: true },
        sandbox: { kind: 'fly', workerId: 'fictional-fly-worker', retired: true, cleanupConfirmed: true },
        artifacts: [{ path: '/fictional/fly-result.txt', bytes: 42, sha256: 'a'.repeat(64), kind: 'run-result' }] };
    }, onEvent: (event) => events.push(event) });
  const input = goal({ maxWorkers: 6, conversationsPerWorker: 5,
    executionMode: 'company', workerTopologyVersion: 2 });
  const admission = await admit(input);
  await assert.rejects(swarm.execute({ goal: input, admission }), /spend is unknown/);
  assert.equal(fleetCalls.length, 1);
  assert.equal(fleetCalls[0].fleetRoute.providerId, 'fictional');
  assert.deepEqual(fleetCalls[0].sourceBinding, sourceBinding);
  assert.equal(fleetCalls[0].goal.maxWorkers, 6);
  assert.equal(fleetCalls[0].goal.conversationsPerWorker, 5);
  assert.equal(fleetCalls[0].goal.agentsPerWorker, 4);
  assert.equal(readFileSync(path.join(dataDir, 'swarm', 'registry.json'), 'utf8').includes(privateKey), false);
  assert.equal(readFileSync(path.join(dataDir, 'swarm', 'registry.json'), 'utf8').includes(sourceBinding.cloudSdkRoot), false);
  assert.equal(swarm.tasks('goal-one')[1].sandbox.kind, 'fly');
  assert.equal(swarm.tasks('goal-one')[1].artifacts[0].kind, 'run-result');
  assert.equal(events.find((event) => event.type === 'usage' && event.usage.billingPending)?.usage.reservedUsd, 4.8);
  assert.deepEqual(events.find((event) => event.type === 'company'), { type: 'company',
    goalId: 'goal-one', verifiedWorkers: 6, verifiedChildConversations: 24 });
  assert.deepEqual(providers.calls.map((call) => call.role), ['lead']);
});

test('private Fly admission reserves the full remaining allowance before cloud work', async () => {
  const providers = manager([JSON.stringify({ done: false, tasks: [{ task: 'Build with Workers' }] })]);
  providers.fleetRoute = (providerId, goalId) => ({ available: true, providerId, leaseGoalId: goalId,
    model: { name: 'offline-model', apiKey: 'offline-secret' } });
  const events = [];
  const { swarm, admit } = offlineCompany(providers, {
    fleetRunner: async (input) => {
      assert.equal(input.goal.workerTopologyVersion, 2);
      input.reserveCloud({ id: input.reservationId, amountUsd: input.maxUsd });
      assert.equal(events.filter((event) => event.type === 'reservation').length, 2,
        'native lead and Fly team each have a durable before-call reservation');
      return { available: true, text: 'Fixture Worker result', usage: {
        costUsd: null, costKind: 'unknown', reservedUsd: input.maxUsd,
        reservationId: input.reservationId, billingPending: true },
        sandbox: { kind: 'fly', workerCount: 5, conversationCountVerified: 25 } };
    }, onEvent: (event) => events.push(event) });
  const input = goal({ providerId: 'private-h100', budgetUsd: 10, maxWorkers: 5,
    workerTopologyVersion: 2, executionMode: 'company' });
  const admission = await admit(input);
  await assert.rejects(swarm.execute({ goal: input, admission }), /spend is unknown/);
  const reservations = events.filter((event) => event.type === 'reservation').map((event) => event.reservation);
  assert.equal(reservations.length, 2);
  assert.equal(reservations[0].amountUsd, 2.5);
  assert.equal(reservations[1].amountUsd, 9.8);
  assert.equal(reservations[1].id.endsWith('-fly'), true);
  assert.equal(events.filter((event) => event.type === 'usage' && event.usage.reservationId === reservations[1].id).length, 1);
  assert.equal(providers.calls.length, 1, 'the developer task did not submit a direct native request');
});

test('an unavailable or mismatched company route fails before the first provider call', async () => {
  for (const route of [{ available: false, detail: 'not qualified' },
    { available: true, providerId: 'other', model: { apiKey: 'wrong-provider-secret' } }]) {
    const providers = manager([]);
    providers.fleetRoute = () => route;
    let fleetCalls = 0;
    const { swarm } = offlineCompany(providers, {
      fleetRunner: async () => { fleetCalls++; throw new Error('wrong provider route'); } });
    const input = goal({ workerTopologyVersion: 2, executionMode: 'company' });
    const source = await swarm.prepareCompany(input, { stage: 'source' });
    await assert.rejects(swarm.prepareCompany(input, { stage: 'ready', priorAdmission: source }),
      (error) => error.code === 'COMPANY_UNAVAILABLE' && error.reasonCode === 'provider');
    await assert.rejects(swarm.execute({ goal: input }), (error) => error.code === 'COMPANY_UNAVAILABLE');
    assert.equal(fleetCalls, 0);
    assert.equal(providers.calls.length, 0);
    assert.equal(swarm.registry.state.goals[input.id], undefined);
  }
});

test('company account, topology, and source failure stop before lead spend or registry admission', async () => {
  const providers = manager([]);
  let sourceCalls = 0;
  const { swarm } = offlineCompany(providers, {
    sourceProvider: async () => { sourceCalls++; return null; },
    sourceInspector: async ({ sourceBinding }) => sourceBinding
      ? { available: true, binding: sourceBinding } : { available: false } });
  const verifiedLease = providers.flyFleetLease;
  providers.flyFleetLease = async () => ({ available: false });
  const input = goal({ executionMode: 'company', workerTopologyVersion: 2, maxWorkers: 5 });
  await assert.rejects(swarm.prepareCompany(input, { stage: 'source' }), (error) =>
    error.code === 'COMPANY_UNAVAILABLE' && error.reasonCode === 'account'
    && error.outcome === 'not_applied');
  assert.equal(sourceCalls, 0, 'unverified Fly identity cannot launch a source');
  providers.flyFleetLease = verifiedLease;
  await assert.rejects(swarm.prepareCompany({ ...input, maxWorkers: 7 }, { stage: 'source' }),
    (error) => error.reasonCode === 'capacity');
  await assert.rejects(swarm.prepareCompany(input, { stage: 'source' }), (error) =>
    error.code === 'COMPANY_UNAVAILABLE' && error.reasonCode === 'source');
  assert.equal(sourceCalls, 1);
  assert.equal(providers.calls.length, 0);
  assert.equal(swarm.registry.state.goals[input.id], undefined);
});

test('Stop cancels pending company source preparation without starting a lead call', async () => {
  const providers = manager([]);
  const controller = new AbortController();
  let waiting;
  const entered = new Promise((resolve) => { waiting = resolve; });
  const { swarm } = offlineCompany(providers, { sourceProvider: ({ signal }) => new Promise((_, reject) => {
    waiting();
    signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'),
      { name: 'AbortError' })), { once: true });
  }) });
  const input = goal({ executionMode: 'company', workerTopologyVersion: 2 });
  const pending = swarm.prepareCompany(input, { stage: 'source', signal: controller.signal });
  await entered;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(swarm.registry.state.goals[input.id], undefined);
  assert.equal(providers.calls.length, 0);
});

test('ready stage rejects a replaced source proof and another goal’s source lease', async () => {
  const providers = manager([]);
  providers.fleetRoute = (providerId) => ({ available: true, providerId,
    model: { name: 'offline-model', apiKey: 'offline-secret' } });
  let proofs = 0;
  const { swarm, sourceBinding } = offlineCompany(providers, {
    sourceInspector: async () => ++proofs === 1
      ? { available: true, binding: sourceBinding }
      : { available: true, binding: { ...sourceBinding, sourceOrigin: 'http://127.0.0.1:2' } } });
  const input = goal({ executionMode: 'company', workerTopologyVersion: 2 });
  const source = await swarm.prepareCompany(input, { stage: 'source' });
  await assert.rejects(swarm.prepareCompany(input, { stage: 'ready', priorAdmission: { ...source } }),
    (error) => error.reasonCode === 'source');
  await assert.rejects(swarm.prepareCompany(input, { stage: 'ready', priorAdmission: source }),
    (error) => error.reasonCode === 'source');
  assert.equal(providers.calls.length, 0);
  assert.equal(swarm.registry.state.goals[input.id], undefined);
});

test('an unavailable owned fleet cannot replay the lead or substitute a local developer call', async () => {
  const providers = manager([JSON.stringify({ done: false, tasks: [{ task: 'Build it' }] })]);
  providers.fleetRoute = (providerId) => ({ available: true, providerId,
    model: { name: 'offline-model', apiKey: 'offline-secret' } });
  let fleetCalls = 0;
  const { swarm, admit } = offlineCompany(providers, { fleetRunner: async () => {
    fleetCalls++;
    return { available: false, detail: 'private path that must not leak' };
  } });
  const input = goal({ executionMode: 'company', workerTopologyVersion: 2 });
  const admission = await admit(input);
  await assert.rejects(swarm.execute({ goal: input, admission }), (error) =>
    error.code === 'COMPANY_UNAVAILABLE' && error.reasonCode === 'unavailable'
    && !error.message.includes('private path'));
  assert.deepEqual(providers.calls.map((call) => call.role), ['lead']);
  assert.equal(fleetCalls, 1);
  assert.deepEqual(swarm.tasks(input.id).map((task) => task.status), ['completed', 'failed']);
  await assert.rejects(swarm.execute({ goal: input, admission }), (error) => error.code === 'COMPANY_UNAVAILABLE');
  assert.equal(providers.calls.length, 1);
  assert.equal(fleetCalls, 1);
});

test('a topology-v2 goal needs an explicit mode and an edited company goal needs fresh admission', async () => {
  const providers = manager([]);
  providers.fleetRoute = (providerId) => ({ available: true, providerId,
    model: { name: 'offline-model', apiKey: 'offline-secret' } });
  const { swarm, admit } = offlineCompany(providers);
  const implicit = goal({ workerTopologyVersion: 2 });
  await assert.rejects(swarm.execute({ goal: implicit }), (error) => error.code === 'COMPANY_UNAVAILABLE');
  assert.equal(swarm.registry.state.goals[implicit.id], undefined);
  const input = goal({ workerTopologyVersion: 2, executionMode: 'company' });
  const admission = await admit(input);
  assert.equal('verifiedModel' in admission, false, 'an offline ready fixture is not a catalog proof');
  await assert.rejects(swarm.execute({ goal: { ...input, budgetUsd: 6 }, admission }),
    (error) => error.code === 'COMPANY_UNAVAILABLE');
  assert.equal(swarm.registry.state.goals[input.id], undefined);
  assert.equal(providers.calls.length, 0);
});

test('a completed local registry goal cannot be relabelled as a company result', async () => {
  const providers = manager([JSON.stringify({ done: true, response: 'Local answer only.' })]);
  const dataDir = directory();
  const local = new SwarmCoordinator({ providers, dataDir });
  const localGoal = goal({ executionMode: 'local', workerTopologyVersion: 2 });
  assert.equal((await local.execute({ goal: localGoal })).text, 'Local answer only.');
  assert.equal(local.registry.goal(localGoal.id).executionMode, 'local');
  assert.equal(local.registry.goal(localGoal.id).workerTopologyVersion, 2);
  let sourceCalls = 0;
  const { swarm } = offlineCompany(providers, { dataDir,
    sourceProvider: async () => { sourceCalls++; return null; } });
  const companyGoal = { ...localGoal, executionMode: 'company' };
  await assert.rejects(swarm.prepareCompany(companyGoal, { stage: 'source' }),
    (error) => error.code === 'COMPANY_UNAVAILABLE');
  await assert.rejects(swarm.execute({ goal: companyGoal }),
    (error) => error.code === 'COMPANY_UNAVAILABLE');
  assert.equal(sourceCalls, 0);
  assert.equal(providers.calls.length, 1);
  assert.equal(swarm.registry.goal(localGoal.id).result, 'Local answer only.');
});

test('partial local work cannot become a company run or lose its original receipts', async () => {
  const providers = manager([JSON.stringify({ done: false, tasks: [{ task: 'Local task' }] }),
    Object.assign(new Error('Local developer failed'), { outcome: 'failed' })]);
  const dataDir = directory();
  const local = new SwarmCoordinator({ providers, dataDir });
  const localGoal = goal({ executionMode: 'local', workerTopologyVersion: 2 });
  await assert.rejects(local.execute({ goal: localGoal }), /Local developer failed/);
  const originalRuns = local.tasks(localGoal.id).map(({ status }) => status);
  assert.deepEqual(originalRuns, ['completed', 'failed']);
  const { swarm } = offlineCompany(providers, { dataDir });
  const companyGoal = { ...localGoal, executionMode: 'company' };
  await assert.rejects(swarm.prepareCompany(companyGoal, { stage: 'source' }),
    (error) => error.code === 'COMPANY_UNAVAILABLE');
  await assert.rejects(swarm.execute({ goal: companyGoal }),
    (error) => error.code === 'COMPANY_UNAVAILABLE');
  assert.deepEqual(swarm.tasks(localGoal.id).map(({ status }) => status), originalRuns);
  assert.equal(providers.calls.length, 2);
});

test('a genuine completed company goal remains an idempotent summary across restart', async () => {
  const providers = manager([
    JSON.stringify({ done: false, tasks: [{ task: 'Owned Worker task' }] }),
    'Reviewed the owned Worker output.',
    JSON.stringify({ done: true, response: 'Owned company result reviewed.' }),
  ]);
  providers.fleetRoute = (providerId) => ({ available: true, providerId,
    model: { name: 'offline-model', apiKey: 'offline-secret' } });
  const { swarm, admit, dataDir } = offlineCompany(providers, { fleetRunner: async () => ({
    available: true, text: 'Owned Worker completed its task.',
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.1, costKind: 'estimated' },
    sandbox: { kind: 'fly', verification: 'original-worker-hierarchy-v1', relayUsed: false,
      retired: true, cleanupConfirmed: true, bootCleanupConfirmed: true, relayCleanupConfirmed: true,
      workerCount: 1, initialWorkerCount: 1, localConversationCount: 4,
      conversationCountVerified: 5, teamLeadRuns: ['original-run'] },
  }) });
  const input = goal({ executionMode: 'company', workerTopologyVersion: 2 });
  const admission = await admit(input);
  const first = await swarm.execute({ goal: input, admission });
  assert.equal(first.text, 'Owned company result reviewed.');
  assert.equal(swarm.registry.goal(input.id).executionMode, 'company');
  assert.equal(swarm.registry.goal(input.id).workerTopologyVersion, 2);
  const calls = providers.calls.length;
  assert.equal((await swarm.execute({ goal: input })).text, first.text);
  const reopened = new SwarmCoordinator({ providers, dataDir });
  assert.equal((await reopened.execute({ goal: input })).text, first.text);
  assert.equal(providers.calls.length, calls, 'completed company history does not replay');
  await assert.rejects(reopened.execute({ goal: { ...input, text: 'A different submitted goal' } }),
    (error) => error.code === 'COMPANY_UNAVAILABLE');
  await assert.rejects(reopened.execute({ goal: { ...input, providerId: 'other' } }),
    (error) => error.code === 'COMPANY_UNAVAILABLE');
  const remote = Object.values(reopened.registry.state.runs).find((run) => run.sandbox?.kind === 'fly');
  delete remote.sandbox.verification;
  reopened.registry.save();
  await assert.rejects(reopened.execute({ goal: input }),
    (error) => error.code === 'COMPANY_UNAVAILABLE');
  assert.equal(providers.calls.length, calls, 'missing original proof cannot cause replay');
});

test('a lead done:true cannot complete a new company before the owned Worker runs', async () => {
  const providers = manager([JSON.stringify({ done: true, response: 'Host lead says done.' })]);
  providers.fleetRoute = (providerId) => ({ available: true, providerId,
    model: { name: 'offline-model', apiKey: 'offline-secret' } });
  let workerCalls = 0;
  const { swarm, admit } = offlineCompany(providers, { fleetRunner: async (input) => {
    workerCalls++;
    assert.match(input.task, /Ship a small feature/, 'the submitted goal is the Worker assignment');
    return { available: false };
  } });
  const input = goal({ executionMode: 'company', workerTopologyVersion: 2 });
  const admission = await admit(input);
  await assert.rejects(swarm.execute({ goal: input, admission }),
    (error) => error.code === 'COMPANY_UNAVAILABLE');
  assert.equal(workerCalls, 1);
  assert.deepEqual(providers.calls.map((call) => call.role), ['lead']);
  assert.equal(swarm.registry.goal(input.id).state, 'active');
  assert.deepEqual(swarm.tasks(input.id).map((task) => task.status), ['completed', 'failed']);
});

test('completed initial Workers plus verified subworkers count as one bounded company', async () => {
  const providers = manager([
    JSON.stringify({ done: false, tasks: [{ task: 'Run the company' }] }),
    'Reviewed the original Worker tree.',
    JSON.stringify({ done: true, response: 'Company tree verified.' }),
  ]);
  providers.fleetRoute = (providerId) => ({ available: true, providerId,
    model: { name: 'offline-model', apiKey: 'offline-secret' } });
  const sandbox = { kind: 'fly', verification: 'original-worker-hierarchy-v1', relayUsed: true,
    retired: true, cleanupConfirmed: true, bootCleanupConfirmed: true, relayCleanupConfirmed: true,
    workerCount: 7, initialWorkerCount: 5, localConversationCount: 28,
    conversationCountVerified: 35, teamLeadRuns: ['r-one', 'r-two', 'r-three', 'r-four', 'r-five'] };
  const { swarm, admit } = offlineCompany(providers, { fleetRunner: async () => ({
    available: true, text: 'Seven original Worker runs completed.',
    usage: { costUsd: 0.1, costKind: 'estimated' }, sandbox,
  }) });
  const input = goal({ executionMode: 'company', workerTopologyVersion: 2, maxWorkers: 5,
    conversationsPerWorker: 5, agentsPerWorker: 4 });
  const admission = await admit(input);
  assert.equal((await swarm.execute({ goal: input, admission })).text, 'Company tree verified.');
  assert.equal(swarm.registry.goal(input.id).state, 'done');
});

test('understaffed or excessive Worker proof cannot finish a company', async () => {
  for (const workers of [4, 11]) {
    const providers = manager([
      JSON.stringify({ done: false, tasks: [{ task: 'Run the company' }] }),
      'Reviewed the claimed Worker tree.',
      JSON.stringify({ done: true, response: 'Claimed company result.' }),
    ]);
    providers.fleetRoute = (providerId) => ({ available: true, providerId,
      model: { name: 'offline-model', apiKey: 'offline-secret' } });
    const sandbox = { kind: 'fly', verification: 'original-worker-hierarchy-v1', relayUsed: true,
      retired: true, cleanupConfirmed: true, bootCleanupConfirmed: true, relayCleanupConfirmed: true,
      workerCount: workers, initialWorkerCount: 5, localConversationCount: workers * 4,
      conversationCountVerified: workers * 5,
      teamLeadRuns: ['r-one', 'r-two', 'r-three', 'r-four', 'r-five'] };
    const { swarm, admit } = offlineCompany(providers, { fleetRunner: async () => ({
      available: true, text: 'Claimed remote result.', usage: { costUsd: 0.1, costKind: 'estimated' }, sandbox,
    }) });
    const input = goal({ executionMode: 'company', workerTopologyVersion: 2, maxWorkers: 5,
      conversationsPerWorker: 5, agentsPerWorker: 4 });
    const admission = await admit(input);
    await assert.rejects(swarm.execute({ goal: input, admission }),
      (error) => error.code === 'COMPANY_UNAVAILABLE');
    assert.equal(swarm.registry.goal(input.id).state, 'active');
  }
});
