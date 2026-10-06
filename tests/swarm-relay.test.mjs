import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelay, startRelayAgent } from '@flujo-app/swarm-teams/fleet/relay.mjs';
import { PRODUCT_RELAY_LIMITS } from '../src/swarm/relay.mjs';

const secret = 'relay-fixture-secret-with-at-least-32-characters';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
};
const waitFor = async (condition, label, attempts = 300) => {
  for (let i = 0; i < attempts; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
};
const auth = { Authorization: `Bearer ${secret}` };
const incompletePost = (url, contentLength, part, headers = {}) => {
  const request = http.request(url, { method: 'POST', headers: {
    'Content-Length': String(contentLength), ...headers,
  } });
  const result = new Promise((resolve) => {
    request.on('response', (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', () => resolve('closed'));
  });
  request.write(part);
  return { request, result };
};

test('relay validates finite limits and keeps 60 permitted conversations possible by default', () => {
  assert.throws(() => createRelay({ secret, limits: { maxInFlight: Infinity } }), /Invalid relay limit/);
  assert.throws(() => createRelay({ secret, limits: { maxQueued: 0 } }), /Invalid relay limit/);
  assert.throws(() => createRelay({ secret, limits: { maxPollResponseBytes: 64 } }), /cannot carry/);
  assert.throws(() => startRelayAgent({ lanes: 0 }), /lane count/);
  const relay = createRelay({ secret });
  relay.close();
});

test('five waiting parents and twenty children finish under finite controller serve capacity', async () => {
  const parents = Array.from({ length: 5 }, deferred);
  const seen = new Map();
  const childCount = Array(5).fill(0);
  const controller = http.createServer(async (request, response) => {
    seen.set(request.url, (seen.get(request.url) ?? 0) + 1);
    const parent = /^\/parent\/(\d+)$/.exec(request.url);
    const child = /^\/child\/(\d+)\/(\d+)$/.exec(request.url);
    if (parent) {
      await parents[Number(parent[1])].promise;
      response.end('parent-done');
    } else if (child) {
      const index = Number(child[1]);
      childCount[index]++;
      if (childCount[index] === 4) parents[index].resolve();
      response.end('child-done');
    } else response.writeHead(404).end();
  });
  const relay = createRelay({ secret, limits: { requestTimeoutMs: 5000, pollTimeoutMs: 30 } });
  const controllerOrigin = await listen(controller);
  const relayOrigin = await listen(relay);
  const agent = startRelayAgent({ controllerOrigin, relayOrigin, secret, lanes: 2,
    limits: { maxConcurrentServes: 25, requestTimeoutMs: 5000, pollTimeoutMs: 30 } });
  try {
    const parentResponses = Array.from({ length: 5 }, (_, i) => fetch(`${relayOrigin}/parent/${i}`));
    await waitFor(() => Array.from({ length: 5 }, (_, i) => seen.get(`/parent/${i}`) === 1), 'five held parents');
    const childResponses = Array.from({ length: 20 }, (_, n) =>
      fetch(`${relayOrigin}/child/${Math.floor(n / 4)}/${n % 4}`));
    const responses = await Promise.all([...parentResponses, ...childResponses]);
    assert.ok(responses.every((response) => response.status === 200));
    assert.deepEqual(await Promise.all(responses.map((response) => response.text())),
      [...Array(5).fill('parent-done'), ...Array(20).fill('child-done')]);
    assert.equal(seen.size, 25);
    assert.ok([...seen.values()].every((count) => count === 1), 'every original controller call executes once');
  } finally {
    await agent.stop();
    await close(relay);
    await close(controller);
  }
});

test('default limits carry twelve Workers with five actual conversations each', async () => {
  const parents = Array.from({ length: 12 }, deferred);
  const children = Array(12).fill(0);
  const seen = new Map();
  const controller = http.createServer(async (request, response) => {
    seen.set(request.url, (seen.get(request.url) ?? 0) + 1);
    const [, kind, worker] = /^\/(parent|child)\/(\d+)/.exec(request.url) ?? [];
    if (kind === 'parent') await parents[Number(worker)].promise;
    if (kind === 'child' && ++children[Number(worker)] === 4) parents[Number(worker)].resolve();
    response.end('done');
  });
  const relay = createRelay({ secret });
  const controllerOrigin = await listen(controller);
  const relayOrigin = await listen(relay);
  const agent = startRelayAgent({ controllerOrigin, relayOrigin, secret, lanes: 2 });
  try {
    const held = Array.from({ length: 12 }, (_, i) => fetch(`${relayOrigin}/parent/${i}`));
    await waitFor(() => Array.from({ length: 12 }, (_, i) => seen.get(`/parent/${i}`) === 1),
      'twelve waiting parents');
    const leaves = Array.from({ length: 48 }, (_, n) =>
      fetch(`${relayOrigin}/child/${Math.floor(n / 4)}/${n % 4}`));
    const responses = await Promise.all([...held, ...leaves]);
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(seen.size, 60);
    assert.ok([...seen.values()].every((count) => count === 1));
  } finally {
    for (const parent of parents) parent.resolve();
    await agent.stop();
    await close(relay);
    await close(controller);
  }
});

test('product relay admits ten held parents and ninety children without starving their original requests', async () => {
  const releaseParents = deferred(), releaseChildren = deferred(), seen = new Map();
  let active = 0, peak = 0;
  const controller = http.createServer(async (request, response) => {
    seen.set(request.url, (seen.get(request.url) ?? 0) + 1);
    peak = Math.max(peak, ++active);
    if (request.url.startsWith('/parent/')) await releaseParents.promise;
    else { if ([...seen.keys()].filter(key => key.startsWith('/child/')).length === 90) releaseChildren.resolve(); await releaseChildren.promise; }
    response.end('done'); active--;
  });
  const relay = createRelay({ secret });
  const controllerOrigin = await listen(controller), relayOrigin = await listen(relay);
  const agent = startRelayAgent({ controllerOrigin, relayOrigin, secret, lanes: 2, limits: PRODUCT_RELAY_LIMITS });
  try {
    const parents = Array.from({ length: 10 }, (_, index) => fetch(`${relayOrigin}/parent/${index}`));
    await waitFor(() => seen.size === 10, 'ten held parent requests');
    const children = Array.from({ length: 90 }, (_, index) => fetch(`${relayOrigin}/child/${index}`));
    await waitFor(() => seen.size === 100, 'all ninety children while ten parents remain held');
    assert.ok((await Promise.all(children)).every(response => response.status === 200));
    assert.equal(peak, 100);
    releaseParents.resolve();
    assert.ok((await Promise.all(parents)).every(response => response.status === 200));
    assert.ok([...seen.values()].every(count => count === 1), 'no original request is replayed');
  } finally { releaseParents.resolve(); releaseChildren.resolve(); await agent.stop(); await close(relay); await close(controller); }
});

test('controller serves never exceed the configured slot count', async () => {
  const release = deferred();
  let active = 0;
  let peak = 0;
  const seen = new Map();
  const controller = http.createServer(async (request, response) => {
    seen.set(request.url, (seen.get(request.url) ?? 0) + 1);
    active++;
    peak = Math.max(peak, active);
    await release.promise;
    active--;
    response.end('done');
  });
  const limits = { maxConcurrentServes: 2, requestTimeoutMs: 2000, pollTimeoutMs: 20 };
  const relay = createRelay({ secret, limits });
  const controllerOrigin = await listen(controller);
  const relayOrigin = await listen(relay);
  const agent = startRelayAgent({ controllerOrigin, relayOrigin, secret, lanes: 2, limits });
  try {
    const workers = Array.from({ length: 5 }, (_, index) => fetch(`${relayOrigin}/slot/${index}`));
    await waitFor(() => seen.size === 2, 'two occupied controller slots');
    assert.equal(peak, 2);
    release.resolve();
    assert.ok((await Promise.all(workers)).every((response) => response.status === 200));
    assert.equal(peak, 2);
    assert.equal(seen.size, 5);
    assert.ok([...seen.values()].every((count) => count === 1));
  } finally {
    release.resolve();
    await agent.stop();
    await close(relay);
    await close(controller);
  }
});

test('queue and poller overload reject before dispatch and disconnected waiters are removed', async () => {
  const relay = createRelay({ secret, limits: { maxInFlight: 1, maxQueued: 1, maxPollers: 1,
    pollTimeoutMs: 35, requestTimeoutMs: 300 } });
  const origin = await listen(relay);
  const workerAbort = new AbortController();
  const pollAbort = new AbortController();
  try {
    const worker = fetch(`${origin}/work`, { signal: workerAbort.signal }).catch(() => undefined);
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).waiting === 1, 'one queued worker');
    const overloaded = await fetch(`${origin}/another`);
    assert.equal(overloaded.status, 503);
    assert.equal((await overloaded.json()).outcome, 'not-dispatched');
    const firstPoll = fetch(`${origin}/__relay/poll`, { method: 'POST', headers: auth, signal: pollAbort.signal });
    const [{ id }] = await (await firstPoll).json();
    assert.ok(id);
    const secondPoll = fetch(`${origin}/__relay/poll`, { method: 'POST', headers: auth, signal: pollAbort.signal }).catch(() => undefined);
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).agents === 1, 'one waiting poller');
    assert.equal((await fetch(`${origin}/__relay/poll`, { method: 'POST', headers: auth })).status, 503);
    pollAbort.abort();
    await secondPoll;
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).agents === 0, 'poller cleanup');
    workerAbort.abort();
    await worker;
    const health = await (await fetch(`${origin}/health`)).json();
    assert.equal(health.waiting, 0);
    assert.equal((await fetch(`${origin}/__relay/respond`, { method: 'POST', headers: auth,
      body: JSON.stringify({ id, status: 200, body: 'late' }) })).status, 410);
  } finally { await close(relay); }
});

test('a slow incoming body reserves admission capacity before it can enter the queue', async () => {
  const relay = createRelay({ secret, limits: { maxInFlight: 1, maxQueued: 1,
    requestTimeoutMs: 50, pollTimeoutMs: 20 } });
  const origin = await listen(relay);
  const slow = http.request(`${origin}/slow`, { method: 'POST', headers: { 'Content-Length': '10' } });
  slow.on('error', () => undefined);
  try {
    slow.write('a');
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).reading === 1,
      'reserved body reader');
    const overloaded = await fetch(`${origin}/rejected`);
    assert.equal(overloaded.status, 503);
    assert.equal((await overloaded.json()).outcome, 'not-dispatched');
    slow.destroy();
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).reading === 0,
      'aborted body reader cleanup');
    const next = await fetch(`${origin}/next`);
    assert.equal(next.status, 504);
    assert.equal((await next.json()).outcome, 'unknown');
  } finally {
    slow.destroy();
    await close(relay);
  }
});

test('aggregate buffered-byte admission releases space on disconnect', async () => {
  const relay = createRelay({ secret, limits: { maxRequestBytes: 1024, maxBufferedBytes: 2048,
    requestTimeoutMs: 1000, pollTimeoutMs: 20 } });
  const origin = await listen(relay);
  const firstAbort = new AbortController();
  try {
    const first = fetch(`${origin}/buffered`, { method: 'POST', body: 'a'.repeat(1000),
      signal: firstAbort.signal }).catch(() => undefined);
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).waiting === 1,
      'buffered original');
    const firstBytes = (await (await fetch(`${origin}/health`)).json()).bufferedBytes;
    assert.ok(firstBytes > 1000);
    const rejected = await fetch(`${origin}/overflow`, { method: 'POST', body: 'b'.repeat(1000) });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).outcome, 'not-dispatched');
    firstAbort.abort();
    await first;
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).bufferedBytes === 0,
      'buffered-byte cleanup');
    const nextAbort = new AbortController();
    const next = fetch(`${origin}/next`, { method: 'POST', body: 'c'.repeat(1000),
      signal: nextAbort.signal }).catch(() => undefined);
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).waiting === 1,
      'new request after buffer release');
    nextAbort.abort();
    await next;
  } finally {
    firstAbort.abort();
    await close(relay);
  }
});

test('overlapping slow bodies share a byte pool and release it on rejection or disconnect', async () => {
  const relay = createRelay({ secret, limits: { maxRequestBytes: 1024, maxBufferedBytes: 2048,
    requestTimeoutMs: 1000, pollTimeoutMs: 20 } });
  const origin = await listen(relay);
  const first = incompletePost(`${origin}/slow-1`, 1000, 'a'.repeat(900));
  const second = incompletePost(`${origin}/slow-2`, 1000, 'b'.repeat(900));
  let recovered;
  try {
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).readingBytes === 1800,
      'two overlapping upload reservations');
    const rejected = incompletePost(`${origin}/slow-3`, 1000, 'c'.repeat(400));
    assert.equal(await rejected.result, 503);
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).readingBytes === 1800,
      'rejected bytes released');
    first.request.destroy();
    await first.result;
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).readingBytes === 900,
      'disconnected upload released');
    recovered = incompletePost(`${origin}/slow-4`, 1000, 'd'.repeat(400));
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).readingBytes === 1300,
      'new upload after release');
  } finally {
    first.request.destroy();
    second.request.destroy();
    recovered?.request.destroy();
    await close(relay);
  }
});

test('concurrent escaped reply uploads are budgeted before JSON decoding', async () => {
  const relay = createRelay({ secret, limits: { maxRequestBytes: 1024, maxBufferedBytes: 2048,
    maxWorkerResponseBytes: 128, maxPollResponseBytes: 2048,
    requestTimeoutMs: 1000, pollTimeoutMs: 20 } });
  const origin = await listen(relay);
  let first;
  let second;
  try {
    const worker = fetch(`${origin}/reply-origin`);
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).waiting === 1,
      'reply original');
    const [{ id }] = await (await fetch(`${origin}/__relay/poll`, {
      method: 'POST', headers: auth,
    })).json();
    const prefix = `{"id":"${id}","status":200,"body":"`;
    const escaped = prefix + '\\u0000'.repeat(130);
    first = incompletePost(`${origin}/__relay/respond`, 1700, escaped, auth);
    second = incompletePost(`${origin}/__relay/respond`, 1700, escaped, auth);
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).readingBytes
      >= escaped.length * 2, 'two escaped reply reservations');
    const rejected = incompletePost(`${origin}/__relay/respond`, 1700,
      prefix + '\\u0000'.repeat(60), auth);
    assert.equal(await rejected.result, 503);
    first.request.destroy();
    second.request.destroy();
    await Promise.all([first.result, second.result]);
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).readingBytes === 0,
      'reply read reservations released');
    const completed = await fetch(`${origin}/__relay/respond`, { method: 'POST', headers: auth,
      body: JSON.stringify({ id, status: 200, body: 'ok' }) });
    assert.equal(completed.status, 200);
    assert.equal((await worker).status, 200);
  } finally {
    first?.request.destroy();
    second?.request.destroy();
    await close(relay);
  }
});

test('incoming and outgoing body bounds retain exact original ID and never replay', async () => {
  let controllerCalls = 0;
  const controller = http.createServer((_request, response) => {
    controllerCalls++;
    response.end('x'.repeat(1024));
  });
  const limits = { maxRequestBytes: 64, maxPollResponseBytes: 2048,
    maxControllerResponseBytes: 128, maxWorkerResponseBytes: 128,
    requestTimeoutMs: 500, pollTimeoutMs: 20 };
  const relay = createRelay({ secret, limits });
  const controllerOrigin = await listen(controller);
  const relayOrigin = await listen(relay);
  const agent = startRelayAgent({ controllerOrigin, relayOrigin, secret, lanes: 2, limits });
  try {
    const incoming = await fetch(`${relayOrigin}/large-input`, { method: 'POST', body: 'a'.repeat(65) });
    assert.equal(incoming.status, 413);
    assert.equal(controllerCalls, 0);
    const output = await fetch(`${relayOrigin}/large-output`);
    assert.equal(output.status, 502);
    assert.deepEqual(await output.json(), { error: 'CONTROLLER_RESPONSE_TOO_LARGE', outcome: 'unknown' });
    assert.equal(controllerCalls, 1);
  } finally {
    await agent.stop();
    await close(relay);
    await close(controller);
  }
});

test('an oversized answer settles its original ID as unknown and a duplicate answer is refused', async () => {
  const relay = createRelay({ secret, limits: { maxRequestBytes: 64, maxPollResponseBytes: 2048,
    maxWorkerResponseBytes: 128, requestTimeoutMs: 300, pollTimeoutMs: 20 } });
  const origin = await listen(relay);
  try {
    const worker = fetch(`${origin}/original`);
    await waitFor(async () => (await (await fetch(`${origin}/health`)).json()).waiting === 1,
      'queued original');
    const poll = await fetch(`${origin}/__relay/poll`, { method: 'POST', headers: auth });
    const [{ id }] = await poll.json();
    const oversized = await fetch(`${origin}/__relay/respond`, { method: 'POST', headers: auth,
      body: JSON.stringify({ id, status: 200, body: 'y'.repeat(129) }) });
    assert.equal(oversized.status, 413);
    const result = await worker;
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: 'CONTROLLER_RESPONSE_TOO_LARGE', outcome: 'unknown' });
    const duplicate = await fetch(`${origin}/__relay/respond`, { method: 'POST', headers: auth,
      body: JSON.stringify({ id, status: 200, body: 'replay' }) });
    assert.equal(duplicate.status, 410);
    const next = await fetch(`${origin}/__relay/poll`, { method: 'POST', headers: auth });
    assert.deepEqual(await next.json(), []);
  } finally { await close(relay); }
});

test('Stop aborts the agent and leaves one dispatched controller effect unknown without replay', async () => {
  const release = deferred();
  let calls = 0;
  const controller = http.createServer(async (_request, response) => {
    calls++;
    await release.promise;
    response.end('late');
  });
  const limits = { requestTimeoutMs: 90, pollTimeoutMs: 20, maxConcurrentServes: 1 };
  const relay = createRelay({ secret, limits });
  const controllerOrigin = await listen(controller);
  const relayOrigin = await listen(relay);
  const agent = startRelayAgent({ controllerOrigin, relayOrigin, secret, lanes: 2, limits });
  try {
    const worker = fetch(`${relayOrigin}/effect`);
    await waitFor(() => calls === 1, 'original controller effect');
    await agent.stop();
    release.resolve();
    const result = await worker;
    assert.equal(result.status, 504);
    assert.deepEqual(await result.json(), { error: 'RELAY_TIMEOUT', outcome: 'unknown' });
    assert.equal(calls, 1);
  } finally {
    release.resolve();
    await agent.stop();
    await close(relay);
    await close(controller);
  }
});

test('controller 307 cannot reissue an effectful POST or leave its selected origin', async () => {
  let original = 0;
  let redirected = 0;
  const controller = http.createServer((request, response) => {
    if (request.url === '/effect') {
      original++;
      response.writeHead(307, { Location: '/second-effect' }).end();
    } else {
      redirected++;
      response.end('replayed');
    }
  });
  const limits = { requestTimeoutMs: 1000, pollTimeoutMs: 20 };
  const relay = createRelay({ secret, limits });
  const controllerOrigin = await listen(controller);
  const relayOrigin = await listen(relay);
  const agent = startRelayAgent({ controllerOrigin, relayOrigin, secret, lanes: 2, limits });
  try {
    const worker = await fetch(`${relayOrigin}/effect`, { method: 'POST', body: '{"change":true}' });
    assert.equal(worker.status, 502);
    assert.deepEqual(await worker.json(), { error: 'CONTROLLER_REDIRECT_REFUSED', outcome: 'unknown' });
    assert.equal(original, 1);
    assert.equal(redirected, 0);
  } finally {
    await agent.stop();
    await close(relay);
    await close(controller);
  }
});

test('secret-bearing poll and reply redirects do not reach a second endpoint', async () => {
  let redirected = 0;
  let controllerCalls = 0;
  let replies = 0;
  let polls = 0;
  const sink = http.createServer((_request, response) => { redirected++; response.end('redirected'); });
  const sinkOrigin = await listen(sink);
  const controller = http.createServer((_request, response) => { controllerCalls++; response.end('done'); });
  const controllerOrigin = await listen(controller);
  const fakeRelay = http.createServer((request, response) => {
    if (request.url.startsWith('/__relay/poll')) {
      polls++;
      if (polls === 1) return response.writeHead(307, { Location: `${sinkOrigin}/stolen-poll` }).end();
      if (polls === 2) return response.end(JSON.stringify([{
        id: 'original-fixture-id', method: 'POST', path: '/one', authorization: '', body: '{}',
      }]));
      return response.end('[]');
    }
    if (request.url === '/__relay/respond') {
      replies++;
      return response.writeHead(307, { Location: `${sinkOrigin}/stolen-reply` }).end();
    }
    response.writeHead(404).end();
  });
  const relayOrigin = await listen(fakeRelay);
  const agent = startRelayAgent({ controllerOrigin, relayOrigin, secret, lanes: 1,
    log: () => undefined, limits: { pollTimeoutMs: 20 } });
  try {
    await waitFor(() => polls >= 1, 'redirected poll');
    assert.equal(redirected, 0);
    await waitFor(() => replies === 1, 'redirected reply', 1000);
    assert.equal(controllerCalls, 1);
    assert.equal(redirected, 0);
  } finally {
    await agent.stop();
    await close(fakeRelay);
    await close(controller);
    await close(sink);
  }
});
