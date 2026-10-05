import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVoice } from '../src/voice/index.mjs';
import { decodeRecording, pcmWave } from '../src/voice/wav.mjs';

const recording = () => pcmWave(Buffer.from([0, 0, 0xff, 0x7f, 0, 0x80]));
function fixture(t, { startup = true, answer = true } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-voice-'));
  const worker = new EventEmitter(); let terminated = false;
  worker.terminate = async () => { terminated = true; worker.emit('exit', 1); };
  worker.postMessage = message => { if (answer) queueMicrotask(() => worker.emit('message', { id: message.id, text: 'A deterministic test transcript.' })); };
  const voice = createVoice({ dataDir, workerFactory: () => { if (startup) queueMicrotask(() => worker.emit('message', { type: 'ready' })); return worker; },
    speech: async input => input.action === 'capabilities' ? { available: true } : recording() });
  t.after(async () => { await voice.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { voice, worker, terminated: () => terminated };
}
test('WAV parser checks canonical PCM, duration, format, and optional language without decoding arbitrary codecs', () => {
  assert.deepEqual([...decodeRecording(recording()).samples], [0, 32767 / 32768, -1]);
  const bytes = Buffer.from(recording().dataBase64, 'base64'); bytes.writeUInt32LE(48000, 24);
  for (const bad of [{ ...recording(), dataBase64: recording().dataBase64 + '=' }, { ...recording(), mimeType: 'audio/webm' },
    { ...recording(), language: '../../config' }, { ...recording(), path: 'private-file' },
    { mimeType: 'audio/wav', dataBase64: bytes.toString('base64') }, pcmWave(Buffer.alloc(960002))]) {
    assert.throws(() => decodeRecording(bad));
  }
});
test('voice capability and narration are separate from recognition output and never a provider execution', async t => {
  const { voice } = fixture(t);
  assert.equal((await voice.capabilities()).speak, true);
  assert.deepEqual(await voice.transcribe(recording()), { text: 'A deterministic test transcript.' });
  assert.equal((await voice.capabilities()).ready, true);
  assert.deepEqual(await voice.speak('A short actual response.'), recording());
});
test('stop cancels pending recognition and suppresses stale worker replies', async t => {
  const { voice, worker, terminated } = fixture(t, { answer: false });
  const active = voice.transcribe(recording());
  const rejection = assert.rejects(active, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  await voice.stop(); await rejection;
  worker.emit('message', { id: 'old', text: 'Do not submit stale input.' });
  assert.equal(terminated(), true);
});
test('closing during first model preparation settles the pending recording', async t => {
  const { voice } = fixture(t, { startup: false });
  const recordingPromise = voice.transcribe(recording());
  const rejection = assert.rejects(recordingPromise, { name: 'AbortError' });
  await voice.close(); await rejection;
  await assert.rejects(voice.capabilities(), { name: 'AbortError' });
});
test('stop fences a recording waiting on an already-ready recognizer promise before dispatch', async t => {
  const { voice, worker } = fixture(t);
  await voice.capabilities();
  await new Promise(resolve => setImmediate(resolve));
  let dispatches = 0; worker.postMessage = () => { dispatches++; };
  const pending = voice.transcribe(recording());
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await voice.stop(); await rejected;
  assert.equal(dispatches, 0);
});
