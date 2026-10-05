import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pcmWave } from './wav.mjs';

const aborted = () => Object.assign(new Error('Voice stopped.'), { name: 'AbortError' });
const unavailable = () => new Error('Local narration is unavailable.');

/** Convert local model audio to the same bounded PCM format as recognition. */
export function narrationWave(samples, sampleRate = 24000) {
  if (!(samples instanceof Float32Array) || sampleRate !== 24000 || !samples.length
    || samples.length > 60 * sampleRate || samples.some(value => !Number.isFinite(value))) throw unavailable();
  const count = Math.floor(samples.length * 16000 / sampleRate);
  if (!count) throw unavailable();
  const pcm = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index++) {
    const position = index * sampleRate / 16000;
    const left = Math.floor(position), fraction = position - left;
    const value = Math.max(-1, Math.min(1, samples[left] * (1 - fraction)
      + samples[Math.min(left + 1, samples.length - 1)] * fraction));
    pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), index * 2);
  }
  return pcmWave(pcm);
}

/** Preset male narration, with the installed system voice while weights warm. */
export function createNarration({ dataDir, systemSpeech, workerFactory = (url, options) => new Worker(url, options),
  startupTimeoutMs = 180000, requestTimeoutMs = 60000 } = {}) {
  let worker, status = 'idle', startupTimer, pending, fallback, closed = false;
  const retire = async error => {
    const old = worker; worker = undefined; clearTimeout(startupTimer);
    pending?.reject(error ?? aborted()); pending = undefined;
    if (status !== 'unavailable') status = 'idle';
    await old?.terminate();
  };
  const prepare = () => {
    if (closed || worker || status === 'unavailable') return;
    status = 'preparing';
    try { worker = workerFactory(new URL('./narrator.mjs', import.meta.url),
      { workerData: { cacheDir: path.join(dataDir, 'voice', 'models') } }); }
    catch { status = 'unavailable'; return; }
    const current = worker;
    const fail = () => {
      if (worker !== current) return;
      status = 'unavailable'; void retire(unavailable());
    };
    startupTimer = setTimeout(fail, startupTimeoutMs);
    current.on('error', fail);
    current.on('exit', () => { if (worker === current) fail(); });
    current.on('message', message => {
      if (worker !== current || closed) return;
      if (message.type === 'ready') { clearTimeout(startupTimer); status = 'ready'; }
      else if (message.type === 'unavailable') fail();
      else if (pending && message.id === pending.id) {
        const job = pending; pending = undefined;
        if (message.error) job.reject(unavailable());
        else { try { job.resolve(narrationWave(message.samples, message.sampleRate)); } catch (error) { job.reject(error); } }
      }
    });
  };
  const speech = async (payload, { signal, timeoutMs } = {}) => {
    if (closed || signal?.aborted) throw aborted();
    if (payload.action === 'capabilities') {
      prepare();
      fallback ??= Promise.resolve().then(() => systemSpeech?.({ action: 'capabilities' }, { timeoutMs: 5000 }))
        .then(value => value?.available === true).catch(() => false);
      const system = await fallback;
      if (closed) throw aborted();
      return { available: status === 'ready' || system,
        narration: status === 'ready' ? 'kokoro' : system ? 'system' : 'unavailable',
        narrationStatus: status, voiceName: status === 'ready' ? 'Michael (preset)' : 'Installed system voice' };
    }
    if (payload.action !== 'speak' || typeof payload.text !== 'string' || !payload.text.trim()
      || payload.text.length > 1200) throw unavailable();
    prepare();
    if (status !== 'ready') {
      if (!systemSpeech) throw unavailable();
      return systemSpeech(payload, { signal, timeoutMs });
    }
    if (pending) throw new Error('Finish the current narration first.');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const stop = () => { void retire(aborted()); };
      const timer = setTimeout(() => { void retire(new Error('Local narration timed out.')); }, timeoutMs ?? requestTimeoutMs);
      const finish = handler => value => { clearTimeout(timer); signal?.removeEventListener('abort', stop); handler(value); };
      pending = { id, resolve: finish(resolve), reject: finish(reject) };
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) { stop(); return; }
      try { worker.postMessage({ id, text: payload.text.trim() }); }
      catch { void retire(unavailable()); }
    });
  };
  speech.stop = async () => { if (pending || status === 'preparing') await retire(aborted()); };
  speech.close = async () => { closed = true; await retire(aborted()); };
  return speech;
}
