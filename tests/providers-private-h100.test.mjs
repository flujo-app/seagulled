import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateH100Manager } from '../src/providers/private-h100.mjs';
import { ProviderManager } from '../src/providers/index.mjs';

function fixture(dataDir, { failProvision = false, holdRun = false, onCredentialSet } = {}) {
  const calls = [];
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
      calls.push({ command, args, env: options.env });
      appName = options.env.SEAGULLED_PRIVATE_APP_NAME;
      assert.match(appName, /^seagulled-qwen-[a-f0-9]{12}$/);
      assert.equal(options.env.O_INFER_APP_NAME, undefined);
      if (args.some(arg => arg.endsWith('provision.py'))) {
        token = JSON.parse(options.input).token;
        if (failProvision) throw new Error('fixture: remote outcome unknown');
        return { code: 0, stdout: JSON.stringify({ endpoint: `https://owner--${appName}-inference.modal.run` }) };
      }
      if (args.includes('profile') && args.includes('list')) return { code: 0,
        stdout: JSON.stringify([{ name: 'seagulled', workspace, active: true }]) };
      if (args.includes('stop')) return { code: 0, stdout: '' };
      if (args.includes('app') && args.includes('list')) return { code: 0,
        stdout: JSON.stringify([{ description: appName, state: 'Stopped' }]) };
      if (args.includes('secret') && args.includes('list')) return { code: 0, stdout: '[]' };
      if (args.includes('volume') && args.includes('list')) return { code: 0, stdout: '[]' };
      if (args.includes('delete')) return { code: 0, stdout: '' };
      throw new Error('Unexpected fixture command');
    },
    fetchImpl: async (url, options) => {
      assert.match(url, new RegExp(appName));
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      if (url.endsWith('/v1/models')) return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }) };
      if (holdRun && url.endsWith('/v1/chat/completions')) return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('fixture request aborted')), { once: true });
      });
      if (url.endsWith('/v1/chat/completions')) return { ok: true,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'fixture answer' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }) };
      throw new Error('Unexpected fixture URL');
    },
  });
  return { manager, calls, secrets, setWorkspace: value => { workspace = value; } };
}

test('isolated H100 enable, run, and retirement use only owned resources', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-private-test-'));
  try {
    const { manager, calls, secrets } = fixture(dataDir);
    await assert.rejects(manager.enable({ budgetUsd: 25, accountConnected: true, helperUsable: true }),
      error => error.outcome === 'not_applied');
    const state = await manager.enable({ budgetUsd: 25, accountConnected: true, helperUsable: true, workerAllowed: true });
    assert.equal(state.connected, true);
    assert.equal(state.ready, true);
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
    assert.equal(manager.fleetRoute('goal-a').available, false);
    manager.leaseGoal('goal-a');
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
