// Deterministic recovery/cleanup checks. No Fly, provider or real model requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Registry } from '../fleet/registry.mjs';
import { Controller } from '../fleet/controller.mjs';
import { provisionWithCleanup } from '../fleet/attempt.mjs';
import { FlujoClient } from '../lib/flujo-client.mjs';

const temporary = () => path.join(mkdtempSync(path.join(tmpdir(), 'swarm-recovery-')), 'registry.json');
function ready() {
  const registry = new Registry(temporary());
  const goal = registry.createGoal({ text: 'fictional source test' });
  const root = registry.reserve({ goalId: goal.id }).worker;
  registry.enroll(root.id, { kind: 'external' });
  return { registry, goal, root };
}

test('a corrupt or unsupported saved registry is refused without replacing its bytes', () => {
  for (const text of ['{"version":', '{"version":2,"goals":{},"workers":{},"runs":{},"board":[]}']) {
    const file = temporary(); writeFileSync(file, text);
    assert.throws(() => new Registry(file), /saved registry/);
    assert.equal(readFileSync(file, 'utf8'), text);
  }
});

test('restart preserves the accepted run and holds new tasks and delegation', () => {
  const { registry: first, goal, root } = ready();
  const run = first.startRun({ workerId: root.id, task: 'once', flowName: 'flow' });
  const second = new Registry(first.path);
  assert.equal(second.run(run.id).conversationId, run.conversationId);
  assert.equal(second.run(run.id).state, 'unknown');
  assert.throws(() => second.startRun({ workerId: root.id, task: 'replacement' }), /Unknown runs/);
  assert.throws(() => second.reserve({ goalId: goal.id, parentId: root.id }), /Unknown runs/);
});

test('unconfirmed retirement holds admission and never claims a running model was cancelled', () => {
  const { registry, goal, root } = ready();
  const child = registry.reserve({ goalId: goal.id, parentId: root.id }).worker;
  registry.enroll(child.id, { kind: 'fly' });
  const run = registry.startRun({ workerId: child.id, task: 'once' });
  registry.retire(child.id, 'fictional remote deletion failed');
  assert.equal(registry.run(run.id).state, 'unknown');
  assert.equal(registry.worker(child.id).cleanup.confirmed, false);
  assert.throws(() => registry.reserve({ goalId: goal.id, parentId: root.id }), /unconfirmed cleanup/);
  registry.settleRun(run.id, { status: 'completed', output: 'later known completion' });
  assert.throws(() => registry.startRun({ workerId: root.id, task: 'replacement' }), /unconfirmed cleanup/);
});

test('retiring a subtree again reports the original unresolved cleanup without repeating deletion', async () => {
  const controller = new Controller({ registryPath: temporary(), operatorToken: 'o'.repeat(40), publicUrl: 'http://127.0.0.1:1',
    provisioner: { retire: async () => { throw new Error('unconfirmed'); } } });
  const goal = controller.registry.createGoal({ text: 'g' });
  const root = controller.registry.reserve({ goalId: goal.id }).worker;
  const child = controller.registry.reserve({ goalId: goal.id, parentId: root.id }).worker;
  controller.registry.enroll(child.id, { kind: 'fly' });
  assert.deepEqual((await controller.retire('operator', { workerId: child.id })).cleanupUnconfirmed, [child.id]);
  await controller.close();
  controller.provisioner.retire = () => assert.fail('must not replay uncertain deletion');
  assert.deepEqual((await controller.retire('operator', { workerId: child.id })).cleanupUnconfirmed, [child.id]);
});

test('targetless failed provisioning retains cleanup evidence and admission holds through repeated retirement and restart', async () => {
  let creations = 0, deletions = 0;
  const managed = {
    up: async () => { creations++; throw new Error('HTTP 409 busy'); },
    down: async () => { deletions++; return { state: 'unknown' }; },
  };
  const options = { registryPath: temporary(), operatorToken: 'o'.repeat(40), publicUrl: 'http://127.0.0.1:1',
    provisioner: {
      provision: (worker) => provisionWithCleanup({ managed, worker, options: {}, turn: async () => {},
        appName: () => 'fictional-failed-provision' }),
      retire: async () => assert.fail('targetless retirement must not issue another deletion'),
    } };
  const controller = new Controller(options);
  let goal, root;
  try {
    goal = controller.registry.createGoal({ text: 'fictional failed provisioning' });
    root = controller.registry.reserve({ goalId: goal.id }).worker;
    controller.registry.enroll(root.id, { kind: 'external' });
    controller.connect = async () => assert.fail('failed provisioning must not submit a flow');
    const child = controller.delegate(root, { name: 'failed child', task: 'fictional task' });
    await controller.settled.get(child.runId);
    const failed = controller.registry.worker(child.workerId);
    assert.equal(failed.state, 'failed'); assert.equal(failed.target, null);
    assert.equal(controller.registry.run(child.runId).state, 'failed');
    const cleanup = structuredClone(failed.cleanup);
    assert.equal(cleanup.confirmed, false); assert.equal(cleanup.app, 'fictional-failed-provision');
    const held = (error) => error.code === 'HOLD';
    assert.throws(() => controller.registry.admission(goal.id), held);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await controller.retire('operator', { workerId: child.workerId });
      assert.deepEqual(result.cleanupUnconfirmed, [child.workerId]);
      assert.deepEqual(controller.registry.worker(child.workerId).cleanup, cleanup);
      assert.throws(() => controller.delegate(root, { name: 'replacement', task: 'never accepted' }), held);
      assert.throws(() => controller.startRun({ worker: root, task: 'never accepted' }), held);
    }
    assert.equal(creations, 1); assert.equal(deletions, 1);
  } finally { await controller.close(); }
  const recovered = new Controller(options);
  try { assert.throws(() => recovered.registry.admission(goal.id), (error) => error.code === 'HOLD'); }
  finally { await recovered.close(); }
  assert.equal(creations, 1); assert.equal(deletions, 1);
});

test('registry retirement without fresh cleanup evidence cannot clear an existing hold or claim cancellation', () => {
  const { registry, goal, root } = ready();
  const child = registry.reserve({ goalId: goal.id, parentId: root.id }).worker;
  const run = registry.startRun({ workerId: child.id, task: 'fictional in-flight task' });
  const cleanup = { confirmed: false, app: 'fictional-existing-attempt', error: 'lost response', detail: 'original evidence' };
  registry.markFailed(child.id, 'provisioning failed', cleanup);
  registry.retire(child.id);
  assert.deepEqual(registry.worker(child.id).cleanup, cleanup);
  assert.equal(run.state, 'unknown');
  assert.throws(() => registry.admission(goal.id), (error) => error.code === 'HOLD');
});

test('a closed goal cannot start another task on a previously ready Worker', () => {
  const { registry, goal, root } = ready();
  registry.finishGoal(goal.id, 'done');
  assert.throws(() => registry.startRun({ workerId: root.id, task: 'late' }), /no longer active/);
});

test('a finished goal retains its original result and timestamp when finish is repeated', () => {
  const { registry, goal } = ready();
  registry.finishGoal(goal.id, 'original result');
  const before = readFileSync(registry.path);
  assert.equal(registry.finishGoal(goal.id, 'original result').result, 'original result');
  assert.throws(() => registry.finishGoal(goal.id, 'corrected claim'), /recorded result is final/);
  assert.deepEqual(readFileSync(registry.path), before);
});

test('retiring a running external supervisor does not claim its retained host was stopped', async () => {
  const controller = new Controller({ registryPath: temporary(), operatorToken: 'o'.repeat(40), publicUrl: 'http://127.0.0.1:1' });
  const goal = controller.registry.createGoal({ text: 'g' });
  const root = controller.registry.reserve({ goalId: goal.id }).worker;
  controller.registry.enroll(root.id, { kind: 'flyproxy' });
  const run = controller.registry.startRun({ workerId: root.id, task: 'once' });
  const result = await controller.retire('operator', { workerId: root.id });
  assert.deepEqual(result.cleanupUnconfirmed, [root.id]);
  assert.equal(run.state, 'unknown');
  await controller.close();
});

test('a busy provisioning attempt is never replaced when cleanup throws or is not terminal', async () => {
  for (const down of [async () => { throw new Error('lost cleanup response'); }, async () => ({ state: 'unknown' })]) {
    let starts = 0;
    const managed = { up: async () => { starts++; throw new Error('snapshot begin failed: busy'); }, down };
    await assert.rejects(provisionWithCleanup({ managed, worker: { id: 'w-fictional' }, options: {}, turn: async () => {} }),
      (error) => error.cleanup.confirmed === false && error.cleanup.app.startsWith('swarm-w-fictional-'));
    assert.equal(starts, 1);
  }
});

test('a busy provisioning attempt can be replaced only after confirmed cleanup, under a new app name', async () => {
  const starts = [], deletions = [];
  const managed = { up: async ({ app }) => { starts.push(app); if (starts.length === 1) throw new Error('HTTP 409 busy'); return { worker: app }; },
    down: async (app) => { deletions.push(app); return { state: 'destroyed' }; } };
  let serial = 0;
  const result = await provisionWithCleanup({ managed, worker: {}, options: {}, turn: async () => {}, appName: () => `fictional-${++serial}` });
  assert.deepEqual(starts, ['fictional-1', 'fictional-2']);
  assert.deepEqual(deletions, ['fictional-1']);
  assert.equal(result.worker, 'fictional-2');
});

test('a lost response followed by GET 404 is UNKNOWN, with exactly one task submission', async () => {
  let posts = 0, gets = 0;
  const server = http.createServer((request, response) => {
    if (request.method === 'POST') { posts++; request.resume(); request.on('end', () => response.destroy()); }
    else { gets++; response.writeHead(404); response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new FlujoClient({ origin: `http://127.0.0.1:${server.address().port}`, workspace: 'fictional' });
    const result = await client.runFlow({ flowName: 'fictional', prompt: 'once', timeoutMs: 2000 });
    assert.equal(result.status, 'unknown'); assert.equal(posts, 1); assert.equal(gets, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('an unexpected failure after flow entry is UNKNOWN rather than safe to replace', async () => {
  const controller = new Controller({ registryPath: temporary(), operatorToken: 'o'.repeat(40), publicUrl: 'http://127.0.0.1:1' });
  const goal = controller.registry.createGoal({ text: 'g' });
  const root = controller.registry.reserve({ goalId: goal.id }).worker;
  controller.registry.enroll(root.id, { kind: 'external' });
  controller.connect = async () => ({ client: { runFlow: async () => { throw new Error('response lost'); } }, close: async () => {} });
  const run = controller.startRun({ worker: root, task: 'once' });
  await controller.settled.get(run.id);
  assert.equal(run.state, 'unknown');
  assert.throws(() => controller.startRun({ worker: root, task: 'replacement' }), /Unknown runs/);
  await controller.close();
});

test('init preserves existing private config without reading a model config', () => {
  const home = path.dirname(temporary());
  const config = path.join(home, 'config.json'); writeFileSync(config, '{"provider":"original","token":"fictional"}');
  const before = readFileSync(config);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../swarm.mjs', import.meta.url)), 'init'],
    { env: { ...process.env, SWARM_TEAMS_HOME: home }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /config already exists/); assert.deepEqual(readFileSync(config), before);
});

test('a second controller refuses before touching the running owner registry', async () => {
  const file = temporary();
  const options = { registryPath: file, operatorToken: 'o'.repeat(40), publicUrl: 'http://127.0.0.1:1' };
  const first = new Controller(options);
  const goal = first.registry.createGoal({ text: 'g' });
  const root = first.registry.reserve({ goalId: goal.id }).worker;
  first.registry.startRun({ workerId: root.id, task: 'accepted once' });
  const before = readFileSync(file);
  assert.throws(() => new Controller(options), /controller lease already exists/);
  assert.deepEqual(readFileSync(file), before);
  await first.close();
  const recovered = new Controller(options);
  assert.equal(Object.values(recovered.registry.state.runs)[0].state, 'unknown');
  await recovered.close();
});
