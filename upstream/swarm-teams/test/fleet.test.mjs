// Source checks with a scripted FLUJO stand-in. They test the tree rules, auth and the
// MCP surface; they are not model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller, TOOLS } from '../fleet/controller.mjs';
import { Registry } from '../fleet/registry.mjs';
import { workspaceProvisioner } from '../fleet/provisioners.mjs';
import { buildSpecs } from '../template/flows.mjs';
import { rawRequest } from '../lib/flujo-client.mjs';
import { createRelay, startRelayAgent } from '../fleet/relay.mjs';

const OPERATOR = 'operator-token-operator-token-operator-token';
const temporary = () => path.join(mkdtempSync(path.join(tmpdir(), 'swarm-teams-')), 'registry.json');

/** A FLUJO stand-in that records calls and answers flow runs after `delayMs`. */
async function fakeFlujo({ delayMs = 0 } = {}) {
  const state = { workspaces: ['default'], servers: {}, flows: {}, runs: [], injected: [], deleted: [] };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://flujo');
    const workspace = url.searchParams.get('workspace');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /api/workspaces') return send(200, { workspaces: state.workspaces.map((name) => ({ name })) });
    if (route === 'POST /api/workspaces') { state.workspaces.push(body.name); return send(201, {}); }
    if (route === 'DELETE /api/workspaces') { state.deleted.push(body.name); state.workspaces = state.workspaces.filter((name) => name !== body.name); return send(200, {}); }
    if (route === 'GET /api/init') return send(200, {});
    if (route === 'GET /api/model') return send(200, []);
    if (route === 'POST /api/model') return send(201, body);
    if (route === 'GET /api/mcp/servers') return send(200, [{ name: 'bash' }, { name: 'filesystem' }, { name: 'flujo' }, ...Object.values(state.servers[workspace] ?? {})]);
    if (route === 'POST /api/mcp/servers') { (state.servers[workspace] ??= {})[body.name] = body; return send(201, body); }
    if (route === 'GET /api/flow') return send(200, Object.values(state.flows[workspace] ?? {}));
    if (route === 'POST /api/flow/compile') {
      (state.flows[workspace] ??= {})[body.spec.name] = { id: `${workspace}-${body.spec.name}`, name: body.spec.name };
      return send(201, { flow: state.flows[workspace][body.spec.name], saved: true });
    }
    if (route === 'POST /v1/chat/completions') {
      state.runs.push({ workspace, model: body.model, prompt: body.messages[0].content, conversationId: body.metadata.conversationId });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return send(200, { choices: [{ message: { content: `done in ${workspace}` } }] });
    }
    if (/\/inject$/.test(url.pathname)) { state.injected.push(body.content); return send(200, {}); }
    return send(404, { error: route });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function fixture(options) {
  const flujo = await fakeFlujo(options);
  const model = { name: 'm', baseUrl: 'http://model/v1', apiKey: 'k', contextWindow: 1000 };
  const controller = new Controller({ registryPath: temporary(), operatorToken: OPERATOR, publicUrl: 'http://127.0.0.1:1',
    provisioner: workspaceProvisioner({ origin: flujo.origin, model }) });
  const address = await controller.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (token, method, route, body) => {
    const response = await rawRequest(base + route, { method, body, headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: response.text ? JSON.parse(response.text) : null };
  };
  const tool = async (token, name, args = {}) => {
    const reply = await call(token, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const text = reply.body.result.content[0].text;
    return reply.body.result.isError ? { error: text } : JSON.parse(text);
  };
  return { flujo, controller, model, call, tool, close: async () => { await controller.close(); await flujo.close(); } };
}

test('registry enforces worker count, depth and fan-out', () => {
  const registry = new Registry(temporary());
  const goal = registry.createGoal({ text: 'g', limits: { maxWorkers: 3, maxDepth: 2, maxChildren: 2 } });
  const root = registry.reserve({ goalId: goal.id }).worker;
  assert.throws(() => registry.reserve({ goalId: goal.id }), /already has a supervisor/);
  const a = registry.reserve({ goalId: goal.id, parentId: root.id }).worker;
  registry.reserve({ goalId: goal.id, parentId: root.id });
  assert.throws(() => registry.reserve({ goalId: goal.id, parentId: root.id }), /already has 2 children/);
  const deep = registry.reserve({ goalId: goal.id, parentId: a.id }).worker;
  assert.throws(() => registry.reserve({ goalId: goal.id, parentId: deep.id }), /Tree depth 2 reached/);
  assert.throws(() => registry.reserve({ goalId: goal.id, parentId: a.id }), /all 3 Workers/);
  registry.retire(deep.id);
  assert.equal(registry.reserve({ goalId: goal.id, parentId: a.id }).worker.depth, 2, 'a retired Worker frees its slot');
});

test('registry survives a restart and marks in-flight runs unknown instead of replaying them', () => {
  const file = temporary();
  const first = new Registry(file);
  const goal = first.createGoal({ text: 'g' });
  const { worker, token } = first.reserve({ goalId: goal.id });
  first.enroll(worker.id, { kind: 'external' });
  const run = first.startRun({ workerId: worker.id, startedBy: 'operator', task: 't', flowName: 'f' });
  const second = new Registry(file);
  assert.equal(second.run(run.id).state, 'unknown');
  assert.equal(second.actorFor(token).id, worker.id);
  assert.equal(JSON.stringify(second.state).includes(token), false, 'bearers are stored only as hashes');
});

test('controller preserves an explicit goal id and rejects its collision before installing again', async () => {
  const { flujo, controller, model, close } = await fixture();
  try {
    const supervisor = { origin: flujo.origin, workspace: 'default' };
    const first = await controller.createGoal({ id: 'case-stable-123', text: 'First request',
      supervisor, model, start: false });
    assert.equal(first.goal.id, 'case-stable-123');
    const previousGoals = Object.keys(controller.registry.state.goals);
    const previousWorkers = Object.keys(controller.registry.state.workers);
    await assert.rejects(controller.createGoal({ id: 'case-stable-123', text: 'Second request',
      supervisor, model, start: false }), (error) => error.code === 'CONFLICT');
    assert.deepEqual(Object.keys(controller.registry.state.goals), previousGoals);
    assert.deepEqual(Object.keys(controller.registry.state.workers), previousWorkers);
  } finally { await close(); }
});

test('flow specs wire only connected servers and keep ten parallel agents per team', () => {
  const [agent, team, supervisor] = buildSpecs({ model: 'm', availableServers: ['bash', 'filesystem', 'flujo', 'fleet'] });
  assert.deepEqual(agent.nodes[1].servers.map((server) => server.name), ['bash', 'filesystem', 'flujo', 'fleet']);
  assert.equal(team.nodes.find((node) => node.type === 'subflow').concurrencyLimit, 10);
  assert.ok(supervisor.nodes[1].servers.find((server) => server.name === 'fleet').tools.includes('goal_finish'));
  assert.equal(team.nodes[1].servers.find((server) => server.name === 'fleet').tools.includes('goal_finish'), false);
  for (const spec of [agent, team, supervisor]) {
    const offered = spec.nodes.flatMap((node) => node.servers ?? []).filter((server) => server.name === 'fleet').flatMap((server) => server.tools);
    for (const name of offered) assert.ok(TOOLS.some((tool) => tool.name === name), `${name} exists on the controller`);
  }
});

test('a goal installs the supervisor, which grows a tree through the MCP tools', async () => {
  const { flujo, controller, model, call, tool, close } = await fixture();
  try {
    assert.equal((await call('wrong-token-wrong-token-wrong-token', 'GET', '/goals/x')).status, 401);
    const created = await call(OPERATOR, 'POST', '/goals', { text: 'Ship it', model, limits: { maxChildren: 2 },
      supervisor: { origin: flujo.origin, workspace: 'sup' } });
    assert.equal(created.status, 201);
    await controller.settled.get(created.body.runId);
    assert.equal(flujo.state.runs[0].model, 'flow-swarm_supervisor');
    assert.match(flujo.state.runs[0].prompt, /Ship it/);
    const fleetEntry = flujo.state.servers.sup.fleet;
    assert.equal(fleetEntry.transport, 'streamable');
    const supervisorToken = fleetEntry.headers.Authorization.value.replace('Bearer ', '');

    const listed = await call(supervisorToken, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(listed.body.result.tools.length, TOOLS.length);
    assert.equal((await call(supervisorToken, 'POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

    const child = await tool(supervisorToken, 'fleet_delegate', { name: 'approach-a', task: 'Try A' });
    const finished = await tool(supervisorToken, 'fleet_wait', { runId: child.runId, timeoutMs: 5000 });
    assert.equal(finished.state, 'completed');
    assert.equal(finished.result, `done in swarm-${child.workerId}`);
    assert.match(flujo.state.runs.at(-1).prompt, /Ship it[\s\S]*Try A/);
    assert.equal(flujo.state.runs.at(-1).model, 'flow-swarm_team');

    // The child has its own identity: it can post to the board but not finish the goal or touch its parent.
    const childToken = flujo.state.servers[`swarm-${child.workerId}`].fleet.headers.Authorization.value.replace('Bearer ', '');
    assert.notEqual(childToken, supervisorToken);
    assert.equal((await tool(childToken, 'board_post', { topic: 'finding', text: 'A works' })).seq, 1);
    assert.match((await tool(childToken, 'goal_finish', { result: 'x' })).error, /FORBIDDEN/);
    assert.match((await tool(childToken, 'fleet_retire_worker', { workerId: created.body.supervisorId })).error, /FORBIDDEN/);
    assert.equal((await tool(supervisorToken, 'board_read', {})).posts[0].text, 'A works');

    await tool(supervisorToken, 'fleet_delegate', { name: 'approach-b', task: 'Try B' });
    assert.match((await tool(supervisorToken, 'fleet_delegate', { name: 'approach-c', task: 'Try C' })).error, /CAPACITY/);
    const info = await tool(supervisorToken, 'fleet_info');
    assert.equal(info.capacity.yourChildrenLeft, 0);
    assert.equal(info.tree.length, 3);

    // A grandchild is retired together with its parent, and the sandbox is deleted.
    const grandchild = await tool(childToken, 'fleet_delegate', { name: 'sub', task: 'Part' });
    await tool(childToken, 'fleet_wait', { runId: grandchild.runId, timeoutMs: 5000 });
    const retired = await tool(supervisorToken, 'fleet_retire_worker', { workerId: child.workerId });
    assert.deepEqual(retired.retired, [grandchild.workerId, child.workerId]);
    assert.deepEqual(flujo.state.deleted, [`swarm-${grandchild.workerId}`, `swarm-${child.workerId}`]);
    assert.equal((await call(childToken, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401, 'a retired Worker loses its bearer');

    assert.equal((await tool(supervisorToken, 'goal_finish', { result: 'Delivered' })).state, 'done');
    assert.equal((await call(OPERATOR, 'GET', `/goals/${created.body.goal.id}`)).body.goal.result, 'Delivered');
    assert.match((await tool(supervisorToken, 'fleet_delegate', { name: 'late', task: 'x' })).error, /GOAL_CLOSED/);
  } finally { await close(); }
});

test('a running team can be steered and a wait timeout is not an error', async () => {
  const { flujo, controller, model, call, tool, close } = await fixture({ delayMs: 400 });
  try {
    const created = await call(OPERATOR, 'POST', '/goals', { text: 'Long goal', model, supervisor: { origin: flujo.origin, workspace: 'sup' } });
    const token = flujo.state.servers.sup.fleet.headers.Authorization.value.replace('Bearer ', '');
    const child = await tool(token, 'fleet_delegate', { name: 'slow', task: 'Slow work' });
    await controller.provisioning.get(child.workerId);
    assert.equal((await tool(token, 'fleet_wait', { runId: child.runId, timeoutMs: 20 })).state, 'running');
    assert.equal((await tool(token, 'fleet_message', { runId: child.runId, message: 'Focus on X' })).status, 'queued');
    assert.match(flujo.state.injected[0], /Focus on X/);
    assert.equal((await tool(token, 'fleet_wait', { runId: child.runId, timeoutMs: 5000 })).state, 'completed');
    assert.match((await tool(token, 'fleet_message', { runId: child.runId, message: 'late' })).error, /NOT_RUNNING/);
    await controller.settled.get(created.body.runId);
  } finally { await close(); }
});

test('the relay carries a Worker request to the controller and the answer back', async () => {
  const secret = 'relay-secret-relay-secret-relay-secret';
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(request.headers.authorization === 'Bearer worker-token' ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ path: request.url, echoed: Buffer.concat(chunks).toString('utf8') }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const relay = createRelay({ secret });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const relayOrigin = `http://127.0.0.1:${relay.address().port}`;
  const agent = startRelayAgent({ relayOrigin, secret, controllerOrigin: `http://127.0.0.1:${upstream.address().port}`, lanes: 2 });
  try {
    const ok = await rawRequest(`${relayOrigin}/mcp`, { method: 'POST', body: { hello: 1 }, headers: { Authorization: 'Bearer worker-token' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { path: '/mcp', echoed: '{"hello":1}' });
    const denied = await rawRequest(`${relayOrigin}/mcp`, { method: 'POST', body: {}, headers: { Authorization: 'Bearer wrong' } });
    assert.equal(denied.status, 401, 'the controller, not the relay, decides who a Worker is');
    assert.equal((await rawRequest(`${relayOrigin}/__relay/poll`, { method: 'POST', headers: { Authorization: 'Bearer guess-guess-guess-guess-guess-guess-xx' } })).status, 401);
  } finally {
    agent.stop();
    relay.closeAllConnections(); relay.close();
    upstream.closeAllConnections(); upstream.close();
  }
});
