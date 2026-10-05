import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createNarration, narrationWave } from '../src/voice/narration.mjs';
import { decodeRecording, pcmWave } from '../src/voice/wav.mjs';

function fixture(t, { fallback = true } = {}) {
  const workers = []; const fallbackAudio = pcmWave(Buffer.alloc(3200)); let systemCalls = 0;
  const speech = createNarration({ dataDir: 'fixture-private-data', systemSpeech: async payload => {
    if (payload.action === 'capabilities') return { available: fallback };
    systemCalls++; return fallbackAudio;
  }, workerFactory: () => {
    const worker = new EventEmitter(); worker.messages = []; worker.terminated = false;
    worker.postMessage = value => worker.messages.push(value);
    worker.terminate = async () => { worker.terminated = true; worker.emit('exit', 1); };
    workers.push(worker); return worker;
  }});
  t.after(() => speech.close());
  return { speech, workers, fallbackAudio, systemCalls: () => systemCalls };
}

test('model narration resamples mono audio, saturates PCM, and rejects malformed or overlong output', () => {
  const input = Float32Array.from([2, 0, -2, 0, 0.5, 1]);
  const output = decodeRecording(narrationWave(input)).samples;
  assert.equal(output.length, 4);
  assert.deepEqual([...output], [32767 / 32768, -1, 0, 24575 / 32768]);
  for (const value of [new Float32Array(), Float32Array.from([NaN]), Float32Array.from([Infinity]),
    new Float32Array(24000 * 60 + 1), [1, 2]]) assert.throws(() => narrationWave(value));
  assert.throws(() => narrationWave(input, 48000));
});

test('startup uses installed narration and readiness switches to local preset without claiming a cloned voice', async t => {
  const { speech, workers, fallbackAudio, systemCalls } = fixture(t);
  assert.deepEqual(await speech({ action: 'capabilities' }), { available: true, narration: 'system',
    narrationStatus: 'preparing', voiceName: 'Installed system voice' });
  assert.deepEqual(await speech({ action: 'speak', text: 'First sentence.' }), fallbackAudio);
  workers[0].emit('message', { type: 'ready' });
  assert.equal((await speech({ action: 'capabilities' })).voiceName, 'Michael (preset)');
  const request = speech({ action: 'speak', text: 'Second sentence.' });
  const { id } = workers[0].messages[0];
  workers[0].emit('message', { id, samples: Float32Array.from([0, 0.25, -0.25]), sampleRate: 24000 });
  assert.equal(decodeRecording(await request).samples.length, 2);
  assert.equal(systemCalls(), 1);
});

test('cancellation terminates inference, fences a stale answer, and permits a fresh worker', async t => {
  const { speech, workers } = fixture(t);
  await speech({ action: 'capabilities' }); workers[0].emit('message', { type: 'ready' });
  const controller = new AbortController();
  const request = speech({ action: 'speak', text: 'Cancel me.' }, { signal: controller.signal });
  const rejection = assert.rejects(request, { name: 'AbortError' });
  const id = workers[0].messages[0].id;
  controller.abort(); await rejection;
  assert.equal(workers[0].terminated, true);
  workers[0].emit('message', { id, samples: new Float32Array(10), sampleRate: 24000 });
  await speech({ action: 'capabilities' }); assert.equal(workers.length, 2);
});

test('unavailable model uses honest fallback and closing terminates startup with no late readiness', async t => {
  const { speech, workers } = fixture(t, { fallback: false });
  await speech({ action: 'capabilities' }); workers[0].emit('message', { type: 'unavailable' });
  assert.equal((await speech({ action: 'capabilities' })).narration, 'unavailable');
  assert.equal(workers.length, 1);
  await speech.close(); workers[0].emit('message', { type: 'ready' });
  await assert.rejects(speech({ action: 'capabilities' }), { name: 'AbortError' });
});
