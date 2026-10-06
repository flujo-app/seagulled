import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateH100Manager } from '../src/providers/private-h100.mjs';
import { ProviderManager } from '../src/providers/index.mjs';

function fixture(dataDir, { failProvision = false, holdProvision = false,
  holdRun = false, missingApp = false, onCredentialSet, responseOverride } = {}) {
  const calls = [];
  const requests = [];
  const secrets = new Map();
  let appName, token;
  let workspace = 'fixture-workspace';
  const manager = new PrivateH100Manager({ dataDir,
    modalCommand: 'bundled-python.exe', modalArgs: ['-B', '-m', 'modal'],
    modalEnv: () => ({ PATH: 'bundle-path', O_INFER_APP_NAME: 'production-owner-name', MODAL_CONFIG_PATH: 'private-modal-config' }),
    credentialStore: {
      set: async (id, value) => { secrets.set(id, value); onCredentialSet?.(); },
      get: async id => secrets.get(id) ?? null,
      delete: async id => { secrets.delete(id); },
    },
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, env: options.env, killTree: options.killTree });
      appName = options.env.SEAGULLED_PRIVATE_APP_NAME;
      assert.match(appName, /^seagulled-qwen-[a-f0-9]{12}$/);
      assert.equal(options.env.O_INFER_APP_NAME, undefined);
      if (args.some(arg => arg.endsWith('provision.py'))) {
        token = JSON.parse(options.input).token;
        if (holdProvision) return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('fixture remote command stopped')),
            { once: true });
        });
        if (failProvision) throw new Error('fixture: remote outcome unknown');
        return { code: 0, stdout: JSON.stringify({ endpoint: `https://owner--${appName}-inference.modal.run` }) };
      }
      if (args.includes('profile') && args.includes('list')) return { code: 0,
        stdout: JSON.stringify([{ name: 'seagulled', workspace, active: true }]) };
      if (args.includes('stop')) return { code: missingApp ? 1 : 0, stdout: '' };
      if (args.includes('app') && args.includes('list')) return { code: 0,
        stdout: JSON.stringify([{ description: appName, state: 'Stopped' }]) };
      if (args.includes('secret') && args.includes('list')) return { code: 0, stdout: '[]' };
      if (args.includes('volume') && args.includes('list')) return { code: 0, stdout: '[]' };
      if (args.includes('delete')) return { code: 0, stdout: '' };
      throw new Error('Unexpected fixture command');
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.match(url, new RegExp(appName));
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      const override = await responseOverride?.(url, options);
      if (override !== undefined) return override;
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
      const request = JSON.parse(options.body);
      if (request.max_tokens === 48) {
        assert.equal(request.model, 'qwen3.8-27b');
        assert.equal(request.temperature, 0);
        assert.equal(request.chat_template_kwargs.enable_thinking, false);
        const challenge = request.messages[0].content.match(/SEAGULLED-[A-F0-9]{8}/)?.[0];
        assert.ok(challenge);
        return new Response(JSON.stringify({ model: 'qwen3.8-27b', choices: [{
          message: { role: 'assistant', content: challenge }, finish_reason: 'stop' }] }));
      }
      if (holdRun && url.endsWith('/v1/chat/completions')) return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('fixture request aborted')), { once: true });
      });
      if (url.endsWith('/v1/chat/completions')) return new Response(JSON.stringify({ model: 'qwen3.8-27b',
        choices: [{ message: { role: 'assistant', content: 'fixture answer' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 } }));
      throw new Error('Unexpected fixture URL');
    },
  });
  return { manager, calls, requests, secrets, setWorkspace: value => { workspace = value; } };
}

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

test('isolated H100 enable, run, and retirement use only owned resources', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const { manager, calls, requests, secrets } = fixture(dataDir);
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
    assert.equal(state.reservation.amountUsd, 6);
    assert.equal(state.usage.reservationId, state.reservation.id);
    assert.equal(state.usage.costKind, 'estimated');
    assert.doesNotMatch(JSON.stringify(state), /modal\.run|Bearer|seagulled-qwen-/);
    const journal = readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8');
    assert.doesNotMatch(journal, new RegExp(secrets.get('private_h100')));
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
    assert.equal(manager.fleetRoute().available, false);
    assert.equal(secrets.size, 0);
    assert.ok(calls.some(call => call.args.includes('stop')));
    assert.ok(calls.some(call => call.args.includes('delete')));
    assert.equal(calls.find(call => call.args.some(arg => arg.endsWith('provision.py'))).killTree, true);
    assert.ok(calls.every(call => call.command === 'bundled-python.exe'));
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('uncertain deployment keeps its attempt and cannot be replayed', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const fixtureData = fixture(dataDir, { failProvision: true });
    await assert.rejects(fixtureData.manager.enable({ budgetUsd: 50, accountConnected: true,
      helperUsable: true, workerAllowed: true, admissionId: 'admission-a' }), error => {
        assert.equal(error.reservation.id, 'admission-a');
        assert.equal(error.reservation.amountUsd, 6);
        return error.code === 'UNKNOWN';
      });
    const record = JSON.parse(readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8'));
    assert.equal(record.phase, 'unknown');
    assert.match(record.appName, /^seagulled-qwen-[a-f0-9]{12}$/);
    assert.ok(record.attemptId);
    assert.equal(record.reservation.id, 'admission-a');
    const recovered = fixture(dataDir);
    await assert.rejects(recovered.manager.enable({ budgetUsd: 50, accountConnected: true,
      helperUsable: true, workerAllowed: true }), error => error.outcome === 'not_applied');
    assert.equal(recovered.calls.length, 0);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('partial startup with no stoppable app retains cleanup and spend uncertainty', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const { manager, calls } = fixture(dataDir, { failProvision: true, missingApp: true });
    await assert.rejects(manager.enable({ budgetUsd: 50, accountConnected: true,
      helperUsable: true, workerAllowed: true, admissionId: 'admission-partial' }),
    error => error.code === 'UNKNOWN' && error.reservation.id === 'admission-partial');
    const before = calls.length;
    await assert.rejects(manager.disable({ accountConnected: true, helperUsable: true }),
      error => error.code === 'UNKNOWN');
    const cleanupCalls = calls.slice(before);
    assert.equal(cleanupCalls.some(call => call.args.includes('stop')), true);
    assert.equal(cleanupCalls.some(call => call.args.includes('delete')), false);
    const state = manager.safeState({ accountConnected: true, helperUsable: true });
    assert.equal(state.status, 'unknown');
    assert.equal(state.cleanupVerified, false);
    const record = JSON.parse(readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8'));
    assert.equal(record.reservation.id, 'admission-partial');
    assert.equal(record.cleanupVerified, undefined);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('Stop after remote provisioning entry retains an unknown admission hold', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const { manager, calls } = fixture(dataDir, { holdProvision: true });
    const controller = new AbortController();
    const enable = manager.enable({ budgetUsd: 50, accountConnected: true, helperUsable: true,
      workerAllowed: true, admissionId: 'admission-stopped', signal: controller.signal });
    const deadline = Date.now() + 3000;
    while (!calls.some(call => call.args.some(arg => arg.endsWith('provision.py'))) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(calls.some(call => call.args.some(arg => arg.endsWith('provision.py'))));
    controller.abort();
    await assert.rejects(enable, error => error.code === 'UNKNOWN'
      && error.reservation.id === 'admission-stopped');
    const record = JSON.parse(readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8'));
    assert.equal(record.phase, 'unknown');
    assert.equal(record.reservation.id, 'admission-stopped');
    assert.equal(calls.find(call => call.args.some(arg => arg.endsWith('provision.py'))).killTree, true);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('aborting an accepted H100 request preserves its durable unknown run ID', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const { manager } = fixture(dataDir, { holdRun: true });
    await manager.enable({ budgetUsd: 50, accountConnected: true, helperUsable: true, workerAllowed: true });
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
    const record = JSON.parse(readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8'));
    assert.equal(record.pendingRunId, 'request-a');
    assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).status, 'unknown');
    assert.equal(manager.fleetRoute().available, false);
    assert.throws(() => manager.releaseGoal('goal-a'), error => error.outcome === 'not_applied');
    await assert.rejects(manager.disable({ accountConnected: true, helperUsable: true }),
      error => error.outcome === 'not_applied');
    const retirement = await manager.disable({ accountConnected: true, helperUsable: true, goalId: 'goal-a' });
    assert.equal(retirement.status, 'unknown');
    assert.equal(retirement.cleanupVerified, true);
    const after = JSON.parse(readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8'));
    assert.equal(after.cleanupVerified, true);
    assert.equal(after.leaseGoalId, undefined);
    assert.equal(after.pendingRunId, record.pendingRunId);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('concurrent enable is rejected before restore yields', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const { manager, calls } = fixture(dataDir);
    const first = manager.enable({ budgetUsd: 50, accountConnected: true, helperUsable: true, workerAllowed: true });
    await assert.rejects(manager.enable({ budgetUsd: 50, accountConnected: true, helperUsable: true,
      workerAllowed: true }), error => error.outcome === 'not_applied');
    await first;
    assert.equal(calls.filter(call => call.args.some(arg => arg.endsWith('provision.py'))).length, 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('cancellation during local credential preparation never starts remote provisioning', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const controller = new AbortController();
    const { manager, calls, secrets } = fixture(dataDir, { onCredentialSet: () => controller.abort() });
    await assert.rejects(manager.enable({ budgetUsd: 50, accountConnected: true,
      helperUsable: true, workerAllowed: true, signal: controller.signal }),
    error => error.outcome === 'not_applied' && error.code !== 'UNKNOWN');
    assert.equal(calls.some(call => call.args.some(arg => arg.endsWith('provision.py'))), false);
    assert.equal(secrets.size, 0);
    const record = JSON.parse(readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8'));
    assert.equal(record.phase, 'retired');
    assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).provisionable, true);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('cleanup refuses a changed Modal workspace before touching the owned app', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const { manager, calls, setWorkspace } = fixture(dataDir);
    await manager.enable({ budgetUsd: 50, accountConnected: true, helperUsable: true, workerAllowed: true });
    const before = calls.length;
    setWorkspace('other-workspace');
    await assert.rejects(manager.disable({ accountConnected: true, helperUsable: true }), error => error.code === 'UNKNOWN');
    assert.equal(calls.slice(before).some(call => call.args.includes('stop') || call.args.includes('delete')), false);
    assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).status, 'unknown');
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

test('a catalog match without the expected executable Qwen completion never becomes ready', async () => {
  for (const failure of ['catalog', 'model', 'answer', 'finish']) {
    const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
    try {
      const { manager, requests } = fixture(dataDir, { responseOverride: (url, options) => {
        if (failure === 'catalog' && url.endsWith('/v1/models'))
          return new Response(JSON.stringify({ data: [{ id: 'different-model' }] }));
        if (!url.endsWith('/v1/chat/completions')) return undefined;
        const request = JSON.parse(options.body);
        const challenge = request.messages[0].content.match(/SEAGULLED-[A-F0-9]{8}/)?.[0];
        return new Response(JSON.stringify({ model: failure === 'model' ? 'different-model' : 'qwen3.8-27b',
          choices: [{ message: { role: 'assistant', content: failure === 'answer' ? 'wrong' : challenge },
            finish_reason: failure === 'finish' ? 'length' : 'stop' }] }));
      } });
      await assert.rejects(manager.enable({ budgetUsd: 50, accountConnected: true,
        helperUsable: true, workerAllowed: true }), error => error.code === 'UNKNOWN');
      const record = JSON.parse(readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8'));
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
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
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
          options.signal.addEventListener('abort', () => stream.error(new Error('fixture stream aborted')),
            { once: true });
        },
      }));
    } });
    const enable = manager.enable({ budgetUsd: 50, accountConnected: true, helperUsable: true,
      workerAllowed: true, admissionId: 'startup-probe', signal: controller.signal });
    await probeStarted;
    controller.abort();
    await assert.rejects(enable, error => error.code === 'UNKNOWN'
      && error.reservation.id === 'startup-probe');
    const record = JSON.parse(readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8'));
    assert.equal(record.phase, 'unknown');
    assert.equal(record.reservation.id, 'startup-probe');
    assert.equal(requests.filter(item => item.url.endsWith('/v1/chat/completions')).length, 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('startup catalog and completion responses stop reading at the byte limit', async () => {
  for (const phase of ['catalog', 'completion']) {
    const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
    const counter = { pulls: 0 };
    try {
      const { manager, requests } = fixture(dataDir, { responseOverride: (url) => {
        if (phase === 'catalog' && url.endsWith('/v1/models')
          || phase === 'completion' && url.endsWith('/v1/chat/completions'))
          return oversizedResponse(counter);
        return undefined;
      } });
      await assert.rejects(manager.enable({ budgetUsd: 50, accountConnected: true,
        helperUsable: true, workerAllowed: true }), error => error.code === 'UNKNOWN');
      assert.ok(counter.pulls > 0 && counter.pulls < 40, phase);
      assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).status, 'unknown');
      assert.equal(requests.filter(item => item.url.endsWith('/v1/chat/completions')).length,
        phase === 'catalog' ? 0 : 1);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  }
});

test('oversized ordinary completion retains its exact pending request and blocks replay', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  const counter = { pulls: 0 };
  try {
    const { manager } = fixture(dataDir, { responseOverride: (url, options) => {
      if (url.endsWith('/v1/chat/completions') && JSON.parse(options.body).max_tokens === 1024)
        return oversizedResponse(counter);
      return undefined;
    } });
    await manager.enable({ budgetUsd: 50, accountConnected: true, helperUsable: true, workerAllowed: true });
    manager.leaseGoal('goal-a');
    await assert.rejects(manager.run({ prompt: 'bounded task', maxUsd: 25,
      goalId: 'goal-a', requestId: 'oversized-run' }),
    error => error.code === 'UNKNOWN' && error.reservation.id === 'oversized-run');
    assert.ok(counter.pulls > 0 && counter.pulls < 80);
    const record = JSON.parse(readFileSync(join(dataDir, 'private-h100', 'attempt.json'), 'utf8'));
    assert.equal(record.pendingRunId, 'oversized-run');
    assert.equal(manager.fleetRoute('goal-a').available, false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an older catalog-only receipt is not accepted as executable readiness', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const { manager } = fixture(dataDir);
    await manager.enable({ budgetUsd: 50, accountConnected: true, helperUsable: true, workerAllowed: true });
    manager.record = { ...manager.record, verificationVersion: 1 };
    assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).status, 'unknown');
    assert.equal(manager.fleetRoute('goal-a').available, false);
    await manager.restore();
    assert.equal(manager.record.phase, 'unknown');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('Modal result redirects finish cold startup without replaying the completion POST', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const { manager, requests } = fixture(dataDir, { responseOverride: (url, options) => {
      if (url.includes('?modal_result=')) {
        assert.equal(options.method, 'GET');
        assert.equal(options.body, undefined);
        assert.equal(options.redirect, 'manual');
        if (url.includes('/v1/models?')) return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
        const attempt = manager.record.attemptId;
        return new Response(JSON.stringify({ model: 'qwen3.8-27b', choices: [{
          message: { role: 'assistant', content: `SEAGULLED-${attempt.slice(0, 8).toUpperCase()}` },
          finish_reason: 'stop' }] }));
      }
      if (url.endsWith('/v1/models') || url.endsWith('/v1/chat/completions'))
        return new Response(null, { status: 303, headers: { location: `${url}?modal_result=fixture` } });
      return undefined;
    } });
    const result = await manager.enable({ budgetUsd: 50, accountConnected: true,
      helperUsable: true, workerAllowed: true });
    assert.equal(result.ready, true);
    assert.equal(requests.filter(item => item.options.method === 'POST').length, 1);
    assert.equal(requests.filter(item => item.url.includes('?modal_result=')).length, 2);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an off-origin Modal redirect keeps the startup hold unknown and never forwards its bearer', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const { manager, requests } = fixture(dataDir, { responseOverride: url =>
      url.endsWith('/v1/models')
        ? new Response(null, { status: 303, headers: { location: 'https://example.com/result?modal_result=fixture' } })
        : undefined });
    await assert.rejects(manager.enable({ budgetUsd: 50, accountConnected: true,
      helperUsable: true, workerAllowed: true }), error => error.code === 'UNKNOWN');
    assert.equal(requests.length, 1);
    assert.equal(manager.safeState({ accountConnected: true, helperUsable: true }).status, 'unknown');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('Modal result redirect completes a task without replaying its reserved POST', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
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
    await manager.enable({ budgetUsd: 50, accountConnected: true, helperUsable: true, workerAllowed: true });
    manager.leaseGoal('goal-a');
    const result = await manager.run({ prompt: 'bounded task', maxUsd: 25,
      goalId: 'goal-a', requestId: 'task-redirect' });
    assert.equal(result.text, 'fixture result');
    assert.equal(result.reservation.id, 'task-redirect');
    assert.equal(requests.filter(item => item.options.method === 'POST'
      && JSON.parse(item.options.body).max_tokens === 1024).length, 1);
    assert.equal(manager.record.pendingRunId, undefined);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
