import { join } from 'node:path';

const unavailable = () => Object.assign(new Error('The private browser sign-in helper is unavailable.'), { code: 'AUTH_HELPER_UNAVAILABLE' });
const cancelled = (outcome) => Object.assign(new Error('Sign-in cancelled.'), { name: 'AbortError', outcome });

async function ptyModule() {
  try {
    const module = await import('node-pty');
    const spawn = module.spawn ?? module.default?.spawn;
    return typeof spawn === 'function' ? spawn : null;
  } catch { return null; }
}

let availability;
export async function ptyAvailable() {
  availability ??= (async () => {
    try {
      const windows = process.platform === 'win32';
      const command = windows ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh';
      const args = windows ? ['/d', '/c', 'exit', '0'] : ['-c', 'exit 0'];
      return (await runPty(command, args, { timeoutMs: 8_000, maxBytes: 1_000 })).code === 0;
    } catch { return false; }
  })();
  return availability;
}

/** A private PTY is required by Fly's browser login; output is never forwarded. */
export async function runPty(command, args, { signal, timeoutMs = 300_000, env = process.env, maxBytes = 64_000 } = {}) {
  if (signal?.aborted) throw cancelled('not_applied');
  const spawn = await ptyModule();
  if (!spawn) throw unavailable();
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { name: 'xterm-256color', cols: 80, rows: 24, env,
      ...(process.platform === 'win32' ? { useConptyDll: true } : {}) }); }
    catch { reject(unavailable()); return; }
    let done = false;
    let bytes = 0;
    let pendingError;
    let terminationWatchdog;
    let data;
    let exited;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(terminationWatchdog);
      signal?.removeEventListener('abort', abort);
      data?.dispose();
      exited?.dispose();
    };
    const finish = (result, error) => {
      if (done) return;
      done = true;
      cleanup();
      // node-pty 1.1.0 leaves its Windows conout worker referenced after a natural exit.
      // Its output is intentionally discarded, so the worker can be drained now.
      try { child._agent?._conoutSocketWorker?.dispose?.(); } catch { /* The PTY has already exited. */ }
      if (error) reject(error);
      else resolve(result);
    };
    const stop = (error) => {
      if (done || pendingError) return;
      pendingError = error;
      try { child.kill(); } catch { finish(undefined, error); return; }
      terminationWatchdog = setTimeout(() => finish(undefined,
        Object.assign(new Error('Browser sign-in termination could not be confirmed.'), { outcome: 'unknown' })), 5_000);
    };
    const timer = setTimeout(() => stop(Object.assign(new Error('Browser sign-in timed out.'), { outcome: 'unknown' })), timeoutMs);
    const abort = () => stop(cancelled('unknown'));
    data = child.onData((part) => {
      bytes += Buffer.byteLength(part);
      if (bytes > maxBytes) stop(Object.assign(new Error('Browser sign-in output exceeded the safety limit.'), { outcome: 'unknown' }));
    });
    exited = child.onExit(({ exitCode }) => finish({ code: exitCode }, pendingError));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
