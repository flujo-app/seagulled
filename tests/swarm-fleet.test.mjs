import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as factorySdk from 'flujo-factory';
import { boundFleetSource, assertFleetAccountCurrent, codexAuthFile, fleetExecutionLimits, fleetStatus, flyAccountLease, goalCapacity, isolatedFlyEnvironment,
  recordConfirmedQuotaHold, runFleetLeaf, turnFailure, verifiedLocalConversations, verifiedTeamStaffing, workerBrief, workerProgramForRoute } from '../src/swarm/fleet.mjs';
import { createFactoryFleetRunner } from '../src/swarm/factory.mjs';
import { teamProfile } from '../src/swarm/team-profile.mjs';
import { PRODUCT_WORKER_IMAGE, installedProductRuntime } from '../src/product-runtime.mjs';

const accountRef = `fly-account-sha256:${'a'.repeat(64)}`;
const roots = [];
process.once('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const fresh = (name = 'seagulled-fleet-') => { const root = mkdtempSync(path.join(tmpdir(), name)); roots.push(root); return root; };

function account(root) {
  const flyctlPath = path.join(root, process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
  const flyConfigDir = path.join(root, 'personal-fly');
  mkdirSync(flyConfigDir, { recursive: true });
  writeFileSync(flyctlPath, 'fixture executable');
  writeFileSync(path.join(flyConfigDir, 'config.yml'), 'fixture personal config');
  return { flyctlPath, flyConfigDir, orgSlug: 'personal-test', scope: 'private', accountRef };
}
function cloudHelpers(root) {
  const cloudSdkRoot = path.join(root, 'cloud-sdk');
  mkdirSync(path.join(cloudSdkRoot, 'lib'), { recursive: true });
  for (const name of ['process.mjs', 'machines.mjs', 'bridge.mjs', 'images.mjs']) writeFileSync(path.join(cloudSdkRoot, 'lib', name), 'export {};');
  return { cloudSdkRoot };
}
const openAiRoute = (extra = {}) => ({ available: true, providerId: 'openai', verification: 'unverified',
  model: { name: 'exact-model', baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-secret-key-value', provider: 'openai', adapter: 'openai-responses' }, ...extra });
const privateRoute = { available: true, providerId: 'private-h100', verification: 'inference-verified',
  costPolicy: 'estimated-gpu-seconds', ownedAttemptId: '11111111-2222-3333-4444-555555555555', leaseGoalId: 'owned-goal',
  model: { name: 'qwen3.8-27b', provider: 'openai', adapter: 'openai',
    baseUrl: 'https://owner-seagulled-qwen-a1b2c3d4e5f6.modal.run/v1', apiKey: 'owned-fixture-token' } };

/**
 * Stands in for FACTORY's fleet with the same methods. A script decides what each Worker does with
 * a message. Traces go to the same file the real fleet writes, so the runner reads them the same way.
 */
class FakeFleet {
  constructor(options, script) {
    Object.assign(this, { options, script, commands: [], calls: [], status: 'new', turns: new Map(), sequence: 0, stopped: false, retired: false, quiesced: [], disconnected: false, apps: [] });
    mkdirSync(options.directory, { recursive: true });
    this.traces = path.join(options.directory, 'traces.jsonl');
  }
  async deploy(plan, deployOptions) {
    this.plan = plan; this.deployOptions = deployOptions;
    if (this.script.deployFails) throw new Error('Machines refused');
    this.apps = [{ name: plan.app }];
    this.machines = Array.from({ length: plan.machines }, (_, index) => ({ id: `machine${index}`, name: `m${index}` }));
    this.agents = this.machines.flatMap((_, machine) => Array.from({ length: plan.agentsPerMachine }, (_, agent) => ({ id: `m${machine}-a${agent}`, thread: `thread-${machine}-${agent}` })));
    return this.snapshot();
  }
  snapshot() { return { machines: this.machines ?? [] }; }
  emit(source, kind, body) { appendFileSync(this.traces, `${JSON.stringify({ seq: ++this.sequence, source, kind, body })}\n`); }
  nativeRuntime(agent) {
    const turn = this.turns.get(agent.id);
    return { threadId: agent.thread, ...(turn ? { turnId: turn.id, turnStatus: turn.status } : {}), threadStatus: turn?.status === 'inProgress' ? 'active' : 'idle' };
  }
  async request(route) {
    assert.equal(route, '/operator/status');
    if (this.script.enrolFails) return { agents: [] };
    return { agents: (this.agents ?? []).map(agent => ({ id: agent.id, nativeRuntime: this.nativeRuntime(agent) })) };
  }
  async observe() {
    if (this.script.observeFailsOnce && !this.failedOnce) { this.failedOnce = true; throw new Error('proxy dropped'); }
    return { ...await this.request('/operator/status'), traceCollection: { complete: true } };
  }
  async command(agent, command) {
    assert.equal(command.action, 'message');
    this.commands.push({ agent, ...command });
    const round = this.commands.filter(entry => entry.agent === agent).length;
    const id = `turn-${agent}-${round}`;
    this.turns.set(agent, { id, status: 'inProgress' });
    const outcome = await this.script.onMessage?.({ fleet: this, agent, round, message: command.message });
    if (outcome === 'hold') return { accepted: true };
    this.turns.set(agent, { id, status: outcome ?? 'completed' });
    return { accepted: true };
  }
  async quiesce(options) { this.quiesced.push(options); if (this.script.quiesceFails) throw new Error('not stopped'); return { agents: this.agents?.length ?? 0 }; }
  async stop() { this.stopped = true; }
  async retire() { if (this.script.retireFails) throw new Error('retire refused'); this.retired = true; if (!this.script.appStaysListed) this.apps = []; }
  async disconnect() { this.disconnected = true; }
  async fly(args) {
    this.calls.push(args);
    if (args[0] === 'apps') return JSON.stringify(this.apps);
    assert.equal(args[0], 'machine'); assert.equal(args[1], 'exec');
    if (this.script.outputFails) return JSON.stringify({ exit_code: 1, stdout: '' });
    const bytes = Buffer.from(`output of ${args[2]}`);
    return JSON.stringify({ stdout: JSON.stringify({ version: 1, root: '/data/results', files: [{ relativePath: 'report.txt', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') }] }) });
  }
}
const honestWorker = ({ fleet, agent, round, message }) => {
  const child = n => fleet.emit(agent, 'item/completed', { item: { type: 'subflow', phase: 'done', conversationId: `${agent}-child-${n}`, status: 'completed', depth: 1 } });
  const children = /exactly (\d+) times/.exec(message)?.[1];
  for (let n = 0; n < Number(children ?? 0); n++) child(n);
  fleet.emit(agent, 'thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, outputTokens: 2 } } });
  fleet.emit(agent, 'item/completed', { item: { type: 'agentMessage', text: round === 2 ? `FINAL from ${agent}` : `report from ${agent}` } });
};
function company({ script = {}, goal = {}, route = openAiRoute(), root = fresh(), ...extra } = {}) {
  let fleet;
  const seen = { status: [], workers: [], company: [], reservations: [] };
  const input = { goal: { id: 'owned-goal', text: 'Build the thing', providerId: route.providerId, maxWorkers: 2, conversationsPerWorker: 3, workerTopologyVersion: 3, ...goal },
    task: 'ASSIGNMENT: build the thing', dataDir: path.join(root, 'data'), maxUsd: 5, fleetRoute: route, flyAccount: account(root), sourceBinding: cloudHelpers(root),
    assertFlyAccountCurrent: async () => true, loadSdk: async () => factorySdk, pollMs: 1, retryWindowMs: 10, image: 'docker.io/library/node@sha256:fixture', probeModel: async () => ({ available: true }),
    fleetFactory: options => (fleet = new FakeFleet(options, { onMessage: honestWorker, ...script })),
    onStatus: text => seen.status.push(text), onWorker: worker => seen.workers.push(worker), onCompany: value => seen.company.push(value), ...extra };
  return { input, seen, root, fleet: () => fleet };
}

test('goal capacity keeps its limits, and FACTORY runs at most nine local agents per Worker', () => {
  assert.deepEqual(goalCapacity({}), { maxWorkers: 10, conversationsPerWorker: 10, agentsPerWorker: 9 });
  assert.deepEqual(fleetExecutionLimits({ goal: { maxWorkers: 6, conversationsPerWorker: 5 } }), { workerCap: 6, teamLimits: { agentTurns: 6, leadTurns: 12, concurrency: 4 } });
  assert.deepEqual(goalCapacity({ agentsPerWorker: 10 }), { maxWorkers: 10, conversationsPerWorker: 11, agentsPerWorker: 10 }, 'a saved legacy goal keeps reading the same');
  for (const setting of [{ maxWorkers: 0 }, { maxWorkers: 101 }, { maxWorkers: 2.5 }, { conversationsPerWorker: 0 }, { conversationsPerWorker: 11 }, { agentsPerWorker: 11 }, { agentsPerWorker: '4' }]) {
    assert.throws(() => goalCapacity(setting), /must be an integer/);
  }
  assert.throws(() => goalCapacity({ conversationsPerWorker: 5, agentsPerWorker: 5 }), /disagree/);
  assert.throws(() => goalCapacity({ workerTopologyVersion: 4 }), /must be 1, 2 or 3/);
});

test('a saved goal with ten local agents is refused before anything is created', async () => {
  const c = company({ goal: { conversationsPerWorker: 11, agentsPerWorker: 10, workerTopologyVersion: 2 } });
  await assert.rejects(runFleetLeaf(c.input), error => error.outcome === 'not_applied');
  assert.equal(c.fleet(), undefined);
  assert.equal(existsSync(path.join(c.input.dataDir, 'fleet', 'owned-goal')), false);
});

test('the Fly account lease holds one verified personal config and drops inherited credentials', async () => {
  const root = fresh(); const lease = account(root);
  assert.deepEqual(await flyAccountLease({ flyFleetLease: async () => ({ available: true, ...lease, token: 'must not cross' }) }), lease);
  assert.deepEqual(isolatedFlyEnvironment(lease, { PATH: 'fixture-path', FLY_API_TOKEN: 'inherited', FLY_ACCESS_TOKEN: 'inherited', FLY_CONFIG_DIR: 'foreign', FLYCTL_PATH: 'foreign', OPENAI_API_KEY: 'foreign' }),
    { PATH: 'fixture-path', FLY_CONFIG_DIR: lease.flyConfigDir, FLYCTL_PATH: lease.flyctlPath });
  assert.equal(await flyAccountLease({ flyFleetLease: async () => ({ available: true, ...lease, flyConfigDir: path.join(root, 'missing') }) }), null);
  const c = company({ root });
  assert.deepEqual(await runFleetLeaf({ ...c.input, flyAccount: undefined }), { available: false, detail: 'A verified personal Fly sign-in, one selected personal organization, and the bundled Fly helper are required for isolated Workers.' });
  assert.equal(existsSync(path.join(c.input.dataDir, 'fleet')), false);
});

test('a stop blocks dispatch but a same-account check still permits cleanup', async () => {
  const lease = { accountRef, orgSlug: 'o' }, intent = { accountRef, org: 'o' }, stopped = AbortSignal.abort();
  await assert.rejects(assertFleetAccountCurrent({ lease, intent, assertCurrent: async () => true, signal: stopped }), { name: 'AbortError' });
  await assertFleetAccountCurrent({ lease, intent, assertCurrent: async () => true, signal: stopped, operation: 'cleanup' });
  await assert.rejects(assertFleetAccountCurrent({ lease, intent: { ...intent, org: 'other' }, assertCurrent: async () => true }), { code: 'UNKNOWN' });
  await assert.rejects(assertFleetAccountCurrent({ lease, intent, assertCurrent: async () => false }), { code: 'UNKNOWN' });
});

test('the installed package has the cloud helpers FACTORY needs', async () => {
  const installed = installedProductRuntime();
  assert.ok(installed?.cloudSdkRoot);
  const root = fresh();
  assert.equal((await boundFleetSource({ sourceBinding: installed, flyAccount: account(root) })).available, true);
  assert.equal((await boundFleetSource({ sourceBinding: { cloudSdkRoot: path.join(root, 'absent') }, flyAccount: account(root) })).available, false);
  assert.equal((await boundFleetSource({ sourceBinding: {}, flyAccount: account(root) })).available, false);
  assert.equal((await boundFleetSource({ sourceBinding: installed })).available, false);
  assert.match(PRODUCT_WORKER_IMAGE, /^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/);
  // The SDK this version needs must really be the one installed.
  assert.equal(typeof factorySdk.FactoryCloudLiteFleet, 'function');
  assert.equal(typeof factorySdk.packFactorySdk, 'function');
  assert.deepEqual(factorySdk.providerPrograms({ id: 'x-x', envKey: 'MODEL_KEY', model: 'm', apis: ['chat'], baseUrls: ['https://model.example/v1'] }), ['flujo']);
});

test('a real loopback model catalog must contain the exact model ID before readiness', async () => {
  let catalog = '{}';
  const server = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(catalog); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = fresh();
  const route = { available: true, providerId: 'private-h100', leaseGoalId: 'g', verification: 'inference-verified', costPolicy: 'estimated-gpu-seconds', ownedAttemptId: privateRoute.ownedAttemptId,
    model: { ...privateRoute.model } };
  // The route check needs an owned address, so a local one fails first; the catalog logic runs on an OpenAI-shaped fetch instead.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => originalFetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options);
  try {
    const ask = () => fleetStatus({ dataDir: root, providerId: 'private-h100', goalId: 'g', fleetRoute: route, flyAccount: account(root), sourceBinding: cloudHelpers(root) });
    for (catalog of ['null', '{}', '{"data":null}', '{"data":[]}', '{"data":[{"name":"qwen3.8-27b"}]}', '<html>not a catalog</html>']) {
      const status = await ask();
      assert.equal(status.available, false, `catalog ${catalog} cannot qualify model identity`);
      assert.equal(status.modelIdentityVerified, undefined);
    }
    catalog = '{"data":[{"id":"another-model"},{"id":"qwen3.8-27b"}]}';
    const ready = await ask();
    assert.equal(ready.available, true);
    assert.equal(ready.modelIdentityVerified, true);
  } finally { globalThis.fetch = originalFetch; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('company admission requires the exact selected provider binding before any probe or intent', async () => {
  const root = fresh(); const dataDir = path.join(root, 'data');
  const valid = openAiRoute();
  const originalFetch = globalThis.fetch; let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('no probe before the binding holds'); };
  try {
    for (const route of [undefined, { ...valid, providerId: 'anthropic' }, { ...valid, model: { ...valid.model, provider: 'anthropic' } },
      { ...valid, model: { ...valid.model, adapter: 'anthropic' } }, { ...valid, model: { ...valid.model, baseUrl: 'https://alternate.example/v1' } }]) {
      assert.equal((await fleetStatus({ dataDir, providerId: 'openai', fleetRoute: route, flyAccount: account(root), sourceBinding: cloudHelpers(root) })).available, false);
      const c = company({ root, route: route ?? valid });
      const result = await runFleetLeaf({ ...c.input, goal: { ...c.input.goal, providerId: 'openai' }, fleetRoute: route, dataDir });
      assert.equal(result.available, false);
      assert.equal(existsSync(path.join(dataDir, 'fleet')), false);
    }
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('the private route accepts only its verified owned endpoint, leased to this goal', async () => {
  const root = fresh(); const dataDir = path.join(root, 'data'); const flyAccount = account(root); const sourceBinding = cloudHelpers(root);
  const status = route => fleetStatus({ dataDir, providerId: 'private-h100', fleetRoute: route, goalId: 'owned-goal', flyAccount, sourceBinding });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }, { id: 'nemotron-3.5-super-vl' }] }));
  try {
    assert.equal((await status(privateRoute)).available, true);
    const nemotron = { ...privateRoute, model: { ...privateRoute.model, name: 'nemotron-3.5-super-vl', baseUrl: 'https://owner--seagulled-nemotron-a1b2c3d4e5f6-serve.modal.run/v1' } };
    assert.equal((await status(nemotron)).available, true);
    assert.equal((await fleetStatus({ dataDir, providerId: 'private-h100', fleetRoute: privateRoute, goalId: 'different-goal', flyAccount, sourceBinding })).available, false);
    for (const route of [{ ...privateRoute, providerId: 'openai' }, { ...privateRoute, verification: 'unverified' }, { ...privateRoute, ownedAttemptId: 'missing' },
      { ...privateRoute, model: { ...privateRoute.model, name: 'other-model' } }, { ...privateRoute, model: { ...privateRoute.model, name: 'nemotron-3.5-super-vl' } },
      { ...privateRoute, model: { ...privateRoute.model, baseUrl: 'https://original-project.modal.run/v1' } },
      { ...privateRoute, model: { ...privateRoute.model, baseUrl: 'http://owner-seagulled-qwen-a1b2c3d4e5f6.modal.run/v1' } }]) {
      assert.equal((await status(route)).available, false);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('a saved no-credits hold survives a model change without probing', async () => {
  const root = fresh(); const dataDir = path.join(root, 'data'); mkdirSync(path.join(dataDir, 'fleet'), { recursive: true });
  const oldModel = { name: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', apiKey: 'same-fixture-key' };
  const fingerprint = createHash('sha256').update(`${oldModel.baseUrl}\0${oldModel.name}\0${oldModel.apiKey}`).digest('hex').slice(0, 24);
  writeFileSync(path.join(dataDir, 'fleet', `model-admission-${fingerprint}.json`), JSON.stringify({ state: 'held', provider: 'openai-api', reason: 'no credits remaining' }));
  const route = openAiRoute({ model: { ...oldModel, name: 'another-model', provider: 'openai', adapter: 'openai-responses' } });
  const status = await fleetStatus({ dataDir, providerId: 'openai', fleetRoute: route, flyAccount: account(root), sourceBinding: cloudHelpers(root) });
  assert.equal(status.available, false);
  assert.match(status.detail, /no-credits hold/);
});

test('only an explicit no-credits failure holds an account, and the hold stores no provider text or key', async () => {
  const root = fresh(); const dataDir = path.join(root, 'data'); const model = openAiRoute().model;
  for (const failure of [{ status: 'failed', providerHttpStatus: 429, code: 'rate_limit_exceeded' }, { status: 'completed', providerHttpStatus: 429, code: 'insufficient_quota' }, { status: 'failed', providerHttpStatus: 500, message: 'no credits remaining' }]) {
    assert.equal(recordConfirmedQuotaHold({ dataDir, model, providerId: 'openai', goalId: 'g', workerId: 'm0-a0', failure }), false);
  }
  assert.equal(existsSync(path.join(dataDir, 'fleet')), false);
  const failure = { status: 'failed', providerHttpStatus: 429, code: 'insufficient_quota', message: 'sensitive provider body' };
  assert.equal(recordConfirmedQuotaHold({ dataDir, model, providerId: 'openai', goalId: 'g', workerId: 'm0-a0', failure }), true);
  const held = path.join(dataDir, 'fleet', `account-admission-${createHash('sha256').update(`${model.baseUrl}\0${model.apiKey}`).digest('hex').slice(0, 24)}.json`);
  const saved = readFileSync(held, 'utf8');
  assert.equal(saved.includes(model.apiKey), false); assert.equal(saved.includes('sensitive'), false);
  const status = await fleetStatus({ dataDir, providerId: 'openai', fleetRoute: openAiRoute(), flyAccount: account(root), sourceBinding: cloudHelpers(root) });
  assert.match(status.detail, /no-credits hold/);
  assert.deepEqual(turnFailure([{ source: 'm0-a0', kind: 'native.turn.completed', body: { turn: { status: 'failed', error: { code: 429 } } } },
    { source: 'm0-a0', kind: 'flujo/error', body: { code: 'insufficient_quota', message: 'body' } }, { source: 'other', kind: 'flujo/error', body: { code: 'x' } }], 'm0-a0'),
  { status: 'failed', providerHttpStatus: 429, code: 'insufficient_quota', message: 'body' });
});

test('each provider route maps to a FACTORY program, with the key outside the plan', () => {
  const limits = { localChildTarget: 2, teamLimits: { agentTurns: 6, leadTurns: 12 } };
  const openai = workerProgramForRoute(openAiRoute(), limits);
  assert.deepEqual(openai.plan.modelProvider, { id: 'openai', name: 'openai', envKey: 'SEAGULLED_MODEL_KEY', model: 'exact-model', baseUrls: ['https://api.openai.com/v1'], apis: ['responses'] });
  assert.equal(openai.key, 'fixture-secret-key-value');
  assert.equal(JSON.stringify(openai.plan).includes('fixture-secret-key-value'), false);
  assert.deepEqual(openai.plan.flujo, { agentTurns: 6, leadTurns: 12, teamConcurrency: 2 });
  assert.equal(openai.plan.agentsPerMachine, 1);
  assert.deepEqual(factorySdk.flujoProviderModel(openai.plan.modelProvider, { key: openai.key }).adapter, 'openai-responses');
  assert.deepEqual(workerProgramForRoute(privateRoute, limits).plan.modelProvider.apis, ['chat'], 'the private route stays on what it verified');
  const anthropic = workerProgramForRoute({ providerId: 'anthropic', model: { name: 'c', baseUrl: 'https://api.anthropic.com', apiKey: 'k', adapter: 'anthropic' } }, limits);
  assert.deepEqual(anthropic.plan.modelProvider.apis, ['anthropic']);
  const codex = workerProgramForRoute({ providerId: 'codex', model: { name: 'gpt-6-luna', provider: 'codex', adapter: 'codex-cli', apiKey: '', reasoningEffort: 'high' } }, limits);
  assert.equal(codex.plan.workerProgram, 'codex'); assert.equal(codex.plan.agentsPerMachine, 3); assert.equal(codex.members, 2); assert.equal(codex.key, undefined); assert.equal(codex.plan.reasoningEffort, 'high');
  for (const program of [openai, codex]) assert.equal(factorySdk.validateCloudLitePlan({ runId: 'plan-check', app: 'plan-check-app', goal: 'x', ...program.plan }).workerProgram, program.plan.workerProgram);
  assert.equal(codexAuthFile({ CODEX_HOME: path.join('x', 'y') }), path.join('x', 'y', 'auth.json'));
});

test('a Worker brief carries its angle, its staffing and where output goes', () => {
  const lead = workerBrief({ task: 'TASK', index: 0, workerCap: 3, localChildTarget: 4 });
  assert.match(lead, /coordinate 3 Worker Machines/); assert.match(lead, /exactly 4 times/); assert.match(lead, /\/data\/results/); assert.match(lead, /not read-only permission/);
  const child = workerBrief({ task: 'TASK', index: 2, workerCap: 3, localChildTarget: 4 });
  assert.match(child, /YOUR DISTINCT ANGLE: Develop and check/); assert.match(child, /m0-a0/);
  assert.match(workerBrief({ task: 'TASK', index: 0, workerCap: 1 }), /only its lead conversation/);
  assert.match(workerBrief({ task: 'TASK', index: 1, workerCap: 2, memberOf: 'm0-a0' }), /team member under m0-a0/);
  assert.throws(() => workerBrief({ task: 'T', index: 0, workerCap: 1, localChildTarget: 10 }), /0 to 9/);
  const profile = teamProfile({ workerTopologyVersion: 3, conversationsPerWorker: 10 }, factorySdk.CASE_SPECIALISTS_V1);
  assert.equal(profile.id, 'todd_specialists_v1');
  assert.equal(JSON.stringify(profile).includes('Savia'), false);
  assert.match(workerBrief({ task: 'T', index: 0, workerCap: 1, localChildTarget: 9, profile }), /nine roles/);
  assert.equal(teamProfile({ workerTopologyVersion: 2, conversationsPerWorker: 10 }, factorySdk.CASE_SPECIALISTS_V1), undefined);
});

test('local conversation receipts come from the Worker trace and must match exactly', () => {
  const done = (source, id, status = 'completed') => ({ source, kind: 'item/completed', body: { item: { type: 'subflow', phase: 'done', conversationId: id, status } } });
  assert.deepEqual(verifiedLocalConversations([done('a', 'x'), done('a', 'y'), done('b', 'z')], 'a', 2), [{ id: 'x', status: 'completed' }, { id: 'y', status: 'completed' }]);
  assert.throws(() => verifiedLocalConversations([done('a', 'x')], 'a', 2), error => error.outcome === 'failed' && /started 1 local/.test(error.message));
  assert.throws(() => verifiedLocalConversations([done('a', 'x', 'error')], 'a', 1, { requireCompleted: true }), /has not completed/);
  assert.deepEqual(verifiedLocalConversations([done('a', 'x', 'error')], 'a', 1), [{ id: 'x', status: 'error' }]);
  assert.throws(() => verifiedLocalConversations([done('a', '../bad')], 'a', 1), { code: 'UNKNOWN' });
  const entry = (workerId, lead, ids) => ({ workerId, leadConversationId: lead, children: ids.map(id => ({ id, status: 'completed' })) });
  assert.deepEqual(verifiedTeamStaffing([entry('w1', 'l1', ['a']), entry('w2', 'l2', ['b'])], 2, 1), { workerCount: 2, localConversationCount: 2, conversationCountVerified: 4, childCompletionVerified: true });
  assert.throws(() => verifiedTeamStaffing([entry('w1', 'l1', ['a']), entry('w2', 'l2', ['a'])], 2, 1), /repeats/);
  assert.throws(() => verifiedTeamStaffing([entry('w1', 'l1', ['a'])], 2, 1), /incomplete/);
});

test('a company runs on one FACTORY fleet: staffed, reconciled, captured and retired, with its receipts', async () => {
  const c = company({ goal: { memoryMb: 2048 } });
  const result = await runFleetLeaf(c.input);
  const fleet = c.fleet();
  assert.equal(result.available, true);
  // The plan and how it was deployed.
  assert.equal(fleet.plan.machines, 2); assert.equal(fleet.plan.agentsPerMachine, 1); assert.equal(fleet.plan.workerProgram, 'flujo'); assert.equal(fleet.plan.memoryMb, 2048);
  assert.equal(fleet.plan.supervision, 'operator'); assert.equal(fleet.plan.org, 'personal-test'); assert.match(fleet.plan.network, /^seagulled-g-[a-f0-9]{32}$/);
  assert.deepEqual(fleet.plan.flujo, { agentTurns: 6, leadTurns: 12, teamConcurrency: 2 });
  assert.equal(fleet.deployOptions.providerKey, 'fixture-secret-key-value');
  assert.equal(fleet.deployOptions.image, 'docker.io/library/node@sha256:fixture');
  assert.ok(existsSync(fleet.deployOptions.bundlePath), 'the SDK bundle comes from the installed package');
  assert.equal(JSON.stringify(fleet.plan).includes('fixture-secret-key-value'), false);
  assert.equal(fleet.options.flyEnv.FLY_CONFIG_DIR, c.input.flyAccount.flyConfigDir);
  assert.equal(fleet.options.flyCommand, c.input.flyAccount.flyctlPath);
  assert.equal(fleet.options.flujoCloudPath, c.input.sourceBinding.cloudSdkRoot);
  // Workers start first, and the lead closes with their reports.
  assert.deepEqual(fleet.commands.map(command => [command.agent, command.id]), [['m1-a0', 'company-m1-a0-1'], ['m0-a0', 'company-m0-a0-1'], ['m0-a0', 'company-m0-a0-2']]);
  assert.match(fleet.commands[1].message, /coordinate 2 Worker Machines/);
  assert.match(fleet.commands[2].message, /report from m1-a0/);
  // The result and its proof.
  assert.equal(result.text, 'FINAL from m0-a0');
  assert.deepEqual({ ...result.sandbox, runId: undefined, teamLeadRuns: undefined }, { kind: 'fly', workerId: 'm0', runId: undefined, retired: true, cleanupConfirmed: true, verification: 'factory-fleet-v1',
    workerCount: 2, localConversationCount: 4, conversationCountVerified: 6, childCompletionVerified: true, initialWorkerCount: 2, teamLeadRuns: undefined });
  assert.deepEqual(result.sandbox.teamLeadRuns, ['turn-m0-a0-1', 'turn-m1-a0-1']);
  assert.deepEqual(c.seen.company, [{ verifiedWorkers: 2, verifiedChildConversations: 4 }]);
  // Estimated, never billed.
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 6, costUsd: null, costKind: 'unknown', reservedUsd: 5, billingPending: true });
  // Output first, then retirement, confirmed by reading the account.
  assert.equal(fleet.quiesced.length, 1); assert.equal(fleet.stopped, true); assert.equal(fleet.retired, true); assert.equal(fleet.disconnected, true);
  assert.deepEqual(fleet.calls.at(-1), ['apps', 'list', '--org', 'personal-test', '--json']);
  const files = result.artifacts.filter(item => item.kind === 'worker-file');
  assert.deepEqual(files.map(file => [file.workerId, readFileSync(file.path, 'utf8')]), [['m0', 'output of machine0'], ['m1', 'output of machine1']]);
  assert.equal(readFileSync(result.artifacts.at(-1).path, 'utf8'), 'FINAL from m0-a0');
  assert.deepEqual(c.seen.workers.filter(worker => worker.workerId === 'm1').map(worker => worker.status), ['provisioning', 'ready', 'dispatching', 'completed', 'retiring', 'retired']);
  assert.ok(c.seen.workers.every(worker => worker.parentId === null && worker.depth === 1));
  // Nothing private in what stays on disk beside the fleet's own journal.
  const intent = readFileSync(path.join(c.input.dataDir, 'fleet', 'owned-goal', 'intent.json'), 'utf8');
  assert.equal(intent.includes('fixture-secret-key-value'), false);
  assert.equal(JSON.parse(intent).state, 'completed');
});

test('a run is never replayed: a second attempt on the same goal is held', async () => {
  const c = company();
  await runFleetLeaf(c.input);
  await assert.rejects(runFleetLeaf(c.input), error => error.code === 'UNKNOWN' && /prior Fly fleet intent/.test(error.message));
});

test('a single-Worker goal needs no closing round', async () => {
  const c = company({ goal: { maxWorkers: 1, conversationsPerWorker: 1 } });
  const result = await runFleetLeaf(c.input);
  assert.equal(result.available, true);
  assert.equal(c.fleet().commands.length, 1);
  assert.equal(c.fleet().plan.flujo.teamConcurrency, undefined);
  assert.equal(result.text, 'report from m0-a0');
});

test('a dropped connection during monitoring does not end the run', async () => {
  const c = company({ script: { observeFailsOnce: true } });
  assert.equal((await runFleetLeaf(c.input)).available, true);
});

test('the private route holds its allowance before any Machine, and refuses without a reservation', async () => {
  const c = company({ route: privateRoute, reservationId: 'run-1-fly', reserveCloud: reservation => { c.seen.reservations.push(reservation); assert.equal(c.fleet().plan, undefined); } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
  try {
    const result = await runFleetLeaf(c.input);
    assert.deepEqual(c.seen.reservations, [{ id: 'run-1-fly', amountUsd: 5 }]);
    assert.equal(result.usage.reservationId, 'run-1-fly');
    assert.deepEqual(c.fleet().plan.modelProvider.apis, ['chat']);
    const refused = company({ route: privateRoute });
    await assert.rejects(runFleetLeaf(refused.input), /durable allowance reservation/);
    assert.equal(refused.fleet().plan, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('a Codex subscription runs native sessions on FACTORY, with the login kept on this computer', async () => {
  const route = { available: true, providerId: 'codex', verification: 'unverified', costPolicy: 'subscription-and-pending-cloud', authTransfer: 'host-refreshed-token',
    codexAuthFile: path.resolve('fixture-auth.json'), codexCommand: 'codex', model: { name: 'gpt-6-luna', reasoningEffort: 'medium', provider: 'codex', adapter: 'codex-cli', apiKey: '', baseUrl: '' } };
  const c = company({ route, goal: { maxWorkers: 1, conversationsPerWorker: 2 } });
  const result = await runFleetLeaf(c.input);
  const fleet = c.fleet();
  assert.equal(fleet.plan.workerProgram, 'codex'); assert.equal(fleet.plan.agentsPerMachine, 2); assert.equal(fleet.deployOptions.providerKey, undefined);
  assert.equal(fleet.options.auth.authFile, path.resolve('fixture-auth.json'));
  assert.deepEqual(fleet.commands.map(command => command.agent), ['m0-a0', 'm0-a1', 'm0-a0']);
  assert.equal(result.sandbox.localConversationCount, 1);
  assert.equal(result.sandbox.conversationCountVerified, 2);
  const unconfirmed = { ...route, authTransfer: 'encrypted-workspace-snapshot' };
  assert.equal((await runFleetLeaf({ ...company({ route: unconfirmed }).input })).available, false);
});

test('a Worker that fails retires the fleet, keeps a bounded diagnosis and pays nothing more', async () => {
  const c = company({ script: { onMessage: ({ fleet, agent }) => {
    if (agent !== 'm1-a0') return honestWorker({ fleet, agent, round: 1, message: 'exactly 2 times' });
    fleet.emit(agent, 'native.turn.completed', { turn: { status: 'failed', error: { code: 429 } } });
    fleet.emit(agent, 'flujo/error', { code: 'insufficient_quota', message: 'sensitive provider body' });
    return 'failed';
  } } });
  await assert.rejects(runFleetLeaf(c.input), error => error.outcome === 'failed' && /team failed/.test(error.message) && error.usage.billingPending === true);
  const fleet = c.fleet();
  assert.equal(fleet.retired, true);
  const intent = JSON.parse(readFileSync(path.join(c.input.dataDir, 'fleet', 'owned-goal', 'intent.json'), 'utf8'));
  assert.equal(intent.state, 'run-failed');
  assert.deepEqual(intent.failureDiagnostic, { agent: 'm1-a0', status: 'failed', providerHttpStatus: 429, code: 'insufficient_quota' });
  assert.equal(JSON.stringify(intent).includes('sensitive'), false);
  assert.ok(existsSync(path.join(c.input.dataDir, 'fleet', `account-admission-${createHash('sha256').update('https://api.openai.com/v1\0fixture-secret-key-value').digest('hex').slice(0, 24)}.json`)), 'the no-credits hold is saved');
  assert.deepEqual(c.seen.workers.filter(worker => worker.workerId === 'm1').map(worker => worker.status).slice(3), ['failed', 'retiring', 'retired']);
});

test('a Worker that claims work without the requested conversations is not verified', async () => {
  const c = company({ script: { onMessage: ({ fleet, agent, round, message }) => honestWorker({ fleet, agent, round, message: agent === 'm1-a0' ? 'no staffing' : message }) } });
  await assert.rejects(runFleetLeaf(c.input), error => error.outcome === 'failed' && /started 0 local conversations/.test(error.message));
  assert.equal(c.fleet().retired, true, 'the run still ends its spending');
  assert.equal(c.seen.company.length, 0);
});

test('a stop ends the company: every session stops, the fleet is retired, and nothing counts as complete', async () => {
  const controller = new AbortController();
  const c = company({ signal: controller.signal, script: { onMessage: ({ agent }) => { if (agent === 'm0-a0') setTimeout(() => controller.abort(), 5); return 'hold'; } } });
  await assert.rejects(runFleetLeaf(c.input), error => error.name === 'AbortError' && error.usage.billingPending === true);
  const fleet = c.fleet();
  assert.equal(fleet.quiesced.length, 1); assert.equal(fleet.stopped, true); assert.equal(fleet.retired, true);
  assert.equal(fleet.calls.some(args => args[0] === 'machine'), false, 'unfinished work is not collected as output');
  assert.equal(JSON.parse(readFileSync(path.join(c.input.dataDir, 'fleet', 'owned-goal', 'intent.json'), 'utf8')).state, 'stopped');
  assert.equal(c.seen.company.length, 0);
});

test('a stop still retires when the sessions cannot prove they stopped', async () => {
  const controller = new AbortController();
  const c = company({ signal: controller.signal, script: { quiesceFails: true, onMessage: ({ agent }) => { if (agent === 'm0-a0') setTimeout(() => controller.abort(), 5); return 'hold'; } } });
  await assert.rejects(runFleetLeaf(c.input), { name: 'AbortError' });
  assert.equal(c.fleet().retired, true);
});

test('output that cannot be captured keeps the volumes, stops the Machines and holds the goal', async () => {
  const c = company({ script: { outputFails: true } });
  await assert.rejects(runFleetLeaf(c.input), error => error.code === 'UNKNOWN' && /cleanup is unconfirmed/.test(error.message));
  const fleet = c.fleet();
  assert.equal(fleet.stopped, true); assert.equal(fleet.retired, false);
  assert.ok(c.seen.workers.some(worker => worker.status === 'cleanup-unconfirmed'));
});

test('a retirement that cannot be confirmed holds the goal instead of claiming success', async () => {
  for (const script of [{ retireFails: true }, { appStaysListed: true }]) {
    const c = company({ script });
    await assert.rejects(runFleetLeaf(c.input), error => error.code === 'UNKNOWN' && /cleanup is unconfirmed/.test(error.message));
    assert.equal(c.seen.company.length, 0);
  }
});

test('a deployment that fails part way is retired and held, and its key stays out of the error', async () => {
  const c = company({ script: { deployFails: true }, fleetFactory: undefined });
  let fleet;
  c.input.fleetFactory = options => { fleet = new FakeFleet(options, { deployFails: true, onMessage: honestWorker }); fleet.deploy = async () => { fleet.apps = [{ name: 'x' }]; throw new Error('Machines refused for fixture-secret-key-value'); }; return fleet; };
  await assert.rejects(runFleetLeaf(c.input), error => error.code === 'UNKNOWN' && !error.message.includes('fixture-secret-key-value') && /\[redacted\]/.test(error.message));
  assert.equal(fleet.retired, true);
  assert.equal(readFileSync(path.join(c.input.dataDir, 'fleet', 'owned-goal', 'intent.json'), 'utf8').includes('fixture-secret-key-value'), false);
});

test('Workers that never become ready are retired at the time limit', async () => {
  const c = company({ script: { enrolFails: true }, enrolTimeoutMs: 5 });
  await assert.rejects(runFleetLeaf(c.input), error => error.code === 'UNKNOWN' && /did not become ready/.test(error.message));
  assert.equal(c.fleet().retired, true);
});

test('account drift before dispatch stops the run before any Machine', async () => {
  const c = company({ assertFlyAccountCurrent: async () => false });
  await assert.rejects(runFleetLeaf(c.input), { code: 'UNKNOWN' });
  assert.equal(c.fleet().plan, undefined);
});

test('FACTORY keeps durable admission around the fleet run and never replays it', async () => {
  const root = fresh(); let calls = 0;
  const runner = createFactoryFleetRunner({ fleetRunner: async () => { calls++; return { available: true, text: 'offline result' }; } });
  const input = { goal: { id: 'goal-public', text: 'x', budgetUsd: 50, maxWorkers: 2, conversationsPerWorker: 2, providerId: 'openai', model: 'm', reasoningEffort: 'medium' }, dataDir: path.join(root, 'swarm') };
  assert.equal((await runner(input)).text, 'offline result');
  await assert.rejects(runner(input), { code: 'UNKNOWN' });
  assert.equal(calls, 1);
});
