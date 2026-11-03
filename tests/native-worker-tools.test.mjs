import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../upstream/swarm-teams/fleet/controller.mjs';
import { createControllerNativeSourceAdmission } from '../src/native-source-admission.mjs';
import { createNativeWorkerToolBroker } from '../src/native-worker-tools.mjs';
import { createNativeSourceAdmissionTransport, createNativeSourceAdmissionClient } from '../src/native-source-transport.mjs';

// Real Controller, admission and HTTP connection to a deterministic Worker API.
// No provider, shell command, cloud Worker or requested business work executes.
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function equipment(task, handler) {
  const directory = mkdtempSync(path.join(tmpdir(), 'seagulled-native-tools-'));
  const calls = [], stop = new AbortController(); let active = true, held = false, holds = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const call = { url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; calls.push(call);
    if (handler) await handler(call);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ success: true, data: { content: [{ type: 'text', text: 'Deterministic Worker API result.' }] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new Controller({ registryPath: path.join(directory, 'registry.json'), operatorToken: 'synthetic-test-operator-'.repeat(3),
    publicUrl: 'http://127.0.0.1:1', provisioner: {} });
  const registry = controller.registry, goal = registry.createGoal({ text: 'Offline native tool broker equipment only.' });
  const { worker, token } = registry.reserve({ goalId: goal.id, role: 'supervisor' });
  registry.enroll(worker.id, { kind: 'external', origin: `http://127.0.0.1:${server.address().port}`, workspace: 'test-workspace', token: 'synthetic-worker-control-only' });
  const run = registry.startRun({ workerId: worker.id, startedBy: 'operator', task: 'Offline broker test', flowName: 'test-flow' });
  registry.bindRunTarget(run.id, worker.target);
  const scope = { signal: stop.signal, async assertCurrent() { if (!active) throw new Error('OFF'); stop.signal.throwIfAborted(); },
    async commit(effect) { await this.assertCurrent(); held = true; try { return await effect(); } finally { held = false; } },
    async retainUncertainty() { assert.equal(held, true); holds++; stop.abort(new Error('Offline uncertainty retained')); } };
  const readPlan = async () => ({ flowId: 'test-flow', flowDigest: 'a'.repeat(64), modelId: 'test-model', modelDigest: 'b'.repeat(64) });
  const admission = createControllerNativeSourceAdmission({ controller, scope, readPlan });
  const claim = { goalId: goal.id, runId: run.id, rootConversationId: run.conversationId, workspace: worker.target.workspace };
  const context = await admission.admitWorker({ headers: { authorization: `Bearer ${token}` } }, claim);
  await admission.bindRun(context, run.conversationId, 'source-logical-run');
  const broker = createNativeWorkerToolBroker({ controller, admission, scope });
  try { await task({ controller, admission, broker, context, calls, scope, readPlan, claim, token,
    held: () => held, holds: () => holds, pause() { active = false; } }); }
  finally {
    await broker.close(); admission.close(); await controller.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.match(path.basename(target), /^seagulled-native-tools-/); assert.equal(lstatSync(target).isSymbolicLink(), false);
    rmSync(target, { recursive: true, force: true });
  }
}

test('single-use tool ticket selects the actual Worker connection and rewrites workspace paths', () => equipment(async e => {
  const args = { path: 'repo/README.md', content: 'Offline fixture content.' };
  const issued = await e.broker.issue(e.context, 'worker_write_file', args);
  const result = await e.broker.call(issued.ticket, 'worker_write_file', args);
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].headers.authorization, 'Bearer synthetic-worker-control-only');
  assert.equal(e.calls[0].headers['x-flujo-workspace'], 'test-workspace');
  assert.equal(e.calls[0].body.args.path, '/data/flujo/workspaces/test-workspace/seagulled-output/repo/README.md');
  assert.equal(result.receipt.ticket, issued.ticket);
  await assert.rejects(e.broker.call(issued.ticket, 'worker_write_file', args));
  assert.equal(e.calls.length, 1); assert.equal(e.holds(), 0);
}));

test('copied contexts, traversal, caller targets and changed ticket arguments dispatch nothing', () => equipment(async e => {
  await assert.rejects(e.broker.issue({ ...e.context }, 'worker_read_file', { path: 'repo/README.md' }));
  for (const args of [{ path: '../db/auth' }, { path: '/host/auth' }, { path: 'repo/file', origin: 'http://foreign' }]) {
    await assert.rejects(e.broker.issue(e.context, 'worker_read_file', args));
  }
  const issued = await e.broker.issue(e.context, 'worker_read_file', { path: 'repo/file' });
  await assert.rejects(e.broker.call(issued.ticket, 'worker_read_file', { path: 'repo/other' }));
  await assert.rejects(e.broker.call(issued.ticket, 'worker_read_file', { path: 'repo/file' }));
  assert.equal(e.calls.length, 0); assert.equal(e.holds(), 0);
}));

test('OFF after ticket issuance refuses a grant before Worker effects', () => equipment(async e => {
  const issued = await e.broker.issue(e.context, 'worker_command', { command: 'not executed' });
  e.pause(); await assert.rejects(e.broker.call(issued.ticket, 'worker_command', { command: 'not executed' }));
  assert.equal(e.calls.length, 0); assert.equal(e.holds(), 0);
}));

test('OFF during a dispatched write retains uncertainty inside the held fence', async () => {
  const entered = gate(), finish = gate();
  await equipment(async e => {
    const args = { path: 'repo/file', content: 'fixture' }, issued = await e.broker.issue(e.context, 'worker_write_file', args);
    const pending = e.broker.call(issued.ticket, 'worker_write_file', args);
    await entered.promise; assert.equal(e.held(), true); e.pause(); finish.resolve();
    await assert.rejects(pending, error => error.code === 'UNKNOWN');
    assert.equal(e.holds(), 1); assert.equal(e.calls.length, 1);
    await assert.rejects(e.broker.issue(e.context, 'worker_read_file', { path: 'repo/file' }));
  }, async () => { entered.resolve(); await finish.promise; });
});

test('a counterfeit admission object cannot select another Controller for tools', () => equipment(async e => {
  assert.throws(() => createNativeWorkerToolBroker({ controller: e.controller, admission: { ...e.admission }, scope: e.scope }));
}));

test('private Source RPC issues a ticket that the actual MCP HTTP route consumes once', () => equipment(async e => {
  const transport = await createNativeSourceAdmissionTransport({ controller: e.controller, scope: e.scope, readPlan: e.readPlan, workerTools: true });
  try {
    const client = createNativeSourceAdmissionClient(transport);
    const stream = await fetch(client.toolConfig.serverUrl, { headers: client.toolConfig.headers });
    assert.equal(stream.status, 405);
    assert.equal(stream.headers.get('allow'), 'POST');
    assert.equal((await fetch(client.toolConfig.serverUrl)).status, 401);
    assert.equal((await fetch(client.toolConfig.serverUrl, { headers: { ...client.toolConfig.headers, Origin: 'http://foreign' } })).status, 403);
    const context = await client.admit(`Bearer ${e.token}`, e.claim);
    await client.bindRun(context, e.claim.rootConversationId, 'source-logical-run');
    const call = async params => fetch(client.toolConfig.serverUrl, { method: 'POST', headers: { ...client.toolConfig.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) });
    const args = { path: 'repo/file', content: 'Wire fixture only' };
    assert.equal((await call({ name: 'worker_write_file', arguments: args })).status, 403);
    const issued = await client.issueTool(context, 'worker_write_file', args);
    const params = { name: 'worker_write_file', arguments: args, _meta: { seagulledNative: issued, progressToken: 1 } };
    const received = await call(params); assert.equal(received.status, 200);
    const body = await received.json(); assert.equal(body.result._meta.seagulledNative.ticket, issued.ticket);
    assert.equal((await call(params)).status, 403); assert.equal(e.calls.length, 1); assert.equal(e.holds(), 0);
    const second = await client.issueTool(context, 'worker_write_file', args);
    assert.equal((await call({ ...params, arguments: { ...args, path: 'repo/other' }, _meta: { seagulledNative: second } })).status, 403);
    assert.equal(e.calls.length, 1);
  } finally { await transport.close(); }
}));
