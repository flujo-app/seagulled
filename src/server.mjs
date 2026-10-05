import http from 'node:http';
import { readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const uiRoot = fileURLToPath(new URL('../ui/', import.meta.url));
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(request, maximum = 100000) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > maximum) throw new Error('That message is too large.'); chunks.push(chunk); }
  return length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function byteRange(raw, length) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || (!match[1] && !match[2]) || length === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start: Math.max(0, length - suffix), end: length - 1 } : null;
  }
  const start = Number(match[1]), requestedEnd = match[2] ? Number(match[2]) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= length || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, length - 1) };
}
export async function createServer({ runtime, port = 0, uiDir = uiRoot } = {}) {
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
        if (url.pathname === '/api/budget/default' && req.method === 'GET') return send(200, await runtime.defaultBudget(url.searchParams.get('currency') || 'USD'));
        if (url.pathname === '/api/auth/state' && req.method === 'GET') return send(200, await runtime.authState());
        if (url.pathname === '/api/voice/capabilities' && req.method === 'GET') return send(200, await runtime.voiceCapabilities());
        const artifactMatch = /^\/api\/goals\/([^/]+)\/artifacts\/([^/]+)\/(\d+)$/.exec(url.pathname);
        if (artifactMatch && req.method === 'GET') return send(200, runtime.readArtifact(decodeURIComponent(artifactMatch[1]), decodeURIComponent(artifactMatch[2]), Number(artifactMatch[3])));
        const input = ['POST', 'PATCH'].includes(req.method) ? await body(req, url.pathname === '/api/voice/transcribe' ? 2_900_000 : 100000) : {};
        if (url.pathname === '/api/auth/connect' && req.method === 'POST') return send(200, await runtime.authConnect(input));
        if (url.pathname === '/api/auth/cancel' && req.method === 'POST') return send(200, await runtime.authCancel());
        if (url.pathname === '/api/voice/transcribe' && req.method === 'POST') return send(200, await runtime.transcribeAudio(input));
        if (url.pathname === '/api/voice/speak' && req.method === 'POST') return send(200, await runtime.speak(input.text));
        if (url.pathname === '/api/voice/stop' && req.method === 'POST') return send(200, await runtime.stopSpeaking());
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
      const root = path.resolve(uiDir), target = path.resolve(root, route);
      if (!target.startsWith(root + path.sep) || route.includes('..')) return send(403, { error: 'Unavailable file.' });
      const extension = path.extname(target);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm' }[extension] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
      if (['.mp4', '.webm'].includes(extension)) {
        const file = await stat(target);
        if (!file.isFile()) return send(404, { error: 'Unavailable movie.' });
        headers['Accept-Ranges'] = 'bytes';
        const range = req.headers.range === undefined ? undefined : byteRange(req.headers.range, file.size);
        if (range === null) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.size}`, 'Content-Length': 0 }); res.end(); return; }
        headers['Content-Length'] = range ? range.end - range.start + 1 : file.size;
        if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
        res.writeHead(range ? 206 : 200, headers);
        const stream = createReadStream(target, range ? { start: range.start, end: range.end } : {});
        stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
      }
      const data = await readFile(target);
      res.writeHead(200, headers); res.end(data);
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
