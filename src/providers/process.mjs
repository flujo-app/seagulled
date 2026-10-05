import { spawn } from 'node:child_process';

const LIMIT = 256_000;
const cancelled = (outcome) => Object.assign(new Error('Cancelled'), { name: 'AbortError', outcome, ...(outcome === 'unknown' ? { code: 'UNKNOWN', unknown: true } : {}) });

export function runProcess(command, args, { cwd, input, signal, timeoutMs = 120_000, maxBytes = LIMIT, env = process.env, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled('not_applied'));
    let child;
    try { child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let stdout = '', stderr = '', bytes = 0, done = false, pendingError, terminationWatchdog;
    const cleanup = () => { clearTimeout(timeout); clearTimeout(terminationWatchdog); signal?.removeEventListener('abort', abort); };
    const fail = (error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const terminate = (error) => {
      if (done || pendingError) return;
      pendingError = error;
      child.kill();
      terminationWatchdog = setTimeout(() => fail(Object.assign(new Error('Provider process termination could not be confirmed.'), { outcome: 'unknown' })), 5_000);
    };
    const timeout = setTimeout(() => terminate(Object.assign(new Error('Provider timed out.'), { outcome: 'unknown' })), timeoutMs);
    const abort = () => terminate(cancelled('unknown'));
    signal?.addEventListener('abort', abort, { once: true });
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
    child.on('close', (code) => {
      cleanup();
      if (done) return;
      done = true;
      if (pendingError) reject(pendingError);
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
