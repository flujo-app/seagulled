// Bounded memory-only transport. Once an original request is dispatched it is
// never queued again, including after timeout, disconnect, Stop or lost answer.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.RELAY_SECRET ?? '';
const PORT = Number(process.env.RELAY_PORT ?? 4300);
const DEFAULTS = Object.freeze({
  requestTimeoutMs: 120_000, pollTimeoutMs: 25_000,
  maxRequestBytes: 2 * 1024 * 1024, maxWorkerResponseBytes: 1024 * 1024,
  maxPollResponseBytes: 8 * 1024 * 1024, maxControllerResponseBytes: 1024 * 1024,
  maxQueued: 128, maxInFlight: 128, maxBufferedBytes: 32 * 1024 * 1024,
  maxPollers: 16, maxPollBatch: 16,
  maxConcurrentServes: 64,
});
const CEILINGS = Object.freeze({
  requestTimeoutMs: 600_000, pollTimeoutMs: 120_000,
  maxRequestBytes: 16 * 1024 * 1024, maxWorkerResponseBytes: 16 * 1024 * 1024,
  maxPollResponseBytes: 64 * 1024 * 1024, maxControllerResponseBytes: 16 * 1024 * 1024,
  maxQueued: 1024, maxInFlight: 1024, maxBufferedBytes: 64 * 1024 * 1024,
  maxPollers: 128, maxPollBatch: 64,
  maxConcurrentServes: 256,
});
const FAILURE = Object.freeze({
  timeout: '{"error":"RELAY_TIMEOUT","outcome":"unknown"}',
  stopped: '{"error":"RELAY_STOPPED","outcome":"unknown"}',
  oversized: '{"error":"CONTROLLER_RESPONSE_TOO_LARGE","outcome":"unknown"}',
  redirect: '{"error":"CONTROLLER_REDIRECT_REFUSED","outcome":"unknown"}',
  unreachable: '{"error":"CONTROLLER_UNREACHABLE","outcome":"unknown"}',
});

function validateLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid relay limits.');
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULTS, key) || !Number.isSafeInteger(value) || value < 1 || value > CEILINGS[key]) {
      throw new Error(`Invalid relay limit: ${key}.`);
    }
  }
  const limits = { ...DEFAULTS, ...overrides };
  if (limits.maxPollResponseBytes < limits.maxRequestBytes + 1024
    || limits.maxBufferedBytes < limits.maxRequestBytes + 1024
    || limits.maxWorkerResponseBytes < 128) {
    throw new Error('Relay limits cannot carry one bounded request or error.');
  }
  return Object.freeze(limits);
}

function send(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(body);
}

async function readRequest(request, maxBytes, reserve = () => undefined) {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > maxBytes) throw Object.assign(new Error('too large'), { status: 413 });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      request.resume();
      throw Object.assign(new Error('too large'), { status: 413 });
    }
    try { reserve(chunk.length); }
    catch (error) { request.resume(); throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function readResponse(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw Object.assign(new Error('response too large'), { code: 'RESPONSE_TOO_LARGE' });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

export function createRelay({ secret, limits: overrides } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('RELAY_SECRET must be at least 32 characters.');
  const limits = validateLimits(overrides);
  const queue = [];
  const inFlight = new Map();
  const pollers = new Set();
  let admissions = 0;
  let pollAdmissions = 0;
  let replyAdmissions = 0;
  let bufferedBytes = 0;
  let readingBytes = 0;
  const readBounded = async (request, maxBytes, failureBody, overloadBody, consume = () => undefined) => {
    let reserved = 0;
    try {
      const body = await readRequest(request, maxBytes, (length) => {
        if (bufferedBytes + readingBytes + length > limits.maxBufferedBytes) {
          throw Object.assign(new Error('relay read budget exhausted'), { status: 503 });
        }
        readingBytes += length;
        reserved += length;
      });
      return consume(body, reserved); // Keep the read reservation through parse/serialization/admission.
    } catch (error) {
      if (error.status === 413 || error.status === 503) {
        error.responseBody = error.status === 503 ? overloadBody : failureBody;
      }
      throw error;
    } finally {
      readingBytes -= reserved;
    }
  };
  const agent = (request) => {
    const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    const givenBytes = Buffer.from(given);
    const secretBytes = Buffer.from(secret);
    return givenBytes.length === secretBytes.length && timingSafeEqual(givenBytes, secretBytes);
  };
  const forget = (entry) => {
    if (!inFlight.has(entry.item.id)) return;
    clearTimeout(entry.timer);
    inFlight.delete(entry.item.id);
    bufferedBytes -= entry.wireBytes;
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    entry.response.removeListener('close', entry.disconnected);
  };
  const settle = (entry, status, body) => {
    if (!inFlight.has(entry.item.id)) return;
    forget(entry);
    send(entry.response, status, body);
  };
  const take = (limit) => {
    const items = [];
    let bytes = 2;
    while (queue.length && items.length < limit) {
      const entry = queue[0];
      if (bytes + entry.wireBytes + (items.length ? 1 : 0) > limits.maxPollResponseBytes) break;
      queue.shift();
      entry.dispatched = true;
      items.push(entry.item);
      bytes += entry.wireBytes + (items.length > 1 ? 1 : 0);
    }
    return items;
  };
  const wakePoller = () => {
    for (const poller of pollers) {
      if (!queue.length) break;
      poller.finish(take(poller.limit));
    }
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://relay');
      if (url.pathname === '/health') return send(response, 200,
        JSON.stringify({ ok: true, waiting: queue.length, reading: admissions,
          readingBytes, bufferedBytes, agents: pollers.size }));
      if (url.pathname === '/__relay/poll') {
        if (!agent(request)) return send(response, 401, '{"error":"UNAUTHORIZED"}');
        if (pollers.size + pollAdmissions >= limits.maxPollers) return send(response, 503, '{"error":"RELAY_OVERLOADED"}');
        pollAdmissions++;
        try { await readBounded(request, 1024, '{"error":"RELAY_POLL_TOO_LARGE"}',
          '{"error":"RELAY_OVERLOADED"}'); }
        finally { pollAdmissions--; }
        if (response.destroyed) return;
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? limits.maxPollBatch : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxPollBatch) {
          return send(response, 400, '{"error":"INVALID_POLL_LIMIT"}');
        }
        if (queue.length) return send(response, 200, JSON.stringify(take(limit)));
        if (pollers.size >= limits.maxPollers) return send(response, 503, '{"error":"RELAY_OVERLOADED"}');
        const poller = { limit, done: false, timer: undefined, finish(items) {
          if (this.done) return;
          this.done = true;
          clearTimeout(this.timer);
          pollers.delete(this);
          response.removeListener('close', disconnected);
          send(response, 200, JSON.stringify(items));
        } };
        const disconnected = () => { poller.done = true; clearTimeout(poller.timer); pollers.delete(poller); };
        response.once('close', disconnected);
        pollers.add(poller);
        poller.timer = setTimeout(() => poller.finish([]), limits.pollTimeoutMs);
        return;
      }
      if (url.pathname === '/__relay/respond') {
        if (!agent(request)) return send(response, 401, '{"error":"UNAUTHORIZED"}');
        if (replyAdmissions >= limits.maxInFlight) return send(response, 503, '{"error":"RELAY_OVERLOADED"}');
        replyAdmissions++;
        try {
          return await readBounded(request, limits.maxWorkerResponseBytes * 6 + 1024,
            '{"error":"RELAY_RESPONSE_TOO_LARGE","outcome":"unknown"}',
            '{"error":"RELAY_OVERLOADED","outcome":"unknown"}', (payload) => {
              if (response.destroyed) return;
              const answer = JSON.parse(payload);
              if (!answer || typeof answer.id !== 'string' || !Number.isInteger(answer.status)
                || answer.status < 100 || answer.status > 599 || typeof answer.body !== 'string') {
                return send(response, 400, '{"error":"INVALID_ANSWER"}');
              }
              const entry = inFlight.get(answer.id);
              if (!entry || !entry.dispatched) return send(response, 410, '{"error":"UNKNOWN_ORIGINAL_REQUEST"}');
              if (Buffer.byteLength(answer.body) > limits.maxWorkerResponseBytes) {
                settle(entry, 502, FAILURE.oversized);
                return send(response, 413, '{"error":"RESPONSE_TOO_LARGE"}');
              }
              settle(entry, answer.status, answer.body);
              return send(response, 200, '{}');
            });
        }
        finally { replyAdmissions--; }
      }
      // Reserve memory before reading a potentially slow request body.
      if (inFlight.size + admissions >= limits.maxInFlight || queue.length + admissions >= limits.maxQueued) {
        return send(response, 503, '{"error":"RELAY_OVERLOADED","outcome":"not-dispatched"}');
      }
      admissions++;
      try {
        return await readBounded(request, limits.maxRequestBytes,
          '{"error":"RELAY_REQUEST_TOO_LARGE","outcome":"not-dispatched"}',
          '{"error":"RELAY_OVERLOADED","outcome":"not-dispatched"}', (body, reserved) => {
            if (response.destroyed) return;
            if (inFlight.size >= limits.maxInFlight || queue.length >= limits.maxQueued) {
              return send(response, 503, '{"error":"RELAY_OVERLOADED","outcome":"not-dispatched"}');
            }
            const item = { id: randomUUID(), method: request.method, path: url.pathname + url.search,
              authorization: request.headers.authorization ?? '', body };
            const wireBytes = Buffer.byteLength(JSON.stringify(item));
            if (wireBytes + 2 > limits.maxPollResponseBytes) {
              return send(response, 413, '{"error":"RELAY_REQUEST_TOO_LARGE","outcome":"not-dispatched"}');
            }
            // Count escaped JSON bytes as well as all other active read reservations.
            if (bufferedBytes + readingBytes - reserved + wireBytes > limits.maxBufferedBytes) {
              return send(response, 503, '{"error":"RELAY_OVERLOADED","outcome":"not-dispatched"}');
            }
            const entry = { item, wireBytes, response, dispatched: false, timer: undefined,
              disconnected: () => forget(entry) };
            inFlight.set(item.id, entry);
            bufferedBytes += wireBytes;
            response.once('close', entry.disconnected);
            entry.timer = setTimeout(() => settle(entry, 504, FAILURE.timeout), limits.requestTimeoutMs);
            queue.push(entry);
            wakePoller();
          });
      }
      finally { admissions--; }
    } catch (error) {
      send(response, error.status ?? 500, error.responseBody ?? '{"error":"RELAY_ERROR"}');
    }
  });
  server.on('close', () => {
    for (const poller of pollers) poller.finish([]);
    for (const entry of inFlight.values()) settle(entry, 503, FAILURE.stopped);
  });
  return server;
}

/** Poll lanes move requests; maxConcurrentServes independently bounds controller work. */
export function startRelayAgent({ relayOrigin, secret, controllerOrigin, log = () => undefined,
  lanes = 4, limits: overrides } = {}) {
  if (!Number.isSafeInteger(lanes) || lanes < 1 || lanes > 32) throw new Error('Invalid relay lane count.');
  const limits = validateLimits(overrides);
  const abort = new AbortController();
  const pending = new Set();
  const waiters = new Set();
  let active = 0;
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const available = async () => {
    while (!abort.signal.aborted && active >= limits.maxConcurrentServes) {
      await new Promise((resolve) => {
        const done = () => { waiters.delete(done); resolve(); };
        waiters.add(done);
        if (abort.signal.aborted || active < limits.maxConcurrentServes) done();
      });
    }
    return Math.max(0, limits.maxConcurrentServes - active);
  };
  const acquire = async () => {
    while (!abort.signal.aborted) {
      if (active < limits.maxConcurrentServes) { active++; return true; }
      await available();
    }
    return false;
  };
  const call = async (url, requestOptions, maxBytes) => {
    const response = await fetch(url, { ...requestOptions,
      redirect: 'manual',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(130_000)]) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error('relay redirect refused'), { code: 'RELAY_REDIRECT' });
    }
    return { status: response.status, text: await readResponse(response, maxBytes) };
  };
  const serve = async (item) => {
    let answer;
    try {
      if (abort.signal.aborted) return;
      const result = await call(controllerOrigin + item.path, { method: item.method,
        headers: { Authorization: item.authorization, 'Content-Type': 'application/json' },
        ...(item.method === 'GET' || item.method === 'HEAD' ? {} : { body: item.body }) },
      limits.maxControllerResponseBytes);
      answer = { id: item.id, status: result.status, body: result.text };
    } catch (error) {
      if (abort.signal.aborted) return; // The original effect may still be running.
      answer = { id: item.id, status: 502,
        body: error.code === 'RESPONSE_TOO_LARGE' ? FAILURE.oversized
          : error.code === 'RELAY_REDIRECT' ? FAILURE.redirect : FAILURE.unreachable };
    }
    if (abort.signal.aborted) return;
    // One answer attempt only. Lost acknowledgement never reissues the controller call.
    await call(`${relayOrigin}/__relay/respond`, { method: 'POST', body: JSON.stringify(answer),
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } }, 1024)
      .then((result) => { if (result.status !== 200 && !abort.signal.aborted) log(`relay respond HTTP ${result.status}`); })
      .catch((error) => { if (!abort.signal.aborted) log(`relay respond failed: ${error.message}`); });
  };
  const lane = async () => {
    while (!abort.signal.aborted) {
      try {
        const capacity = await available();
        if (!capacity) break;
        const limit = Math.min(capacity, limits.maxPollBatch);
        const polled = await call(`${relayOrigin}/__relay/poll?limit=${limit}`, { method: 'POST',
          headers: { Authorization: `Bearer ${secret}` } }, limits.maxPollResponseBytes);
        if (polled.status !== 200) throw new Error(`poll HTTP ${polled.status}`);
        const items = JSON.parse(polled.text);
        if (!Array.isArray(items) || items.length > limit) throw new Error('invalid relay poll batch');
        for (const item of items) {
          if (!(await acquire())) break;
          const job = serve(item).finally(() => { active--; pending.delete(job); wake(); });
          pending.add(job);
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          log(`relay poll failed: ${error.message}`);
          await new Promise((resolve) => {
            const onAbort = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort); resolve(); };
            const timer = setTimeout(() => { abort.signal.removeEventListener('abort', onAbort); resolve(); }, 3000);
            abort.signal.addEventListener('abort', onAbort, { once: true });
            if (abort.signal.aborted) onAbort();
          });
        }
      }
    }
  };
  const jobs = Array.from({ length: lanes }, () => lane());
  return { stop: async () => {
    abort.abort();
    wake();
    await Promise.allSettled(jobs);
    await Promise.allSettled([...pending]);
  } };
}

if (process.argv[1]?.endsWith('relay.mjs')) {
  createRelay({ secret: SECRET }).listen(PORT, '::', () => console.log(`relay listening on ${PORT}`));
}
