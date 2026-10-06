import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeRecording, pcmWave } from './wav.mjs';
import { createNarration } from './narration.mjs';

const aborted = () => Object.assign(new Error('Voice stopped.'), { name: 'AbortError' });
const unavailable = () => new Error('Voice recognition is unavailable; open advanced controls to enter your goal.');
const speechScript = readFileSync(new URL('./windows-speech.ps1', import.meta.url), 'utf8');

export function windowsSpeech(payload, { signal, timeoutMs = 60000 } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Local narration is unavailable on this platform.'));
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(speechScript, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', failure, settled = false;
    const stop = error => { failure ||= error; child.kill(); };
    const abort = () => stop(aborted());
    const timer = setTimeout(() => stop(new Error('Local narration timed out.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure || error) reject(failure || error);
      else { try {
        const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
        resolve(payload.action === 'speak' && typeof result.pcmBase64 === 'string' ? pcmWave(Buffer.from(result.pcmBase64, 'base64')) : result);
      } catch { reject(new Error('Local narration returned an invalid response.')); } }
    };
    child.on('error', () => finish(new Error('Local narration is unavailable.')));
    child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (Buffer.byteLength(output) > 4 * 1024 * 1024) stop(new Error('Local narration exceeded its audio limit.')); });
    child.on('close', code => finish(code === 0 ? undefined : new Error('Local narration did not finish.')));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    if (signal?.aborted) abort();
  });
}

export function createVoice({ dataDir, workerFactory = (url, options) => new Worker(url, options), speech } = {}) {
  speech ??= createNarration({ dataDir, systemSpeech: windowsSpeech });
  const cacheDir = path.join(dataDir, 'voice', 'models');
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  let worker, ready, cancelStartup, generation = 0, status = 'idle', closed = false, pending, narration;
  const reset = async () => {
    generation++;
    const old = worker; cancelStartup?.(); cancelStartup = undefined; worker = undefined; ready = undefined; status = 'idle';
    pending?.reject(aborted()); pending = undefined;
    await old?.terminate();
  };
  const prepare = () => {
    if (closed) return Promise.reject(aborted());
    if (status === 'unavailable') return Promise.reject(unavailable());
    if (ready) return ready;
    status = 'preparing';
    ready = new Promise((resolve, reject) => {
      let initialized = false;
      try { worker = workerFactory(new URL('./recognizer.mjs', import.meta.url), { workerData: { cacheDir } }); }
      catch { status = 'unavailable'; reject(unavailable()); return; }
      const currentWorker = worker;
      const startupTimer = setTimeout(() => { fail(); void currentWorker.terminate(); }, 180000);
      cancelStartup = () => { clearTimeout(startupTimer); if (!initialized) reject(aborted()); };
      const fail = () => {
        clearTimeout(startupTimer); status = 'unavailable';
        if (!initialized) reject(unavailable());
        pending?.reject(unavailable()); pending = undefined;
      };
      worker.on('error', () => { if (worker === currentWorker) fail(); });
      worker.on('exit', () => { if (worker === currentWorker) fail(); });
      worker.on('message', message => {
        if (worker !== currentWorker) return;
        if (message.type === 'ready') { clearTimeout(startupTimer); initialized = true; status = 'ready'; resolve(); }
        else if (message.type === 'unavailable') fail();
        else if (pending && message.id === pending.id) {
          const current = pending; pending = undefined;
          if (message.error || typeof message.text !== 'string' || message.text.length > 8000) current.reject(unavailable());
          else current.resolve({ text: message.text });
        }
      });
    });
    return ready;
  };
  return {
    async capabilities() {
      if (closed) throw aborted();
      // Prepare in the background at first start; downloads require no paid key.
      prepare().catch(() => {});
      let voiceState;
      try { voiceState = await speech({ action: 'capabilities' }, { timeoutMs: 5000 }); }
      catch { voiceState = { available: false }; }
      const speakAvailable = voiceState?.available === true;
      return { transcribe: status !== 'unavailable', speak: speakAvailable, ready: status === 'ready', status,
        ...(voiceState?.narration ? { narration: voiceState.narration, narrationStatus: voiceState.narrationStatus, voiceName: voiceState.voiceName } : {}),
        ...(status === 'unavailable' ? { reason: 'Local speech recognition could not load.' } : !speakAvailable ? { reason: 'Local narration is unavailable.' } : {}) };
    },
    async transcribe(payload) {
      const { samples, language } = decodeRecording(payload);
      if (pending) throw new Error('Finish the current recording first.');
      const currentGeneration = generation;
      await prepare();
      if (closed || currentGeneration !== generation) throw aborted();
      if (pending) throw new Error('Finish the current recording first.');
      return new Promise((resolve, reject) => {
        const id = randomUUID(), timer = setTimeout(() => { void reset(); }, 60000);
        pending = { id, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        worker.postMessage({ id, samples, language }, [samples.buffer]);
      });
    },
    async speak(text) {
      if (closed) throw aborted();
      if (typeof text !== 'string' || !text.trim() || text.length > 1200) throw new Error('Narration must contain 1–1,200 characters.');
      if (narration) throw new Error('Finish the current narration first.');
      const controller = new AbortController(), job = { controller }; narration = job;
      try {
        job.promise = speech({ action: 'speak', text: text.trim() }, { signal: controller.signal });
        const result = await job.promise;
        if (controller.signal.aborted) throw aborted();
        if (result.mimeType !== 'audio/wav' || typeof result.dataBase64 !== 'string') throw new Error('Local narration returned invalid audio.');
        decodeRecording(result, { maxSeconds: 60 });
        return result;
      } finally { if (narration === job) narration = undefined; }
    },
    async stop() {
      // Fence even a request suspended on an already-resolved preparation promise.
      generation++;
      const job = narration; job?.controller.abort();
      if (pending || status === 'preparing') await reset();
      await job?.promise?.catch(() => {});
      await speech.stop?.();
      return { stopped: true };
    },
    async close() { closed = true; await this.stop(); await reset(); await speech.close?.(); },
  };
}
