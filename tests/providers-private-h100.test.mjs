import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateH100Manager, PRIVATE_MODELS } from '../src/providers/private-h100.mjs';
import { ProviderManager } from '../src/providers/index.mjs';

const SERVED = { qwen: 'qwen3.8-27b', nemotron: 'nemotron-3.5-super-vl' };
const SETTINGS = { enable_thinking: false, scaledown_minutes: 1, request_timeout_minutes: 30, startup_timeout_minutes: 30 };

// A fake personal Modal account behind FACTORY's self-hosted model serving: the deploy script,
// the Modal CLI (through the bundled Python) and the served vLLM endpoint.
function fixture(dataDir, { failProvision = false, holdProvision = false, appLeftRunning = false,
  holdRun = false, onCredentialSet, responseOverride } = {}) {
  const calls = [];
  const requests = [];
  const secrets = new Map();
  const modal = { apps: new Map(), secrets: new Set(), volumes: new Set() };
  let appName, profile, token;
  let workspace = 'fixture-workspace';
  const manager = new PrivateH100Manager({ dataDir,
    modalCommand: 'bundled-python.exe', modalArgs: ['-B', '-m', 'modal'],
    modalEnv: () => ({ PATH: 'bundle-path', O_INFER_APP_NAME: 'production-owner-name', SEAGULLED_PRIVATE_APP_NAME: 'stale-name',
      MODAL_CONFIG_PATH: 'private-modal-config' }),
    credentialStore: {
      set: async (id, value) => { secrets.set(id, value); onCredentialSet?.(); },
      get: async id => secrets.get(id) ?? null,
      delete: async id => { secrets.delete(id); },
    },
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, env: options.env, killTree: options.killTree, input: options.input });
      assert.equal(options.env.O_INFER_APP_NAME, undefined);
      assert.equal(options.env.SEAGULLED_PRIVATE_APP_NAME, undefined);
      assert.equal(args[0], '-B');
      if (args.at(-1).endsWith('deploy.py')) {
        const request = JSON.parse(options.input);
        appName = request.appName; profile = request.profile;
        assert.match(appName, /^seagulled-(qwen|nemotron)-[a-f0-9]{12}$/);
        assert.deepEqual(request.overrides, SETTINGS);
        if (request.action === 'describe') {
          const spec = PRIVATE_MODELS[profile];
          return { code: 0, stdout: JSON.stringify({ settings: { appName, profile, label: spec.label, model: spec.model, gpu: spec.gpu,
            replicas: 1, contextWindow: 262144, usdPerHourPerReplica: spec.activeUsdPerHour, scaledownMinutes: 1, startupTimeoutMinutes: 30 },
          hints: { compact_tokens: 80000 } }) };
        }
        assert.equal(request.action, 'deploy');
        token = request.key;
        if (holdProvision) return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('fixture remote command stopped')), { once: true });
        });
        if (failProvision) {
          if (appLeftRunning) modal.apps.set(appName, 'deployed');
          throw new Error('fixture: remote outcome unknown');
        }
        modal.apps.set(appName, 'deployed'); modal.secrets.add(`${appName}-auth`);
        modal.volumes.add(`${appName}-hf-cache`); modal.volumes.add(`${appName}-vllm-cache`);
        return { code: 0, stdout: JSON.stringify({ endpoints: [`https://owner--${appName}-serve.modal.run`] }) };
      }
      assert.deepEqual(args.slice(0, 3), ['-B', '-m', 'modal']);
      const cli = args.slice(3);
      if (cli[0] === 'profile') return { code: 0, stdout: JSON.stringify([{ name: 'seagulled', workspace, active: true }]) };
      if (cli[0] === 'app' && cli[1] === 'stop') {
        const name = cli.at(-1);
        if (!modal.apps.has(name) || appLeftRunning) return { code: 1, stdout: '' };
        modal.apps.set(name, 'stopped'); return { code: 0, stdout: '' };
      }
      if (cli[0] === 'app' && cli[1] === 'list') return { code: 0, stdout: JSON.stringify([...modal.apps].map(([description, state]) => ({ description, state }))) };
      if (cli[1] === 'delete') { (cli[0] === 'secret' ? modal.secrets : modal.volumes).delete(cli.at(-1)); return { code: 0, stdout: '' }; }
      if (cli[1] === 'list') return { code: 0, stdout: JSON.stringify([...(cli[0] === 'secret' ? modal.secrets : modal.volumes)].map(name => ({ name }))) };
      throw new Error('Unexpected fixture command');
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.match(url, new RegExp(appName));
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      const override = await responseOverride?.(url, options);
      if (override !== undefined) return override;
      const served = SERVED[profile];
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: served }] }));
      const request = JSON.parse(options.body);
      if (request.max_tokens === 48) {
        assert.equal(request.model, served);
        assert.equal(request.temperature, 0);
        assert.equal(request.chat_template_kwargs.enable_thinking, false);
        const challenge = request.messages[0].content.match(/FACTORY-[A-F0-9]{8}/)?.[0];
        assert.ok(challenge);
        return new Response(JSON.stringify({ model: served, choices: [{
          message: { role: 'assistant', content: challenge }, finish_reason: 'stop' }] }));
      }
      if (holdRun && url.endsWith('/v1/chat/completions')) return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('fixture request aborted')), { once: true });
      });
      if (url.endsWith('/v1/chat/completions')) return new Response(JSON.stringify({ model: served,
        choices: [{ message: { role: 'assistant', content: 'fixture answer' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 } }));
      throw new Error('Unexpected fixture URL');
    },
  });
  return { manager, calls, requests, secrets, modal, appName: () => appName, setWorkspace: value => { workspace = value; } };
}
const deployCalls = calls => calls.filter(call => call.args.at(-1).endsWith('deploy.py') && JSON.parse(call.input).action === 'deploy');

function oversizedResponse(counter) {
  const response = new Response(new ReadableStream({
    pull(controller) {
      counter.pulls++;
      if (counter.pulls > 1000) { controller.close(); return; }
      controller.enqueue(new Uint8Array(8192).fill(32));
    },
  }));
  response.text = () => { throw new Error('Unbounded response.text() was called.'); };
  return response;
}
const enabled = { budgetUsd: 50, accountConnected: true, helperUsable: true, workerAllowed: true };
const temporary = () => mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
const attempt = dataDir => JSON.parse(readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8'));

test('isolated H100 enable, run, and retirement use only owned resources', async () => {
  const dataDir = temporary();
  try {
    const { manager, calls, requests, secrets, modal } = fixture(dataDir);
    await assert.rejects(manager.enable({ budgetUsd: 25, accountConnected: true, helperUsable: true }),
      error => error.outcome === 'not_applied');
    const state = await manager.enable({ budgetUsd: 25, accountConnected: true, helperUsable: true, workerAllowed: true });
    assert.equal(state.connected, true);
    assert.equal(state.ready, true);
    assert.equal(state.verificationVersion, 2);
    assert.equal(state.admission.enableUsd, 6);
    assert.equal(state.admission.kind, 'estimated');
    assert.equal(state.estimate.enableUsd, 6);
    assert.equal(state.estimate.requestUsd, 2.5);
    assert.equal(state.estimate.activeUsdPerHour, 4.84);
    assert.equal(state.privateModel, 'qwen');
    assert.equal(state.reservation.amountUsd, 6);
    assert.equal(state.usage.reservationId, state.reservation.id);
    assert.equal(state.usage.costKind, 'estimated');
    assert.doesNotMatch(JSON.stringify(state), /modal\.run|Bearer|seagulled-qwen-/);
    const journal = readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8');
    const computeJournal = readFileSync(join(dataDir, 'private-h100', 'model', 'model.json'), 'utf8');
    for (const text of [journal, computeJournal]) assert.equal(text.includes(secrets.get('private_h100')), false);
    assert.equal(JSON.parse(journal).verificationVersion, 2);
    assert.equal(JSON.parse(journal).verifiedModel, 'qwen3.8-27b');
    assert.ok(JSON.parse(journal).catalogVerifiedAt);
    assert.ok(JSON.parse(journal).completionVerifiedAt);
    assert.equal(requests.filter(request => request.url.endsWith('/v1/chat/completions')
      && JSON.parse(request.options.body).max_tokens === 48).length, 1);
    assert.equal(manager.fleetRoute('goal-a').available, false);
    manager.leaseGoal('goal-a');
    assert.equal(manager.fleetRoute('goal-a').verification, 'inference-verified');
    assert.throws(() => manager.leaseGoal('goal-b'), error => error.outcome === 'not_applied');
    const route = manager.fleetRoute('goal-a');
    assert.equal(route.available, true);
    assert.equal(route.model.name, 'qwen3.8-27b');
    assert.equal(route.model.apiKey, secrets.get('private_h100'));
    const result = await manager.run({ prompt: 'Work on this bounded task.', maxUsd: 25,
      goalId: 'goal-a', requestId: 'request-a' });
    assert.equal(result.text, 'fixture answer');
    assert.equal(result.usage.costKind, 'estimated');
    assert.equal(result.usage.reservationId, 'request-a');
    assert.deepEqual(result.reservation, { id: 'request-a', amountUsd: 2.5, kind: 'estimated-upper' });
    await assert.rejects(manager.disable({ accountConnected: true, helperUsable: true }), error => error.outcome === 'not_applied');
    manager.releaseGoal('goal-a');
    const stopped = await manager.disable({ accountConnected: true, helperUsable: true });
    assert.equal(stopped.status, 'retired');
    assert.equal(stopped.cleanupVerified, true);
    assert.equal(manager.fleetRoute().available, false);
    assert.equal(secrets.size, 0);
    assert.equal(modal.secrets.size + modal.volumes.size, 0);
    assert.ok(calls.some(call => call.args.includes('stop')));
    assert.ok(calls.some(call => call.args.includes('delete')));
    assert.equal(deployCalls(calls)[0].killTree, true);
    assert.ok(calls.every(call => call.command === 'bundled-python.exe'));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('the Nemotron route runs on a B300 with its own admission, request reserve and served model', async () => {
  const dataDir = temporary();
  try {
    const { manager, calls } = fixture(dataDir);
    const idle = manager.safeState({ accountConnected: true, helperUsable: true, model: 'nemotron' });
    assert.equal(idle.admission.enableUsd, 10);
    assert.equal(idle.estimate.requestUsd, 4.36);
    assert.equal(idle.estimate.activeUsdPerHour, 8.43);
    assert.match(idle.estimate.includes, /^B300, 12 CPU cores, 96 GiB memory/);
    assert.deepEqual(idle.privateModels.map(item => [item.id, item.gpu, item.enableUsd, item.requestUsd]),
      [['qwen', 'H100', 6, 2.5], ['nemotron', 'B300', 10, 4.36]]);
    await assert.rejects(manager.enable({ ...enabled, budgetUsd: 8, model: 'nemotron' }),
      error => error.outcome === 'not_applied' && /10 USD/.test(error.message));
    await assert.rejects(manager.enable({ ...enabled, model: 'mixtral' }), error => error.outcome === 'not_applied');
    const state = await manager.enable({ ...enabled, model: 'nemotron', admissionId: 'admission-b300' });
    assert.equal(state.ready, true);
    assert.equal(state.reservation.amountUsd, 10);
    assert.equal(state.gpu, 'B300');
    assert.match(attempt(dataDir).appName, /^seagulled-nemotron-[a-f0-9]{12}$/);
    assert.equal(JSON.parse(deployCalls(calls)[0].input).profile, 'nemotron');
    manager.leaseGoal('goal-b');
    assert.equal(manager.fleetRoute('goal-b').model.name, 'nemotron-3.5-super-vl');
    const result = await manager.run({ prompt: 'bounded task', maxUsd: 25, goalId: 'goal-b', requestId: 'request-b' });
    assert.deepEqual(result.reservation, { id: 'request-b', amountUsd: 4.36, kind: 'estimated-upper' });
    await assert.rejects(manager.run({ prompt: 'bounded task', maxUsd: 4, goalId: 'goal-b' }), /B300 request/);
    const manager2 = new ProviderManager();
    manager2.privateH100 = manager;
    const published = manager2.publicState().find(item => item.id === 'private-h100');
    assert.equal(published.name, 'Private B300 + Nemotron');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('uncertain deployment keeps its attempt and cannot be replayed', async () => {
  const dataDir = temporary();
  try {
    const fixtureData = fixture(dataDir, { failProvision: true });
    await assert.rejects(fixtureData.manager.enable({ ...enabled, admissionId: 'admission-a' }), error => {
      assert.equal(error.reservation.id, 'admission-a');
      assert.equal(error.reservation.amountUsd, 6);
      return error.code === 'UNKNOWN';
    });
    const record = attempt(dataDir);
    assert.equal(record.phase, 'unknown');
    assert.match(record.appName, /^seagulled-qwen-[a-f0-9]{12}$/);
    assert.ok(record.attemptId);
    assert.equal(record.reservation.id, 'admission-a');
    const recovered = fixture(dataDir);
    await assert.rejects(recovered.manager.enable(enabled), error => error.outcome === 'not_applied');
    assert.equal(recovered.calls.length, 0);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('a startup that never created its app is cleaned up and verified while its spend hold stays', async () => {
  const dataDir = temporary();
  try {
    const { manager, calls } = fixture(dataDir, { failProvision: true });
    await assert.rejects(manager.enable({ ...enabled, admissionId: 'admission-partial' }),
      error => error.code === 'UNKNOWN' && error.reservation.id === 'admission-partial');
    const state = await manager.disable({ accountConnected: true, helperUsable: true });
    assert.equal(state.status, 'retired');
    assert.equal(state.cleanupVerified, true);
    assert.ok(calls.some(call => call.args.includes('delete')));
    assert.equal(attempt(dataDir).reservation.id, 'admission-partial', 'the runtime keeps the uncertain startup reserve');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an app that cannot be confirmed stopped retains cleanup and spend uncertainty', async () => {
  const dataDir = temporary();
  try {
    const { manager, calls } = fixture(dataDir, { failProvision: true, appLeftRunning: true });
    await assert.rejects(manager.enable({ ...enabled, admissionId: 'admission-running' }),
      error => error.code === 'UNKNOWN' && error.reservation.id === 'admission-running');
    const before = calls.length;
    await assert.rejects(manager.disable({ accountConnected: true, helperUsable: true }), error => error.code === 'UNKNOWN');
    const cleanupCalls = calls.slice(before);
    assert.equal(cleanupCalls.some(call => call.args.includes('stop')), true);
    assert.equal(cleanupCalls.some(call => call.args.includes('delete')), false);
    const state = manager.safeState({ accountConnected: true, helperUsable: true });
    assert.equal(state.status, 'unknown');
    assert.equal(state.cleanupVerified, false);
    const record = attempt(dataDir);
    assert.equal(record.reservation.id, 'admission-running');
    assert.equal(record.cleanupVerified, undefined);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('Stop after remote provisioning entry retains an unknown admission hold', async () => {
  const dataDir = temporary();
  try {
    const { manager, calls } = fixture(dataDir, { holdProvision: true });
    const controller = new AbortController();
    const enable = manager.enable({ ...enabled, admissionId: 'admission-stopped', signal: controller.signal });
    const deadline = Date.now() + 3000;
    while (!deployCalls(calls).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(deployCalls(calls).length, 1);
    controller.abort();
    await assert.rejects(enable, error => error.code === 'UNKNOWN' && error.reservation.id === 'admission-stopped');
    const record = attempt(dataDir);
    assert.equal(record.phase, 'unknown');
    assert.equal(record.reservation.id, 'admission-stopped');
    assert.equal(deployCalls(calls)[0].killTree, true);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('aborting an accepted H100 request preserves its durable unknown run ID', async () => {
  const dataDir = temporary();
  try {
    const { manager } = fixture(dataDir, { holdRun: true });
    await manager.enable(enabled);
    manager.leaseGoal('goal-a');
    const controller = new AbortController();
    const run = manager.run({ prompt: 'bounded task', maxUsd: 25, signal: controller.signal,
      goalId: 'goal-a', requestId: 'request-a' });
    await assert.rejects(manager.disable({ accountConnected: true, helperUsable: true }), error => error.outcome === 'not_applied');
    assert.throws(() => manager.releaseGoal('goal-a'), error => error.outcome === 'not_applied');
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(run, error => {
      assert.deepEqual(error.reservation, { id: 'request-a', amountUsd: 2.5, kind: 'estimated-upper' });
      return error.code === 'UNKNOWN';
    });
    const record = attempt(dataDir);
    assert.equal(record.pendingRunId, 'request-a');
    assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).status, 'unknown');
    assert.equal(manager.fleetRoute().available, false);
    assert.throws(() => manager.releaseGoal('goal-a'), error => error.outcome === 'not_applied');
    await assert.rejects(manager.disable({ accountConnected: true, helperUsable: true }),
      error => error.outcome === 'not_applied');
    const retirement = await manager.disable({ accountConnected: true, helperUsable: true, goalId: 'goal-a' });
    assert.equal(retirement.status, 'unknown');
    assert.equal(retirement.cleanupVerified, true);
    const after = attempt(dataDir);
    assert.equal(after.cleanupVerified, true);
    assert.equal(after.leaseGoalId, undefined);
    assert.equal(after.pendingRunId, record.pendingRunId);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('concurrent enable is rejected before restore yields', async () => {
  const dataDir = temporary();
  try {
    const { manager, calls } = fixture(dataDir);
    const first = manager.enable(enabled);
    await assert.rejects(manager.enable(enabled), error => error.outcome === 'not_applied');
    await first;
    assert.equal(deployCalls(calls).length, 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('cancellation during local credential preparation never starts remote provisioning', async () => {
  const dataDir = temporary();
  try {
    const controller = new AbortController();
    const { manager, calls, secrets } = fixture(dataDir, { onCredentialSet: () => controller.abort() });
    await assert.rejects(manager.enable({ ...enabled, signal: controller.signal }),
      error => error.outcome === 'not_applied' && error.code !== 'UNKNOWN');
    assert.equal(deployCalls(calls).length, 0);
    assert.equal(secrets.size, 0);
    assert.equal(attempt(dataDir).phase, 'retired');
    assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).provisionable, true);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('cleanup refuses a changed Modal workspace before touching the owned app', async () => {
  const dataDir = temporary();
  try {
    const { manager, calls, setWorkspace } = fixture(dataDir);
    await manager.enable(enabled);
    const before = calls.length;
    setWorkspace('other-workspace');
    await assert.rejects(manager.disable({ accountConnected: true, helperUsable: true }), error => error.code === 'UNKNOWN');
    assert.equal(calls.slice(before).some(call => call.args.includes('stop') || call.args.includes('delete')), false);
    assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).status, 'unknown');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an attempt recorded before FACTORY owned the Modal lifecycle is adopted and retired', async () => {
  const dataDir = temporary();
  try {
    const appName = 'seagulled-qwen-00112233aabb';
    mkdirSync(join(dataDir, 'private-h100'), { recursive: true });
    writeFileSync(join(dataDir, 'private-h100', 'attempt.json'), JSON.stringify({ version: 1, attemptId: '0b2c0d6e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
      appName, phase: 'unknown', profileName: 'seagulled', workspaceName: 'fixture-workspace',
      endpoint: `https://owner--${appName}-inference.modal.run`, reservation: { id: 'legacy-admission', amountUsd: 6, kind: 'estimated-upper' } }));
    const { manager, calls, modal } = fixture(dataDir);
    modal.apps.set(appName, 'deployed'); modal.secrets.add(`${appName}-auth`); modal.volumes.add(`${appName}-hf-cache`);
    await manager.restore();
    assert.equal(calls.length, 0, 'adoption itself makes no provider call');
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'private-h100', 'model', 'model.json'), 'utf8')).appName, appName);
    const state = await manager.disable({ accountConnected: true, helperUsable: true });
    assert.equal(state.status, 'retired');
    assert.equal(state.cleanupVerified, true);
    assert.equal(modal.apps.get(appName), 'stopped');
    assert.equal(modal.secrets.size + modal.volumes.size, 0);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('provider facade forwards private goal and request IDs into the usage receipt', async () => {
  const manager = new ProviderManager();
  let received;
  manager.privateH100.run = async options => {
    received = options;
    return { text: 'fixture answer', usage: { costUsd: 0.01, costKind: 'estimated',
      reservationId: options.requestId } };
  };
  const events = [];
  const result = await manager.run({ providerId: 'private-h100', prompt: 'bounded task', maxUsd: 3,
    goalId: 'goal-a', requestId: 'request-a', onEvent: event => events.push(event) });
  assert.equal(received.goalId, 'goal-a');
  assert.equal(received.requestId, 'request-a');
  assert.equal(result.usage.reservationId, 'request-a');
  assert.equal(events.find(event => event.type === 'usage').usage.reservationId, 'request-a');
});

test('a catalog match without the expected executable completion never becomes ready', async () => {
  for (const failure of ['catalog', 'model', 'answer', 'finish']) {
    const dataDir = temporary();
    try {
      const { manager, requests } = fixture(dataDir, { responseOverride: (url, options) => {
        if (failure === 'catalog' && url.endsWith('/v1/models'))
          return new Response(JSON.stringify({ data: [{ id: 'different-model' }] }));
        if (!url.endsWith('/v1/chat/completions')) return undefined;
        const request = JSON.parse(options.body);
        const challenge = request.messages[0].content.match(/FACTORY-[A-F0-9]{8}/)?.[0];
        return new Response(JSON.stringify({ model: failure === 'model' ? 'different-model' : 'qwen3.8-27b',
          choices: [{ message: { role: 'assistant', content: failure === 'answer' ? 'wrong' : challenge },
            finish_reason: failure === 'finish' ? 'length' : 'stop' }] }));
      } });
      await assert.rejects(manager.enable(enabled), error => error.code === 'UNKNOWN');
      const record = attempt(dataDir);
      assert.equal(record.phase, 'unknown', failure);
      assert.equal(record.verificationVersion, undefined, failure);
      assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).ready, false);
      assert.equal(manager.fleetRoute('goal-a').available, false);
      const probes = requests.filter(item => item.url.endsWith('/v1/chat/completions'));
      assert.equal(probes.length, failure === 'catalog' ? 0 : 1, failure);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test('aborting the single startup completion stream retains the original admission hold', async () => {
  const dataDir = temporary();
  try {
    let started;
    const probeStarted = new Promise(resolve => { started = resolve; });
    const controller = new AbortController();
    const { manager, requests } = fixture(dataDir, { responseOverride: (url, options) => {
      if (!url.endsWith('/v1/chat/completions')) return undefined;
      started();
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"model":'));
          options.signal.addEventListener('abort', () => stream.error(new Error('fixture stream aborted')), { once: true });
        },
      }));
    } });
    const enable = manager.enable({ ...enabled, admissionId: 'startup-probe', signal: controller.signal });
    await probeStarted;
    controller.abort();
    await assert.rejects(enable, error => error.code === 'UNKNOWN' && error.reservation.id === 'startup-probe');
    const record = attempt(dataDir);
    assert.equal(record.phase, 'unknown');
    assert.equal(record.reservation.id, 'startup-probe');
    assert.equal(requests.filter(item => item.url.endsWith('/v1/chat/completions')).length, 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('startup catalog and completion responses stop reading at the byte limit', async () => {
  for (const phase of ['catalog', 'completion']) {
    const dataDir = temporary();
    const counter = { pulls: 0 };
    try {
      const { manager, requests } = fixture(dataDir, { responseOverride: (url) => {
        if (phase === 'catalog' && url.endsWith('/v1/models')
          || phase === 'completion' && url.endsWith('/v1/chat/completions'))
          return oversizedResponse(counter);
        return undefined;
      } });
      await assert.rejects(manager.enable(enabled), error => error.code === 'UNKNOWN');
      assert.ok(counter.pulls > 0 && counter.pulls < 40, phase);
      assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).status, 'unknown');
      assert.equal(requests.filter(item => item.url.endsWith('/v1/chat/completions')).length, phase === 'catalog' ? 0 : 1);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test('oversized ordinary completion retains its exact pending request and blocks replay', async () => {
  const dataDir = temporary();
  const counter = { pulls: 0 };
  try {
    const { manager } = fixture(dataDir, { responseOverride: (url, options) => {
      if (url.endsWith('/v1/chat/completions') && JSON.parse(options.body).max_tokens === 1024)
        return oversizedResponse(counter);
      return undefined;
    } });
    await manager.enable(enabled);
    manager.leaseGoal('goal-a');
    await assert.rejects(manager.run({ prompt: 'bounded task', maxUsd: 25, goalId: 'goal-a', requestId: 'oversized-run' }),
      error => error.code === 'UNKNOWN' && error.reservation.id === 'oversized-run');
    assert.ok(counter.pulls > 0 && counter.pulls < 80);
    assert.equal(attempt(dataDir).pendingRunId, 'oversized-run');
    assert.equal(manager.fleetRoute('goal-a').available, false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an older catalog-only receipt is not accepted as executable readiness', async () => {
  const dataDir = temporary();
  try {
    const { manager } = fixture(dataDir);
    await manager.enable(enabled);
    manager.record = { ...manager.record, verificationVersion: 1 };
    assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).status, 'unknown');
    assert.equal(manager.fleetRoute('goal-a').available, false);
    await manager.restore();
    assert.equal(manager.record.phase, 'unknown');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('Modal result redirects finish cold startup without replaying the completion POST', async () => {
  const dataDir = temporary();
  try {
    let challenge;
    const { manager, requests } = fixture(dataDir, { responseOverride: (url, options) => {
      if (url.includes('?modal_result=')) {
        assert.equal(options.method, 'GET');
        assert.equal(options.body, undefined);
        assert.equal(options.redirect, 'manual');
        if (url.includes('/v1/models?')) return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
        return new Response(JSON.stringify({ model: 'qwen3.8-27b', choices: [{
          message: { role: 'assistant', content: challenge }, finish_reason: 'stop' }] }));
      }
      if (url.endsWith('/v1/chat/completions')) challenge = JSON.parse(options.body).messages[0].content.match(/FACTORY-[A-F0-9]{8}/)?.[0];
      if (url.endsWith('/v1/models') || url.endsWith('/v1/chat/completions'))
        return new Response(null, { status: 303, headers: { location: `${url}?modal_result=fixture` } });
      return undefined;
    } });
    const result = await manager.enable(enabled);
    assert.equal(result.ready, true);
    assert.equal(requests.filter(item => item.options.method === 'POST').length, 1);
    assert.equal(requests.filter(item => item.url.includes('?modal_result=')).length, 2);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an off-origin Modal redirect keeps the startup hold unknown and never forwards its bearer', async () => {
  const dataDir = temporary();
  try {
    const { manager, requests } = fixture(dataDir, { responseOverride: url =>
      url.endsWith('/v1/models')
        ? new Response(null, { status: 303, headers: { location: 'https://example.com/result?modal_result=fixture' } })
        : undefined });
    await assert.rejects(manager.enable(enabled), error => error.code === 'UNKNOWN');
    assert.equal(requests.length, 1);
    assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).status, 'unknown');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('Modal result redirect completes a task without replaying its reserved POST', async () => {
  const dataDir = temporary();
  try {
    const { manager, requests } = fixture(dataDir, { responseOverride: (url, options) => {
      if (url.includes('?modal_result=task')) {
        assert.equal(options.method, 'GET');
        assert.equal(options.body, undefined);
        return new Response(JSON.stringify({ model: 'qwen3.8-27b', choices: [{
          message: { role: 'assistant', content: 'fixture result' } }] }));
      }
      if (url.endsWith('/v1/chat/completions') && JSON.parse(options.body).max_tokens === 1024)
        return new Response(null, { status: 303, headers: { location: `${url}?modal_result=task` } });
      return undefined;
    } });
    await manager.enable(enabled);
    manager.leaseGoal('goal-a');
    const result = await manager.run({ prompt: 'bounded task', maxUsd: 25, goalId: 'goal-a', requestId: 'task-redirect' });
    assert.equal(result.text, 'fixture result');
    assert.equal(result.reservation.id, 'task-redirect');
    assert.equal(requests.filter(item => item.options.method === 'POST'
      && JSON.parse(item.options.body).max_tokens === 1024).length, 1);
    assert.equal(manager.record.pendingRunId, undefined);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
