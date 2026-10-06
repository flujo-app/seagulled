import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.mjs';

const cli = fileURLToPath(new URL('../bin/seagulled.mjs', import.meta.url));
const run = args => new Promise(resolve => execFile(process.execPath, [cli, ...args],
  { windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));

// An authenticated loopback fixture exercises the actual CLI client, not a
// provider, owned FLUJO launcher, account, or cloud company.
async function session(t, readiness) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-cli-company-'));
  let goal, reads = 0, submitted;
  const runtime = {
    dataDir,
    subscribe: () => () => {},
    snapshot() {
      if (goal && ++reads === 3 && readiness === 'checking') goal = { ...goal, status: 'completed', result: 'Offline CLI receipt', execution: { requested: 'company', readiness: 'blocked' } };
      return { version: 1, conversation: [], goals: goal ? [goal] : [], providers: [], spend: { usd: 0 } };
    },
    async chat(text, options) {
      submitted = { text, ...options };
      goal = { id: 'fixture-company', text, status: 'queued', executionMode: options.executionMode || 'company',
        execution: { requested: 'company', readiness }, ...(readiness === 'blocked' ? { error: 'The crew is not ready yet.' } : {}) };
      return goal;
    },
  };
  const server = await createServer({ runtime });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, server, reads: () => reads, submitted: () => submitted };
}

test('CLI attached to desktop waits through queued company preflight and receives the original result', async t => {
  const fixture = await session(t, 'checking');
  const result = await run(['goal', 'Wait for the company', '--home', fixture.dataDir, '--execution-mode', 'company', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fixture.reads(), 3);
  assert.equal(fixture.submitted().executionMode, 'company');
  assert.match(result.stdout, /Offline CLI receipt/);
  assert.doesNotMatch(result.stdout, /company has started|putting the team|"status": "queued"/i);
  assert.ok(!result.stdout.includes(fixture.server.token));
  assert.ok(!result.stdout.includes(fixture.server.url));
});

test('CLI returns a waiting exit code for a blocked company without claiming execution', async t => {
  const fixture = await session(t, 'blocked');
  const result = await run(['goal', 'Save a waiting goal', '--home', fixture.dataDir, '--json']);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(fixture.reads(), 1);
  assert.match(result.stdout, /The crew is not ready yet/);
  assert.match(result.stdout, /"status": "queued"/);
  assert.doesNotMatch(result.stdout, /team has started|company has started/i);
});
