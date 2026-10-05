import http from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const uiRoot = fileURLToPath(new URL('../ui/', import.meta.url));
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 100000) throw new Error('That message is too large.'); chunks.push(chunk); }
  return length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
export async function createServer({ runtime, port = 0 } = {}) {
  if (!runtime) throw new Error('A runtime is required.');
  const token = randomBytes(32).toString('base64url');
  const streams = new Set();
  let origin;
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== origin?.replace('http://', '')) return send(403, { error: 'Unexpected host.' });
      if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Unexpected origin.' });
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if (!same(req.headers.authorization?.replace(/^Bearer /, ''), token)) return send(401, { error: 'Open your Seagulled session to continue.' });
        if (url.pathname === '/api/events' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify({ type: 'state', state: runtime.snapshot() })}\n\n`); streams.add(res);
          req.on('close', () => streams.delete(res)); return;
        }
        if (url.pathname === '/api/state' && req.method === 'GET') return send(200, runtime.snapshot());
        const artifactMatch = /^\/api\/goals\/([^/]+)\/artifacts\/([^/]+)\/(\d+)$/.exec(url.pathname);
        if (artifactMatch && req.method === 'GET') return send(200, runtime.readArtifact(decodeURIComponent(artifactMatch[1]), decodeURIComponent(artifactMatch[2]), Number(artifactMatch[3])));
        const input = ['POST', 'PATCH'].includes(req.method) ? await body(req) : {};
        if (url.pathname === '/api/chat' && req.method === 'POST') return send(202, await runtime.chat(input.text, input));
        if (url.pathname === '/api/providers/discover' && req.method === 'POST') return send(200, await runtime.discover());
        if (url.pathname === '/api/providers/connect' && req.method === 'POST') return send(200, await runtime.connect(input));
        let match = /^\/api\/providers\/([^/]+)$/.exec(url.pathname);
        if (match && req.method === 'DELETE') return send(200, await runtime.disconnect(decodeURIComponent(match[1])));
        match = /^\/api\/goals\/([^/]+)(?:\/(pause|resume|stop))?$/.exec(url.pathname);
        if (match && req.method === 'PATCH' && !match[2]) return send(200, await runtime.updateGoal(decodeURIComponent(match[1]), input));
        if (match && req.method === 'POST' && match[2]) return send(200, await runtime.controlGoal(decodeURIComponent(match[1]), match[2]));
        match = /^\/api\/swarm\/(pause|resume|stop)$/.exec(url.pathname);
        if (match && req.method === 'POST') return send(200, await runtime.controlSwarm(match[1]));
        return send(404, { error: 'That action is unavailable.' });
      }
      if (req.method !== 'GET') return send(405, { error: 'Method unavailable.' });
      const route = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const target = path.resolve(uiRoot, route);
      if (!target.startsWith(uiRoot) || route.includes('..')) return send(403, { error: 'Unavailable file.' });
      const data = await readFile(target);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(target)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" }); res.end(data);
    } catch (e) { if (!res.headersSent) send(e.code === 'ENOENT' ? 404 : 400, { error: e.message }); else res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const selectedPort = server.address().port;
  origin = `http://127.0.0.1:${selectedPort}`;
  const sessionPath = runtime.dataDir ? path.join(runtime.dataDir, 'session.json') : null;
  if (sessionPath) await writeFile(sessionPath, JSON.stringify({ pid: process.pid, url: origin, token }), { mode: 0o600 });
  const unsubscribe = runtime.subscribe(event => { for (const res of streams) res.write(`data: ${JSON.stringify(event)}\n\n`); });
  return { server, url: origin, port: selectedPort, token, async close() { unsubscribe(); for (const res of streams) res.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (sessionPath) await unlink(sessionPath).catch(() => {}); } };
}
