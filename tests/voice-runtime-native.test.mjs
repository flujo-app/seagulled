import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

function infer(backendPath) {
  const modelPath = fileURLToPath(new URL('./fixtures/voice/identity.onnx', import.meta.url));
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const ort = require(workerData.backendPath);
      (async () => {
        const session = await ort.InferenceSession.create(workerData.modelPath, {
          executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
        });
        try {
          const result = await session.run({ X: new ort.Tensor('float32', new Float32Array([3.25, -7]), [2]) });
          parentPort.postMessage(Array.from(result.Y.data));
        } finally { await session.release(); parentPort.close(); }
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { backendPath, modelPath } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Native voice runtime fixture timed out.')); }, 15000);
    let output;
    worker.once('message', value => { output = value; });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); code === 0 && output ? resolve(output) : reject(new Error(`Native voice runtime exited ${code}.`)); });
  });
}

test('recognition and narration share one native runtime and execute concurrent CPU sessions', async () => {
  const recognition = createRequire(import.meta.resolve('@huggingface/transformers'));
  const kokoro = createRequire(import.meta.resolve('kokoro-js'));
  const narration = createRequire(kokoro.resolve('@huggingface/transformers'));
  const recognitionBackend = recognition.resolve('onnxruntime-node');
  const narrationBackend = narration.resolve('onnxruntime-node');
  assert.equal(recognitionBackend, narrationBackend, 'Different native ONNX DLL versions cannot coexist safely in Windows voice workers.');
  const outputs = await Promise.all([infer(recognitionBackend), infer(narrationBackend)]);
  for (const output of outputs) assert.deepEqual(output, [3.25, -7]);
});
