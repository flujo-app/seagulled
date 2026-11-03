import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createControllerNativeSourceAdmission } from './native-source-admission.mjs';
import { createNativeSourceMutationFence } from './native-source-mutation-fence.mjs';
import { createNativeWorkerToolBroker, NATIVE_WORKER_SERVER } from './native-worker-tools.mjs';

const denied = () => Object.assign(new Error('Native Source admission transport refused.'), { code: 'NATIVE_SOURCE_TRANSPORT' });
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

/** Private loopback transport for Source to reread the actual Parent Controller.
 * Only the owned Source receives this fresh transport credential. It is not an
 * account credential, Worker credential, HTTP inference route or fleet gate.
 * Mutation RPCs require the owning runtime's durable uncertainty handler and
 * hold its commit fence throughout Source's callback. Tool/inference routes
 * and fleet qualification must still be composed separately. */
export async function createNativeSourceAdmissionTransport(options) {
  if (options.workerTools !== undefined && typeof options.workerTools !== 'boolean') throw denied();
  const admission = createControllerNativeSourceAdmission(options);
  const toolBroker = options.workerTools === true ? createNativeWorkerToolBroker({ controller: options.controller,
    admission, scope: options.scope }) : undefined;
  const mutationFence = typeof options.scope.retainUncertainty === 'function'
    ? createNativeSourceMutationFence({ admission,
      retainUncertainty: (context, evidence) => { stopWaits(); return options.scope.retainUncertainty(context, evidence); },
      ...(options.mutationTimeoutMs === undefined ? {} : { timeoutMs: options.mutationTimeoutMs }) }) : undefined;
  const token = randomBytes(32).toString('base64url');
  const credential = Buffer.from(`Bearer ${token}`);
  const contexts = new Map();
  const waits = new Set();
  let closed = false;
  let closing;
  const stopWaits = () => { for (const wake of [...waits]) wake(); };
  options.scope.signal.addEventListener('abort', stopWaits);
  const server = createServer(async (request, response) => {
    const reply = (status, value) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    try {
      const supplied = request.headers.authorization;
      const bytes = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
      if (closed || bytes.length !== credential.length || !timingSafeEqual(bytes, credential)) return reply(401, { error: 'UNAUTHORIZED' });
      const toolRequest = toolBroker && request.url === '/native-source/tools/mcp';
      if (request.headers.origin !== undefined) return reply(403, { error: 'REFUSED' });
      // A stateless Streamable HTTP server must decline its optional GET SSE
      // channel with 405. A 404 makes the MCP client abandon this connection.
      if (toolRequest && request.method === 'GET') {
        response.setHeader('Allow', 'POST');
        return reply(405, { error: 'METHOD_NOT_ALLOWED' });
      }
      if (request.method !== 'POST' || request.url !== '/native-source/admission' && !toolRequest) return reply(404, { error: 'NOT_FOUND' });
      const chunks = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 16 * 1024) return reply(413, { error: 'TOO_LARGE' });
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (toolRequest) {
        toolBroker.assertAvailable(); mutationFence?.assertAvailable();
        if (!body || body.jsonrpc !== '2.0' || Object.keys(body).some(key => !['jsonrpc','id','method','params'].includes(key))) throw denied();
        if (body.method === 'notifications/initialized' && body.id === undefined) return reply(202);
        if (!['string','number'].includes(typeof body.id) || String(body.id).length > 80) throw denied();
        let result;
        if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: NATIVE_WORKER_SERVER, version: '1.0.0' } };
        else if (body.method === 'ping') result = {};
        else if (body.method === 'tools/list') result = { tools: toolBroker.tools };
        else if (body.method === 'tools/call') {
          const params = body.params;
          if (!exact(params, ['name','arguments','_meta']) || !params._meta || Object.keys(params._meta).some(key => !['seagulledNative','progressToken'].includes(key))
            || !exact(params._meta.seagulledNative, ['ticket'])) throw denied();
          const ticket = params._meta.seagulledNative.ticket;
          const lost = () => { if (!response.writableEnded) void toolBroker.cancel(ticket); };
          response.once('close', lost);
          try {
            const completed = await toolBroker.call(ticket, params.name, params.arguments);
            result = { ...completed.data, _meta: { seagulledNative: completed.receipt } };
          } finally { response.removeListener('close', lost); }
        } else throw denied();
        return reply(200, { jsonrpc: '2.0', id: body.id, result });
      }
      if (!exact(body, ['operation', 'args'])) throw denied();
      const args = body.args;
      if (body.operation !== 'finish-mutation') { mutationFence?.assertAvailable(); toolBroker?.assertAvailable(); }
      let result;
      if (body.operation === 'admit') {
        if (!exact(args, ['workerAuthorization', 'claim']) || typeof args.workerAuthorization !== 'string'
          || args.workerAuthorization.length > 4096) throw denied();
        const context = await admission.admitWorker({ headers: { authorization: args.workerAuthorization } }, args.claim);
        const contextId = randomUUID(); contexts.set(contextId, context);
        result = { contextId };
      } else {
        if (!uuid(args?.contextId) || !contexts.has(args.contextId)) throw denied();
        const context = contexts.get(args.contextId);
        switch (body.operation) {
          case 'issue-tool':
            if (!toolBroker || !exact(args, ['contextId', 'name', 'arguments'])) throw denied();
            result = await toolBroker.issue(context, args.name, args.arguments); break;
          case 'plan':
            if (!exact(args, ['contextId'])) throw denied();
            result = await admission.readPlan(context); break;
          case 'children':
            if (!exact(args, ['contextId'])) throw denied();
            result = await admission.readChildren(context); break;
          case 'begin-mutation':
            if (!mutationFence || !exact(args, ['contextId'])) throw denied();
            result = { ticket: await mutationFence.begin(context) }; break;
          case 'finish-mutation':
            if (!mutationFence || !exact(args, ['contextId', 'ticket', 'outcome']) || !uuid(args.ticket)) throw denied();
            await mutationFence.finish(context, args.ticket, args.outcome); result = { completed: true }; break;
          case 'bind':
            if (!exact(args, ['contextId', 'conversationId', 'runId'])) throw denied();
            await admission.bindRun(context, args.conversationId, args.runId); result = { bound: true }; break;
          case 'assert':
            if (!exact(args, ['contextId', 'expected']) || !args.expected || typeof args.expected !== 'object'
              || Array.isArray(args.expected) || Object.keys(args.expected).some(key => !['conversationId', 'runId', 'graphHash'].includes(key))) throw denied();
            await admission.assertRun(context, args.expected); result = { current: true }; break;
          case 'root':
            if (!exact(args, ['contextId', 'expected'])) throw denied();
            result = await admission.readRoot(context, args.expected); break;
          case 'watch': {
            if (!exact(args, ['contextId'])) throw denied();
            await admission.assertRun(context);
            // One listener on the owning signal serves all Worker waiters.
            // Each read still revalidates target, plan, actual run and owner.
            await new Promise(resolve => {
              let timer;
              const wake = () => { clearTimeout(timer); waits.delete(wake); response.removeListener('close', wake); resolve(); };
              waits.add(wake); response.once('close', wake); timer = setTimeout(wake, 8_000);
              if (closed || options.scope.signal.aborted || response.destroyed) wake();
            });
            await admission.assertRun(context); result = { current: true }; break;
          }
          default: throw denied();
        }
      }
      if (closed) throw denied();
      if (body.operation !== 'finish-mutation') mutationFence?.assertAvailable();
      reply(200, result);
    } catch { reply(403, { error: 'REFUSED' }); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5_000;
  // Undici subtracts its keep-alive safety threshold from this advertised
  // lifetime. One second made every successful RPC close its socket, rapidly
  // exhausting Windows ephemeral ports during repeated admission checks.
  server.keepAliveTimeout = 5_000; server.maxConnections = 128;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) { options.scope.signal.removeEventListener('abort', stopWaits); admission.close(); throw error; }
  const url = `http://127.0.0.1:${server.address().port}/native-source/admission`;
  return Object.freeze({ url, token,
    async close() {
      if (!closing) closing = (async () => {
        closed = true;
        let uncertainty;
        try { await toolBroker?.close(); } catch (error) { uncertainty = error; }
        try { await mutationFence?.close(); } catch (error) { uncertainty = error; }
        admission.close(); contexts.clear(); credential.fill(0);
        options.scope.signal.removeEventListener('abort', stopWaits); stopWaits();
        const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections(); await stopped;
        if (uncertainty) throw uncertainty;
      })();
      return closing;
    },
  });
}

export { createNativeSourceAdmissionClient } from './native-source-client.mjs';
