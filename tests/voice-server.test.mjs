import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { pcmWave, decodeRecording } from '../src/voice/wav.mjs';

test('voice HTTP routes require session auth, permit bounded WAV payloads, and preserve smaller ordinary mutation limits', async t => {
  let calls = 0;
  const runtime = { snapshot: () => ({}), subscribe: () => () => {},
    voiceCapabilities: async () => ({ speak: true, transcribe: true, ready: true }),
    transcribeAudio: async input => { calls++; decodeRecording(input); return { text: 'Fixture transcript.' }; },
    speak: async () => pcmWave(Buffer.alloc(16)), stopSpeaking: async () => ({ stopped: true }),
    authState: async () => ({ fly: { connected: false }, modal: { connected: false } }),
    authConnect: async ({ id }) => ({ id, connected: true }), authCancel: async () => ({ cancelled: true }), chat: async () => ({}) };
  const server = await createServer({ runtime }); t.after(() => server.close());
  const headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const wave = pcmWave(Buffer.alloc(320000));
  const unauthorized = await fetch(`${server.url}/api/voice/transcribe`, { method: 'POST', body: JSON.stringify(wave) });
  assert.equal(unauthorized.status, 401); assert.equal(calls, 0);
  const recognized = await fetch(`${server.url}/api/voice/transcribe`, { method: 'POST', headers, body: JSON.stringify(wave) });
  assert.equal(recognized.status, 200); assert.deepEqual(await recognized.json(), { text: 'Fixture transcript.' });
  assert.equal(calls, 1);
  const largeChat = await fetch(`${server.url}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(100001) }) });
  assert.equal(largeChat.status, 400);
  for (const route of ['voice/speak', 'voice/stop', 'auth/connect', 'auth/cancel']) {
    const result = await fetch(`${server.url}/api/${route}`, { method: 'POST', headers, body: JSON.stringify({ text: 'Hello.', id: 'fly' }) });
    assert.equal(result.status, 200);
  }
  const page = await fetch(server.url); assert.match(page.headers.get('content-security-policy'), /media-src 'self' blob:/);
});
