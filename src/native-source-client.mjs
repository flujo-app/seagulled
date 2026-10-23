import { createHash } from 'node:crypto';

const denied = () => Object.assign(new Error('Native Source admission transport refused.'), { code: 'NATIVE_SOURCE_TRANSPORT' });
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const NATIVE_WORKER_SERVER = 'seagulled-worker';
/** Source-side private client. Endpoint comes from the owned launcher, never
 * from a Flow, HTTP request, model argument or discovery redirect. */
export function createNativeSourceAdmissionClient({ url, token, signal, fetchImpl = fetch } = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.pathname !== '/native-source/admission' || endpoint.search || endpoint.hash
    || !endpoint.port || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535
    || endpoint.username || endpoint.password || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw denied();
  const contexts = new WeakMap();
  const call = async (operation, args, localSignal) => {
    signal?.throwIfAborted();
    const response = await fetchImpl(endpoint.href, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation, args }),
      signal: AbortSignal.any([signal, localSignal, AbortSignal.timeout(10_000)].filter(Boolean)) });
    if (!response.ok) throw denied();
    const reader = response.body?.getReader();
    if (!reader) throw denied();
    const chunks = []; let length = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.byteLength;
        if (length > 16 * 1024) throw denied();
        chunks.push(Buffer.from(next.value));
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    signal?.throwIfAborted(); return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const contextId = context => contexts.get(context) ?? (() => { throw denied(); })();
  return Object.freeze({
    bindingId: createHash('sha256').update(endpoint.href).update('\0').update(token).digest('hex'),
    toolConfig: Object.freeze({ name: NATIVE_WORKER_SERVER, transport: 'streamable',
      serverUrl: new URL('/native-source/tools/mcp', endpoint).href, headers: Object.freeze({ Authorization: `Bearer ${token}` }) }),
    async issueTool(context, name, args) {
      const result = await call('issue-tool', { contextId: contextId(context), name, arguments: args });
      if (!exact(result, ['ticket']) || typeof result.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.ticket)) throw denied();
      return result;
    },
    async admit(workerAuthorization, claim) {
      const result = await call('admit', { workerAuthorization, claim });
      if (!exact(result, ['contextId']) || !uuid(result.contextId)) throw denied();
      const context = Object.freeze({}); contexts.set(context, result.contextId); return context;
    },
    async bindRun(context, conversationId, runId) {
      const result = await call('bind', { contextId: contextId(context), conversationId, runId });
      if (!exact(result, ['bound']) || result.bound !== true) throw denied();
    },
    async assertRun(context, expected = {}) {
      const result = await call('assert', { contextId: contextId(context), expected });
      if (!exact(result, ['current']) || result.current !== true) throw denied();
    },
    async readRoot(context, expected) { return call('root', { contextId: contextId(context), expected }); },
    async readPlan(context) { return call('plan', { contextId: contextId(context) }); },
    async readChildren(context) { return call('children', { contextId: contextId(context) }); },
    async commit(context, task) {
      if (typeof task !== 'function') throw denied();
      const id = contextId(context);
      const grant = await call('begin-mutation', { contextId: id });
      if (!exact(grant, ['ticket']) || !uuid(grant.ticket)) throw denied();
      let result;
      try { result = await task(); }
      catch (error) {
        // Cleanup uses the transport's process signal, not the already-revoked
        // per-run observed signal. Failure never asserts that effects rolled back.
        try { await call('finish-mutation', { contextId: id, ticket: grant.ticket, outcome: 'failed' }); } catch {}
        throw error;
      }
      const terminal = await call('finish-mutation', { contextId: id, ticket: grant.ticket, outcome: 'completed' });
      if (!exact(terminal, ['completed']) || terminal.completed !== true) throw denied();
      return result;
    },
    async observe(context) {
      const id = contextId(context);
      await this.assertRun(context);
      const stop = new AbortController();
      const watcher = new AbortController();
      const done = (async () => {
        try {
          while (!watcher.signal.aborted) {
            const result = await call('watch', { contextId: id }, watcher.signal);
            if (!exact(result, ['current']) || result.current !== true) throw denied();
          }
        } catch (error) { if (!stop.signal.aborted) stop.abort(error); }
      })();
      return Object.freeze({ signal: stop.signal, done,
        async close() { if (!stop.signal.aborted) stop.abort(denied()); watcher.abort(); await done; },
      });
    },
  });
}
