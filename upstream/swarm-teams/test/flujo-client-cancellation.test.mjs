import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { FlujoClient, rawRequest } from '../lib/flujo-client.mjs';

test('FLUJO HTTP deadline is absolute even while a server keeps sending bytes', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    const interval = setInterval(() => response.write('.'), 10);
    response.on('close', () => clearInterval(interval));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const started = Date.now();
    await assert.rejects(rawRequest(`http://127.0.0.1:${server.address().port}/`, { timeoutMs: 80 }), /timeout after 80 ms/);
    assert.ok(Date.now() - started < 1000);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('serverTools encodes a server name and returns the installed tool inventory', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, workspace: request.headers['x-flujo-workspace'],
      authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ tools: [{ name: 'read_file' }, { name: 'search_files' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const client = new FlujoClient({ origin, workspace: 'fixture-workspace', token: 'fixture-control-token' });
    assert.deepEqual(await client.serverTools('owner/tool name'), {
      tools: [{ name: 'read_file' }, { name: 'search_files' }],
      error: undefined,
    });
    assert.deepEqual(requests, [{
      path: '/api/mcp/servers/owner%2Ftool%20name/tools?workspace=fixture-workspace',
      workspace: 'fixture-workspace', authorization: 'Bearer fixture-control-token',
    }]);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('FLUJO Stop refuses new REST calls and holds an interrupted flow submission', async () => {
  const requests = [];
  const controller = new AbortController();
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${new URL(request.url, 'http://local').pathname}`);
    request.resume();
    if (request.url.startsWith('/v1/chat/completions')) request.on('end', () => controller.abort());
    else response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(new FlujoClient({ origin, workspace: 'fixture', signal: stopped.signal }).workspaces(),
      (error) => error.name === 'AbortError' && error.outcome === 'not_applied');
    await assert.rejects(new FlujoClient({ origin, workspace: 'fixture', deadlineAt: Date.now() - 1 }).workspaces(),
      /deadline passed before submission/);
    assert.deepEqual(requests, []);
    const client = new FlujoClient({ origin, workspace: 'fixture', signal: controller.signal });
    const result = await client.runFlow({ flowName: 'swarm_boot', prompt: 'fixture', timeoutMs: 1000 });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(requests, ['POST /v1/chat/completions']);
    await assert.rejects(client.workspaces(), (error) => error.name === 'AbortError');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Stop during FLUJO reconciliation GET or poll delay returns the original unknown run promptly', async () => {
  for (const stage of ['get', 'delay']) {
    const requests = [];
    const controller = new AbortController();
    let abortTimer;
    const server = http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://local').pathname;
      requests.push(`${request.method} ${pathname}`);
      request.resume();
      if (request.method === 'POST' && pathname === '/v1/chat/completions') {
        response.writeHead(502); response.end('{}');
      } else if (request.method === 'GET' && pathname.startsWith('/v1/chat/conversations/')) {
        if (stage === 'get') request.on('end', () => controller.abort());
        else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 'running' }));
          abortTimer = setTimeout(() => controller.abort(), 100);
        }
      } else { response.writeHead(404); response.end('{}'); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const conversationId = `fixture-${stage}`;
      const started = Date.now();
      const result = await new FlujoClient({ origin, workspace: 'fixture', signal: controller.signal })
        .runFlow({ flowName: 'swarm_boot', prompt: 'fixture', conversationId, timeoutMs: 5000, pollMs: 3000 });
      assert.equal(result.status, 'unknown', stage);
      assert.equal(result.conversationId, conversationId, stage);
      assert.match(result.error, /original outcome is unconfirmed/, stage);
      assert.ok(Date.now() - started < 1000, `${stage} Stop should not wait for another poll`);
      assert.deepEqual(requests, [
        'POST /v1/chat/completions', `GET /v1/chat/conversations/${conversationId}`,
      ], stage);
    } finally {
      clearTimeout(abortTimer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
