import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderManager } from '../src/providers/index.mjs';
import { createRuntime } from '../src/runtime.mjs';

test('real runtime, provider and coordinator contracts settle fixture GPU requests and retire their owned attempt', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-gpu-contract-'));
  const providerDir = path.join(dataDir, 'providers'), helperRoot = path.join(dataDir, 'helpers');
  for (const name of ['fly/flyctl', 'python/python', 'python/Lib/site-packages/modal/__main__.py']) {
    const target = path.join(helperRoot, name + (process.platform === 'win32' && !name.endsWith('.py') ? '.exe' : ''));
    mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, 'fixture helper; never executed');
  }
  const secrets = new Map(); let appName, token, requests = 0, startupChecks = 0;
  const responses = [JSON.stringify({ done: false, tasks: [{ task: 'Prepare a fixture plan.' }] }),
    'Fixture plan prepared.', 'Fixture review checked the plan.', JSON.stringify({ done: true, response: 'Fixture plan reviewed.' })];
  const providers = new ProviderManager({ dataDir: providerDir, helperRoot,
    credentialStore: { set: async (id, value) => secrets.set(id, value), get: async id => secrets.get(id), delete: async id => secrets.delete(id) },
    commandRunner: async (command, args, options) => {
      if (!command.startsWith(helperRoot)) return { code: 1, stdout: '' };
      if (args.some(arg => arg.endsWith('provision.py'))) {
        appName = options.env.SEAGULLED_PRIVATE_APP_NAME; token = JSON.parse(options.input).token;
        const saved = JSON.parse(readFileSync(path.join(dataDir, 'state.json')));
        assert.equal(saved.goals[0].pendingUsd, 6);
        assert.match(appName, /^seagulled-qwen-[a-f0-9]{12}$/);
        return { code: 0, stdout: JSON.stringify({ endpoint: `https://fixture--${appName}-inference.modal.run` }) };
      }
      if (args.includes('--version')) return { code: 0, stdout: 'fixture version' };
      if (args.includes('token') && args.includes('info')) return { code: 0, stdout: 'User: fixture-personal-identity' };
      if (args.includes('profile')) return { code: 0, stdout: JSON.stringify([{ name: 'fixture', workspace: 'fixture-workspace', active: true }]) };
      if (args.includes('app') && args.includes('list')) return { code: 0, stdout: JSON.stringify([{ description: appName, state: 'stopped' }]) };
      if (args.includes('list')) return { code: 0, stdout: '[]' };
      if (args.includes('stop') || args.includes('delete')) return { code: 0, stdout: '' };
      return { code: 1, stdout: '' };
    },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
      assert.equal(url, `https://fixture--${appName}-inference.modal.run/v1/chat/completions`);
      const savedBytes = readFileSync(path.join(dataDir, 'state.json'), 'utf8');
      assert.equal(savedBytes.includes(token), false);
      const saved = JSON.parse(savedBytes), attempt = JSON.parse(readFileSync(path.join(providerDir, 'private-h100/attempt.json')));
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'qwen3.8-27b');
      if (payload.max_tokens === 48) {
        assert.equal(payload.chat_template_kwargs.enable_thinking, false);
        assert.equal(saved.goals[0].privateCompute.admissionId, attempt.reservation.id);
        assert.equal(saved.goals[0].pendingUsd, 6);
        assert.equal(attempt.phase, 'unverified');
        assert.equal(attempt.pendingRunId, undefined);
        assert.equal(attempt.leaseGoalId, undefined);
        assert.equal(typeof attempt.catalogVerifiedAt, 'string');
        const challenge = `SEAGULLED-${attempt.attemptId.slice(0, 8).toUpperCase()}`;
        assert.equal(payload.messages[0].content, `Reply with exactly this text and nothing else: ${challenge}`);
        startupChecks++;
        return new Response(JSON.stringify({ model: 'qwen3.8-27b', choices: [{
          message: { role: 'assistant', content: challenge }, finish_reason: 'stop',
        }] }));
      }
      assert.equal(attempt.leaseGoalId, saved.goals[0].id);
      assert.equal(saved.goals[0].reservations[attempt.pendingRunId].amountUsd, 2.5);
      assert.equal(saved.goals[0].pendingUsd, 2.5);
      requests++;
      return new Response(JSON.stringify({ model: 'qwen3.8-27b', choices: [{ message: {
        role: 'assistant', content: responses.shift(),
      } }], usage: { prompt_tokens: 8, completion_tokens: 4 } }));
    },
  });
  const previous = process.env.SEAGULLED_DISABLE_FLEET; process.env.SEAGULLED_DISABLE_FLEET = '1';
  const runtime = createRuntime({ executionMode: 'local', dataDir, providers });
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.SEAGULLED_DISABLE_FLEET; else process.env.SEAGULLED_DISABLE_FLEET = previous;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const goal = await runtime.chat('Prepare a clearly labelled fixture plan.', { privateH100: true });
  const result = await runtime.wait(goal.id);
  assert.equal(result.status, 'completed', result.error); assert.equal(requests, 4);
  assert.equal(startupChecks, 1);
  const attempt = JSON.parse(readFileSync(path.join(providerDir, 'private-h100/attempt.json')));
  assert.equal(attempt.verificationVersion, 2);
  assert.equal(attempt.verifiedModel, 'qwen3.8-27b');
  assert.equal(typeof attempt.completionVerifiedAt, 'string');
  assert.equal(result.pendingUsd, 0); assert.equal(result.privateCompute.cleanupStatus, 'verified');
  assert.equal(Object.values(result.reservations).filter(entry => entry.status === 'settled').length, 4);
  assert.equal(runtime.snapshot().spend.reportedUsd, 0); assert.equal(secrets.size, 0);
});
