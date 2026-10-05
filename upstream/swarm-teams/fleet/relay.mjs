// Relay: lets machines on Fly's private network call a fleet controller that runs
// somewhere they cannot reach. It runs on a small Fly Machine (Node built-ins only).
// Workers send normal fleet requests here; the controller's side polls for them over an
// outbound connection and posts the answers back. The relay holds no tokens and no state
// beyond requests in flight; Worker bearers pass through untouched.
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.RELAY_SECRET ?? '';
const PORT = Number(process.env.RELAY_PORT ?? 4300);
const REQUEST_TIMEOUT_MS = 120_000;
const POLL_MS = 25_000;
const MAX_BODY = 2 * 1024 * 1024;

export function createRelay({ secret }) {
  if (secret.length < 32) throw new Error('RELAY_SECRET must be at least 32 characters.');
  const queue = [];           // requests no agent has taken yet
  const inFlight = new Map(); // id -> { resolve }
  const pollers = [];         // waiting agent polls
  const agent = (request) => {
    const given = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    return given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  };
  const read = async (request) => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  const send = (response, status, text, type = 'application/json') => {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(text);
  };

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://relay');
      if (url.pathname === '/health') return send(response, 200, JSON.stringify({ ok: true, waiting: queue.length, agents: pollers.length }));
      if (url.pathname === '/__relay/poll') {
        if (!agent(request)) return send(response, 401, '{"error":"UNAUTHORIZED"}');
        if (queue.length) return send(response, 200, JSON.stringify(queue.splice(0, 32)));
        const poller = { done: false };
        poller.finish = (items) => { if (!poller.done) { poller.done = true; send(response, 200, JSON.stringify(items)); } };
        pollers.push(poller);
        setTimeout(() => { const index = pollers.indexOf(poller); if (index >= 0) pollers.splice(index, 1); poller.finish([]); }, POLL_MS);
        return undefined;
      }
      if (url.pathname === '/__relay/respond') {
        if (!agent(request)) return send(response, 401, '{"error":"UNAUTHORIZED"}');
        const answer = JSON.parse(await read(request));
        inFlight.get(answer.id)?.resolve(answer);
        return send(response, 200, '{}');
      }
      // Everything else is a Worker's request for the controller.
      const item = { id: randomUUID(), method: request.method, path: url.pathname + url.search,
        authorization: request.headers.authorization ?? '', body: await read(request) };
      const answered = new Promise((resolve) => inFlight.set(item.id, { resolve }));
      const poller = pollers.shift();
      if (poller) poller.finish([item]); else queue.push(item);
      const timer = setTimeout(() => inFlight.get(item.id)?.resolve({ status: 504, body: '{"error":"RELAY_TIMEOUT"}' }), REQUEST_TIMEOUT_MS);
      const answer = await answered;
      clearTimeout(timer);
      inFlight.delete(item.id);
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
      return send(response, answer.status, answer.body ?? '');
    } catch (error) {
      return send(response, error.status ?? 500, JSON.stringify({ error: 'RELAY_ERROR' }));
    }
  });
}

/** Controller side: pull Worker requests from the relay and answer them from the local controller. */
export function startRelayAgent({ relayOrigin, secret, controllerOrigin, log = () => undefined, lanes = 4 }) {
  let stopped = false;
  const call = async (url, options) => {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(130_000) });
    return { status: response.status, text: await response.text() };
  };
  const serve = async (item) => {
    let answer;
    try {
      const result = await call(controllerOrigin + item.path, { method: item.method,
        headers: { Authorization: item.authorization, 'Content-Type': 'application/json' },
        ...(item.method === 'GET' || item.method === 'HEAD' ? {} : { body: item.body }) });
      answer = { id: item.id, status: result.status, body: result.text };
    } catch (error) {
      answer = { id: item.id, status: 502, body: JSON.stringify({ error: 'CONTROLLER_UNREACHABLE' }) };
    }
    await call(`${relayOrigin}/__relay/respond`, { method: 'POST', body: JSON.stringify(answer),
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } }).catch((error) => log(`relay respond failed: ${error.message}`));
  };
  const lane = async () => {
    while (!stopped) {
      try {
        const polled = await call(`${relayOrigin}/__relay/poll`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } });
        if (polled.status !== 200) throw new Error(`poll HTTP ${polled.status}`);
        for (const item of JSON.parse(polled.text)) serve(item);
      } catch (error) {
        if (!stopped) { log(`relay poll failed: ${error.message}`); await new Promise((resolve) => setTimeout(resolve, 3000)); }
      }
    }
  };
  for (let index = 0; index < lanes; index++) lane();
  return { stop: () => { stopped = true; } };
}

if (process.argv[1]?.endsWith('relay.mjs')) {
  createRelay({ secret: SECRET }).listen(PORT, '::', () => console.log(`relay listening on ${PORT}`));
}
