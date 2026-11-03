import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Controller } from '../upstream/swarm-teams/fleet/controller.mjs';
import { FlujoClient } from '../upstream/swarm-teams/lib/flujo-client.mjs';
import { assertNativeSourceAdmissionController } from './native-source-admission.mjs';
import { createNativeSourceMutationFence } from './native-source-mutation-fence.mjs';

const refused = () => Object.assign(new Error('Native Worker tool admission refused.'), { code: 'NATIVE_WORKER_TOOL' });
const unknown = () => Object.assign(new Error('Native Worker tool outcome is unconfirmed.'), { code: 'UNKNOWN', unknown: true });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const definitions = [
  { name: 'worker_read_file', description: 'Read a file in this Worker output workspace.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'worker_write_file', description: 'Write a UTF-8 file in this Worker output workspace.', inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false } },
  { name: 'worker_list_dir', description: 'List a directory in this Worker output workspace.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'worker_command', description: 'Run a command in this isolated Worker, with a ninety-second limit. cwd is relative to its output workspace.', inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, cwd: { type: 'string' } }, additionalProperties: false } },
];
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export const NATIVE_WORKER_TOOLS = freeze(definitions);
export const NATIVE_WORKER_SERVER = 'seagulled-worker';
const names = new Set(definitions.map(tool => tool.name));

function checkedArgs(name, args) {
  if (!names.has(name) || !args || typeof args !== 'object' || Array.isArray(args)
    || Buffer.byteLength(JSON.stringify(args)) > 16 * 1024) throw refused();
  const allowed = name === 'worker_command' ? ['command', 'cwd'] : name === 'worker_write_file' ? ['path', 'content'] : ['path'];
  if (Object.keys(args).some(key => !allowed.includes(key)) || Object.values(args).some(value => typeof value !== 'string' || value.includes('\0'))) throw refused();
  if (name === 'worker_command' ? !args.command?.trim() : typeof args.path !== 'string') throw refused();
  if (name === 'worker_write_file' && typeof args.content !== 'string') throw refused();
  const relative = name === 'worker_command' ? args.cwd ?? '.' : args.path;
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.includes(':')
    || relative.split('/').some(segment => segment === '..' || !segment)) throw refused();
  return Object.freeze(structuredClone(args));
}

/** Parent-only broker. A Flow supplies neither a target nor a credential.
 * Current Controller admission selects the actual Worker; its existing owned
 * connection supplies the private bearer. All calls hold the runtime fence,
 * including proxy setup and cleanup. This does not qualify a fleet/provider. */
export function createNativeWorkerToolBroker({ controller, admission, scope, timeoutMs = 120_000 } = {}) {
  if (!(controller instanceof Controller) || typeof admission?.withWorker !== 'function'
    || typeof scope?.retainUncertainty !== 'function') throw refused();
  assertNativeSourceAdmissionController(admission, controller);
  const fence = createNativeSourceMutationFence({ admission, timeoutMs,
    retainUncertainty: (context, evidence) => scope.retainUncertainty(context, evidence) });
  const tickets = new Map(), running = new Map();
  let closed = false;
  function available() { if (closed) throw refused(); fence.assertAvailable(); }
  return Object.freeze({
    tools: NATIVE_WORKER_TOOLS,
    assertAvailable: available,
    async issue(context, name, args) {
      available(); const captured = checkedArgs(name, args);
      await admission.withWorker(context, async () => {}); available();
      for (const [ticket, item] of tickets) if (item.expiresAt <= Date.now()) tickets.delete(ticket);
      if (tickets.size >= 100) throw refused();
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, { context, name, args: captured, argsDigest: digest(captured), expiresAt: Date.now() + 10_000 });
      return Object.freeze({ ticket });
    },
    async call(ticket, name, args) {
      available(); const item = tickets.get(ticket); tickets.delete(ticket);
      if (!item || item.expiresAt <= Date.now() || item.name !== name || digest(checkedArgs(name, args)) !== item.argsDigest) throw refused();
      const execution = { item, grant: undefined, started: false, cancelled: false };
      running.set(ticket, execution);
      try {
        const grant = await fence.begin(item.context); execution.grant = grant;
        if (execution.cancelled) { await fence.finish(item.context, grant, 'completed'); throw refused(); }
        execution.started = true;
        const result = await admission.withWorker(item.context, async ({ worker, actor }) => {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(actor.workspace)) throw refused();
          const root = `/data/flujo/workspaces/${actor.workspace}/seagulled-output`;
          const selected = item.args;
          const command = name === 'worker_command';
          const server = command ? 'bash' : 'filesystem';
          const tool = command ? 'run' : name.slice('worker_'.length);
          const normalized = command ? { command: selected.command, cwd: path.posix.join(root, selected.cwd ?? '.'), timeout: 90, maxOutputChars: 32000 }
            : { ...selected, path: path.posix.join(root, selected.path) };
          let connection;
          try {
            connection = await controller.connect(worker.target, { operation: 'dispatch', signal: scope.signal });
            await admission.assertRun(item.context);
            const client = connection.client;
            if (!(client instanceof FlujoClient)) throw refused();
            const endpoint = new URL(client.origin);
            if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.pathname !== '/' || endpoint.search
              || endpoint.hash || endpoint.username || endpoint.password || client.workspace !== actor.workspace) throw refused();
            endpoint.pathname = `/api/mcp/servers/${server}/tools/${tool}`; endpoint.searchParams.set('workspace', actor.workspace);
            const received = await fetch(endpoint, { method: 'POST', redirect: 'error',
              headers: { ...client.headers(actor.workspace), 'content-type': 'application/json' },
              body: JSON.stringify({ args: normalized, timeout: 100_000 }),
              signal: AbortSignal.any([scope.signal, client.signal, AbortSignal.timeout(110_000)].filter(Boolean)) });
            const reader = received.body?.getReader(); if (!reader) throw unknown();
            const chunks = []; let bytes = 0, response;
            try {
              while (true) { const next = await reader.read(); if (next.done) break;
                bytes += next.value.byteLength; if (bytes > 64 * 1024) throw unknown(); chunks.push(Buffer.from(next.value)); }
              if (!received.ok) throw unknown(); response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } finally { await reader.cancel(); reader.releaseLock(); }
            if (!response || response.success !== true || !response.data || Buffer.byteLength(JSON.stringify(response.data)) > 64 * 1024) throw unknown();
            return response.data;
          } finally { await connection?.close(); }
        });
        if (execution.cancelled) throw unknown();
        await fence.finish(item.context, grant, 'completed'); available();
        return Object.freeze({ data: result, receipt: Object.freeze({ ticket, name, argsDigest: item.argsDigest }) });
      } catch {
        if (execution.grant) try { await fence.finish(item.context, execution.grant, 'failed'); } catch {}
        throw unknown();
      } finally { running.delete(ticket); }
    },
    async cancel(ticket) {
      const execution = running.get(ticket); if (!execution) return;
      execution.cancelled = true;
      if (execution.started && execution.grant) {
        try { await fence.finish(execution.item.context, execution.grant, 'failed'); } catch {}
      }
    },
    async close() { closed = true; tickets.clear(); await fence.close(); },
  });
}
