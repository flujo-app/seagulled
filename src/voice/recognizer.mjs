import { parentPort, workerData } from 'node:worker_threads';
import { env, pipeline } from '@huggingface/transformers';

// Model weights are public artifacts; microphone samples never leave this process.
env.cacheDir = workerData.cacheDir;
env.allowLocalModels = false;
env.backends.onnx.logLevel = 'error';
let recognizer;
try {
  recognizer = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base', {
    revision: '64da57285918e20ea79ea5c88eed7197933abaa8', dtype: 'q8', device: 'cpu',
    session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
  });
  parentPort.postMessage({ type: 'ready' });
} catch { parentPort.postMessage({ type: 'unavailable' }); }
parentPort.on('message', async ({ id, samples, language }) => {
  try {
    if (!recognizer) throw new Error('Not ready.');
    const result = await recognizer(samples, { task: 'transcribe', ...(language ? { language } : {}), return_timestamps: false });
    if (typeof result.text !== 'string' || result.text.length > 8000) throw new Error('Invalid result.');
    parentPort.postMessage({ id, text: result.text.trim() });
  } catch { parentPort.postMessage({ id, error: true }); }
});
