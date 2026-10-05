import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

// Resolve the model classes used by Kokoro itself; recognition uses its own version.
const requireKokoro = createRequire(import.meta.resolve('kokoro-js'));
const { KokoroTTS } = requireKokoro('kokoro-js');
const { env, StyleTextToSpeech2Model, AutoTokenizer } = requireKokoro('@huggingface/transformers');
const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const revision = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
env.cacheDir = workerData.cacheDir;
env.allowLocalModels = false;
env.backends.onnx.logLevel = 'error';
let narrator;
try {
  const [model, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(modelId, { revision, dtype: 'q8', device: 'cpu',
      session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 } }),
    AutoTokenizer.from_pretrained(modelId, { revision }),
  ]);
  narrator = new KokoroTTS(model, tokenizer);
  parentPort.postMessage({ type: 'ready' });
} catch { parentPort.postMessage({ type: 'unavailable' }); }

parentPort.on('message', async ({ id, text }) => {
  try {
    if (!narrator || typeof text !== 'string' || !text.trim() || text.length > 1200) throw new Error('Invalid narration.');
    // Short word-boundary pieces avoid Kokoro's silent 510-token truncation.
    const parts = text.match(/.{1,240}(?:\s|$)|\S{1,240}/gs);
    const audio = []; let length = 0;
    for (const part of parts) {
      const result = await narrator.generate(part.trim(), { voice: 'am_michael', speed: 1 });
      if (result.sampling_rate !== 24000 || !(result.audio instanceof Float32Array)
        || !result.audio.length || (length += result.audio.length) > 60 * 24000) throw new Error('Invalid narration.');
      audio.push(result.audio);
    }
    const samples = new Float32Array(length); let offset = 0;
    for (const part of audio) { samples.set(part, offset); offset += part.length; }
    parentPort.postMessage({ id, samples, sampleRate: 24000 }, [samples.buffer]);
  } catch { parentPort.postMessage({ id, error: true }); }
});
