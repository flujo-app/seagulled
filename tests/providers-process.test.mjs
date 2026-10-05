import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runProcess } from '../src/providers/process.mjs';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await delay(20);
  }
  throw new Error('Fixture subprocess did not become ready.');
}

async function exerciseTree(mode) {
  const root = mkdtempSync(join(tmpdir(), 'seagulled-process-test-'));
  const worker = join(root, 'worker.mjs');
  const wrapper = join(root, 'wrapper.mjs');
  const ownedMarker = join(root, 'owned.txt');
  const unrelatedMarker = join(root, 'unrelated.txt');
  const pidFile = join(root, 'owned-pid.txt');
  writeFileSync(worker, `import { appendFileSync } from 'node:fs';
const marker = process.argv[2];
setInterval(() => appendFileSync(marker, 'x'), 20);
`);
  writeFileSync(wrapper, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, [process.argv[2], process.argv[3]],
  { stdio: 'ignore', windowsHide: true });
writeFileSync(process.argv[4], String(child.pid));
setInterval(() => {}, 1000);
`);
  const unrelated = spawn(process.execPath, [worker, unrelatedMarker],
    { stdio: 'ignore', windowsHide: true });
  const controller = new AbortController();
  const running = runProcess(process.execPath, [wrapper, worker, ownedMarker, pidFile],
    { signal: controller.signal, timeoutMs: mode === 'timeout' ? 8000 : 15_000,
      killTree: true, maxBytes: 1000 });
  running.catch(() => {}); // Readiness failure still has an owned cleanup path in finally.
  try {
    await until(() => existsSync(ownedMarker) && readFileSync(ownedMarker).length >= 3
      && existsSync(unrelatedMarker) && readFileSync(unrelatedMarker).length >= 3, 4000);
    if (mode === 'abort') controller.abort();
    await assert.rejects(running, error => error.outcome === 'unknown'
      && (mode === 'abort' ? error.name === 'AbortError' : /timed out/i.test(error.message)));
    await delay(100);
    const ownedBefore = readFileSync(ownedMarker).length;
    const unrelatedBefore = readFileSync(unrelatedMarker).length;
    await delay(180);
    assert.equal(readFileSync(ownedMarker).length, ownedBefore,
      'the owned descendant must stop after the wrapper is terminated');
    assert.ok(readFileSync(unrelatedMarker).length > unrelatedBefore,
      'an unrelated process must keep running');
  } finally {
    controller.abort();
    unrelated.kill();
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* Already terminated. */ }
      }
    }
    await delay(50);
    rmSync(root, { recursive: true, force: true });
  }
}

test('aborting a provider wrapper terminates its owned child tree only', async () => {
  await exerciseTree('abort');
});

test('provider timeout terminates the owned child tree only', async () => {
  await exerciseTree('timeout');
});

test('a normally completed owned process returns its terminal receipt', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('READY')"],
    { killTree: true, timeoutMs: 3000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'READY');
});
