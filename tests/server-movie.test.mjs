import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

test('movie HTTP ranges stream exact fixture bytes with bounded valid and invalid intervals', async t => {
  const uiDir = mkdtempSync(path.join(tmpdir(), 'seagulled-media-http-'));
  const bytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  writeFileSync(path.join(uiDir, 'fixture.webm'), bytes);
  const server = await createServer({ uiDir, runtime: { snapshot: () => ({ version: 1, goals: [] }), subscribe: () => () => {} } });
  t.after(async () => { await server.close(); rmSync(uiDir, { recursive: true, force: true }); });
  const full = await fetch(server.url + '/fixture.webm');
  assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-type'), 'video/webm'); assert.equal(full.headers.get('content-length'), '32');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  for (const [range, start, end] of [['bytes=3-7', 3, 7], ['bytes=8-', 8, 31], ['bytes=-4', 28, 31], ['bytes=-100', 0, 31], ['bytes=30-100', 30, 31]]) {
    const response = await fetch(server.url + '/fixture.webm', { headers: { Range: range } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/32`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  for (const range of ['bytes=32-', 'bytes=8-3', 'bytes=-0', 'bytes=-', 'bytes=1-3,5-7', 'bytes=9007199254740992-', 'items=1-2']) {
    const response = await fetch(server.url + '/fixture.webm', { headers: { Range: range } });
    assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */32');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  const foreign = await fetch(server.url + '/fixture.webm', { headers: { Origin: 'https://foreign.invalid', Range: 'bytes=0-1' } });
  assert.equal(foreign.status, 403);
});
