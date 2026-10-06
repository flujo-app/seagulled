import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const LIMIT = 256_000;
const cancelled = (outcome) => Object.assign(new Error('Cancelled'), { name: 'AbortError', outcome, ...(outcome === 'unknown' ? { code: 'UNKNOWN', unknown: true } : {}) });
const terminationUnknown = () => Object.assign(new Error('Provider process tree termination could not be confirmed.'),
  { code: 'UNKNOWN', outcome: 'unknown', unknown: true });

function terminateTree(child) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return Promise.resolve(false);
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return Promise.resolve(true); }
    catch { return Promise.resolve(false); }
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const taskkill = typeof systemRoot === 'string' && isAbsolute(systemRoot)
    ? join(systemRoot, 'System32', 'taskkill.exe') : null;
  if (!taskkill || !existsSync(taskkill)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let killer;
    try { killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, shell: false, stdio: 'ignore' }); }
    catch { resolve(false); return; }
    killer.once('error', () => resolve(false));
    killer.once('close', (code) => resolve(code === 0));
  });
}

export function runProcess(command, args, { cwd, input, signal, timeoutMs = 120_000, maxBytes = LIMIT,
  env = process.env, onStdout, killTree = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled('not_applied'));
    let child;
    try { child = spawn(command, args, { cwd, env, windowsHide: true, shell: false,
      detached: killTree && process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let stdout = '', stderr = '', bytes = 0, done = false, pendingError, terminationWatchdog;
    let childClosed = false, closeCode, treeSettled = true, treeConfirmed = false;
    const cleanup = () => { clearTimeout(timeout); clearTimeout(terminationWatchdog); signal?.removeEventListener('abort', abort); };
    const fail = (error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const settle = () => {
      if (done || !childClosed || !treeSettled) return;
      if (pendingError) fail(killTree && !treeConfirmed ? terminationUnknown() : pendingError);
      else { done = true; cleanup(); resolve({ code: closeCode, stdout, stderr }); }
    };
    const terminate = (error) => {
      if (done || pendingError) return;
      pendingError = error;
      if (killTree) {
        treeSettled = false;
        terminateTree(child).then((confirmed) => {
          treeConfirmed = confirmed;
          treeSettled = true;
          if (!confirmed) child.kill();
          settle();
        });
      } else child.kill();
      terminationWatchdog = setTimeout(() => {
        child.kill();
        fail(terminationUnknown());
      }, 5_000);
    };
    const timeout = setTimeout(() => terminate(Object.assign(new Error('Provider timed out.'), { outcome: 'unknown' })), timeoutMs);
    const abort = () => terminate(cancelled('unknown'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', (error) => fail(Object.assign(error, { outcome: 'unknown' })));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return terminate(Object.assign(new Error('Provider output exceeded the safety limit.'), { outcome: 'unknown' }));
      const part = chunk.toString('utf8');
      stdout += part;
      onStdout?.(part);
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return terminate(Object.assign(new Error('Provider output exceeded the safety limit.'), { outcome: 'unknown' }));
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => { childClosed = true; closeCode = code; settle(); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
