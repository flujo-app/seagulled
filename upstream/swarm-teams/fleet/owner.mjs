// Take the registry's writer lease before reading or changing its recovery state.
// A crash leaves the lease intact. An operator must prove the old controller is gone
// before removing that exact lease; PID absence alone never replays accepted work.
import { mkdirSync, openSync, writeSync, readFileSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function claimController(registryPath) {
  const leasePath = `${registryPath}.controller.lock`;
  mkdirSync(dirname(leasePath), { recursive: true });
  let descriptor;
  try { descriptor = openSync(leasePath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('A controller lease already exists. Preserve it; verify the old process and reconcile before starting another writer.');
    throw error;
  }
  const receipt = JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID(), startedAt: new Date().toISOString() });
  try { writeSync(descriptor, receipt); }
  catch (error) { closeSync(descriptor); throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(descriptor);
    // Never remove a lease another actor replaced.
    if (readFileSync(leasePath, 'utf8') !== receipt) throw new Error('Controller lease identity changed; preserving it.');
    unlinkSync(leasePath);
  };
}
