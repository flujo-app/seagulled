import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderManager } from '../src/providers/index.mjs';
import { runProcess } from '../src/providers/process.mjs';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockCommands = async (_command, args) => {
  if (args.join(' ') === 'auth status') return { code: 0, stdout: JSON.stringify({ loggedIn: true, email: 'private@example.com' }), stderr: '' };
  if (args.join(' ') === 'login status') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
  if (args.includes('--version')) return { code: 0, stdout: 'version', stderr: '' };
  if (args[0] === 'exec') return { code: 0, stdout: [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex answer' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } }),
  ].join('\n'), stderr: '' };
  if (args[0] === '-p') return { code: 0, stdout: JSON.stringify({ result: 'Claude answer', usage: { input_tokens: 14, output_tokens: 4 } }), stderr: '' };
  throw new Error('Unexpected command');
};

test('discovery and public state omit native account details and keys', async () => {
  const manager = new ProviderManager({ commandRunner: mockCommands, env: { OPENAI_API_KEY: 'secret-value' } });
  const discovered = await manager.discover();
  assert.equal(discovered.find((item) => item.id === 'codex').available, true);
  assert.equal(discovered.find((item) => item.id === 'claude').available, true);
  assert.equal(discovered.find((item) => item.id === 'antigravity').available, false);
  assert.equal(discovered.find((item) => item.id === 'openai').available, true);
  assert.doesNotMatch(JSON.stringify(discovered), /secret-value|private@example.com/);
});

test('subscription CLI returns token usage with non-billed subscription kind', async () => {
  const calls = [];
  const manager = new ProviderManager({ commandRunner: async (...args) => { calls.push(args); return mockCommands(...args); }, env: {} });
  await manager.connect({ id: 'codex', method: 'subscription' });
  await manager.connect({ id: 'claude', method: 'subscription' });
  const codex = await manager.run({ providerId: 'codex', prompt: 'Hi', maxUsd: 1 });
  const claude = await manager.run({ providerId: 'claude', prompt: 'Hi', maxUsd: 1 });
  assert.equal(codex.text, 'Codex answer');
  assert.deepEqual(codex.usage, { inputTokens: 12, outputTokens: 3, costUsd: 0, costKind: 'subscription' });
  assert.equal(claude.text, 'Claude answer');
  assert.ok(calls.some(([, args]) => args.includes('--max-budget-usd')));
  assert.ok(calls.some(([, args]) => args.includes('--sandbox') && args.includes('read-only')));
});

test('API calls are bounded and do not invent billed spend', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, text: async () => JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'API answer' }] }], usage: { input_tokens: 5, output_tokens: 2 } }) };
  };
  const manager = new ProviderManager({ commandRunner: mockCommands, fetchImpl, env: {} });
  await manager.connect({ id: 'openai', method: 'key', key: 'test-key', model: 'gpt-6.1-sol' });
  const result = await manager.run({ providerId: 'openai', prompt: 'Hi', maxUsd: 1 });
  assert.equal(result.text, 'API answer');
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 2, costUsd: 0.00003, costKind: 'estimated' });
  assert.equal(JSON.parse(requests[0].options.body).max_output_tokens, 1024);
  assert.doesNotMatch(JSON.stringify(manager.publicState()), /test-key/);
  await assert.rejects(manager.run({ providerId: 'openai', prompt: 'Hi', maxUsd: 0 }), /budget/);
});

test('Modal discovers a model with a Proxy Token and rejects account tokens', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'test.us-west.modal.direct' }] }) });
  const manager = new ProviderManager({ commandRunner: mockCommands, fetchImpl, env: {} });
  await assert.rejects(manager.connect({ id: 'modal', method: 'key', key: 'ak-account-token' }), /Proxy Token/);
  const state = await manager.connect({ id: 'modal', method: 'key', key: 'wk-id.ws-secret' });
  assert.deepEqual(state.models, ['test.us-west.modal.direct']);
  assert.equal(state.fleetSupported, false);
  assert.equal(state.fleetEligible, false);
  assert.equal(manager.fleetRoute('modal').available, false);
  assert.doesNotMatch(JSON.stringify(state), /ws-secret/);
});

test('native OAuth claims are rejected and cancellation stops a child process', async () => {
  const manager = new ProviderManager({ commandRunner: mockCommands, env: {} });
  await assert.rejects(manager.connect({ id: 'modal', method: 'oauth' }), /does not handle OAuth/);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Cancelled by user')), 20);
  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.outcome === 'unknown');
});

test('an API abort is marked uncertain after submission', async () => {
  const controller = new AbortController();
  const manager = new ProviderManager({ env: {}, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    controller.abort();
  }) });
  await manager.connect({ id: 'openai', method: 'key', key: 'test-key' });
  await assert.rejects(manager.run({ providerId: 'openai', prompt: 'Hello', signal: controller.signal }),
    (error) => error.code === 'UNKNOWN' && error.unknown === true && error.outcome === 'unknown');
});

test('Claude subscription denial changes availability without exposing account details', async () => {
  const denied = async (command, args) => args[0] === '-p'
    ? { code: 1, stdout: JSON.stringify({ is_error: true, result: 'Your organization has disabled Claude subscription access for Claude Code', email: 'private@example.com' }), stderr: '' }
    : mockCommands(command, args);
  const manager = new ProviderManager({ commandRunner: denied, env: {} });
  await manager.connect({ id: 'claude', method: 'subscription' });
  await assert.rejects(manager.run({ providerId: 'claude', prompt: 'Hello' }), (error) => error.code === 'UNKNOWN');
  assert.equal(manager.publicState().find((item) => item.id === 'claude').available, false);
  assert.doesNotMatch(JSON.stringify(manager.publicState()), /private@example.com/);
});

test('native discovery auto-connects, explicit disconnect persists, and config has no secret', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'seagulled-provider-test-'));
  try {
    const manager = new ProviderManager({ dataDir, commandRunner: mockCommands, env: {} });
    await manager.discover();
    assert.equal(manager.publicState().find((item) => item.id === 'codex').connected, true);
    await manager.disconnect('codex');
    const again = new ProviderManager({ dataDir, commandRunner: mockCommands, env: {} });
    await again.discover();
    assert.equal(again.publicState().find((item) => item.id === 'codex').connected, false);
    const saved = await readFile(join(dataDir, 'connections.json'), 'utf8');
    assert.deepEqual(JSON.parse(saved).codex, { disabled: true });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('failed secure storage leaves API provider disconnected', async () => {
  const manager = new ProviderManager({ env: {}, credentialStore: { set: async () => { throw new Error('unavailable'); } } });
  await assert.rejects(manager.connect({ id: 'openai', method: 'key', key: 'test-key' }), /unavailable/);
  assert.equal(manager.publicState().find((item) => item.id === 'openai').connected, false);
});

test('fleet routes require explicit worker consent and expose only public eligibility', async () => {
  const manager = new ProviderManager({ commandRunner: mockCommands, env: { OPENAI_API_KEY: 'env-secret' } });
  await manager.discover();
  assert.deepEqual(manager.fleetRoute('missing'), { available: false, detail: 'Unknown provider.' });
  for (const id of ['codex', 'claude', 'antigravity', 'modal', 'openai', 'anthropic', 'private-h100']) {
    assert.equal(manager.fleetRoute(id).available, false, id);
  }
  for (const state of manager.publicState()) assert.equal(state.fleetSupported, ['openai', 'anthropic', 'private-h100'].includes(state.id), state.id);
  assert.equal(manager.publicState().find((item) => item.id === 'openai').fleetEligible, false);
  await manager.connect({ id: 'openai', method: 'key', fleetAllowed: true });
  assert.deepEqual(manager.fleetRoute('openai'), {
    available: true,
    providerId: 'openai',
    model: { name: 'gpt-6.1-sol', baseUrl: 'https://api.openai.com/v1', provider: 'openai', adapter: 'openai-responses', apiKey: 'env-secret' },
    verification: 'unverified',
    costPolicy: 'pending',
  });
  assert.equal(manager.publicState().find((item) => item.id === 'openai').fleetEligible, true);
  assert.doesNotMatch(JSON.stringify(manager.publicState()), /env-secret/);
  await manager.connect({ id: 'anthropic', method: 'key', key: 'anthropic-secret', model: 'claude-sonnet-5-5', fleetAllowed: true });
  assert.deepEqual(manager.fleetRoute('anthropic').model, {
    name: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com', provider: 'anthropic', adapter: 'anthropic', apiKey: 'anthropic-secret',
  });
  await assert.rejects(manager.connect({ id: 'codex', method: 'subscription', fleetAllowed: true }), /not qualified/);
  await assert.rejects(manager.connect({ id: 'modal', method: 'key', fleetAllowed: true }), /not qualified/);
  await assert.rejects(manager.connect({ id: 'openai', method: 'key', fleetAllowed: 'true' }), /must be a boolean/);
});

test('worker consent reuses the connected key and model, persists only consent metadata, and can be revoked', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'seagulled-provider-test-'));
  const secrets = new Map();
  const credentialStore = {
    get: async (id) => secrets.get(id),
    set: async (id, value) => { secrets.set(id, value); },
    delete: async (id) => { secrets.delete(id); },
  };
  try {
    const manager = new ProviderManager({ dataDir, commandRunner: mockCommands, env: {}, credentialStore });
    await manager.connect({ id: 'openai', method: 'key', key: 'stored-secret', model: 'gpt-6-astra' });
    assert.equal(manager.fleetRoute('openai').available, false);
    await manager.connect({ id: 'openai', method: 'key', fleetAllowed: true });
    assert.equal(manager.fleetRoute('openai').model.apiKey, 'stored-secret');
    assert.equal(manager.fleetRoute('openai').model.name, 'gpt-6-astra');
    const saved = await readFile(join(dataDir, 'connections.json'), 'utf8');
    assert.deepEqual(JSON.parse(saved).openai, { method: 'key', model: 'gpt-6-astra', fleetAllowed: true });
    assert.doesNotMatch(saved, /stored-secret/);
    const restarted = new ProviderManager({ dataDir, commandRunner: mockCommands, env: {}, credentialStore });
    await restarted.discover();
    assert.equal(restarted.fleetRoute('openai').model.apiKey, 'stored-secret');
    await restarted.connect({ id: 'openai', method: 'key', fleetAllowed: false });
    assert.equal(restarted.fleetRoute('openai').available, false);
    await restarted.disconnect('openai');
    assert.equal(restarted.fleetRoute('openai').available, false);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'connections.json'), 'utf8')).openai, { disabled: true });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('worker consent cannot revive a disconnected or blocked API connection without a supplied key', async () => {
  const manager = new ProviderManager({ commandRunner: mockCommands, env: { OPENAI_API_KEY: 'env-secret' }, fetchImpl: async () => ({ status: 401, ok: false }) });
  await assert.rejects(manager.connect({ id: 'openai', method: 'key', fleetAllowed: true }), /Connect this API provider/);
  await manager.discover();
  await manager.connect({ id: 'openai', method: 'key', fleetAllowed: true });
  await assert.rejects(manager.run({ providerId: 'openai', prompt: 'Hi', maxUsd: 1 }), /rejected authentication/);
  assert.equal(manager.fleetRoute('openai').available, false);
  await assert.rejects(manager.connect({ id: 'openai', method: 'key', fleetAllowed: true }), /was blocked/);
  await manager.connect({ id: 'openai', method: 'key', key: 'replacement-secret' });
  assert.equal(manager.fleetRoute('openai').available, false);
  await manager.disconnect('openai');
  await assert.rejects(manager.connect({ id: 'openai', method: 'key', fleetAllowed: true }), /Connect this API provider/);
});

test('Codex developer writes only in owned workspace and returns artifact receipt', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'seagulled-provider-test-'));
  const calls = [];
  const commandRunner = async (command, args, options) => {
    if (args[0] !== 'exec') return mockCommands(command, args);
    calls.push({ args, cwd: options.cwd, env: options.env });
    if (options.input.includes('For concrete files')) return { code: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ response: 'Prepared artifact.', files: [{ path: 'artifact.txt', content: 'proof' }] }) } }), stderr: '' };
    return mockCommands(command, args);
  };
  try {
    const manager = new ProviderManager({ dataDir, commandRunner, env: { PATH: process.env.PATH, OPENAI_API_KEY: 'hidden' } });
    await manager.connect({ id: 'codex', method: 'subscription' });
    const development = await manager.run({ providerId: 'codex', prompt: 'Create an artifact.', goalId: 'goal-1', role: 'developer' });
    const review = await manager.run({ providerId: 'codex', prompt: 'Review it.', goalId: 'goal-1', role: 'reviewer' });
    assert.equal(development.artifacts.length, 1);
    assert.equal(development.artifacts[0].bytes, 5);
    assert.match(development.artifacts[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(development.workspace, review.workspace);
    assert.equal(calls[0].args.includes('read-only'), true);
    assert.equal(calls[1].args.includes('read-only'), true);
    assert.equal(calls[0].env.OPENAI_API_KEY, undefined);
    assert.equal(await readFile(join(development.workspace, 'artifact.txt'), 'utf8'), 'proof');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('provider artifact paths cannot escape the owned workspace', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'seagulled-provider-test-'));
  const commandRunner = async (command, args) => args[0] === 'exec'
    ? { code: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ response: 'bad', files: [{ path: '../escape.txt', content: 'bad' }] }) } }), stderr: '' }
    : mockCommands(command, args);
  try {
    const manager = new ProviderManager({ dataDir, commandRunner, env: {} });
    await manager.connect({ id: 'codex', method: 'subscription' });
    await assert.rejects(manager.run({ providerId: 'codex', prompt: 'Write a file', goalId: 'goal-1', role: 'developer' }), /unsafe artifact path/);
    await assert.rejects(access(join(dataDir, 'workspaces', 'escape.txt')));
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('structured exhausted credits block paid retries until explicit reconnect', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'seagulled-provider-test-'));
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { status: 429, ok: false, text: async () => JSON.stringify({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'No credits remaining' } }) };
  };
  try {
    const manager = new ProviderManager({ dataDir, fetchImpl, commandRunner: mockCommands, env: {} });
    await manager.connect({ id: 'openai', method: 'key', key: 'fixture-key' });
    await assert.rejects(manager.run({ providerId: 'openai', prompt: 'Hi', maxUsd: 1 }),
      (error) => error.outcome === 'not_applied' && error.code === 'PROVIDER_UNAVAILABLE' && !error.unknown);
    assert.equal(manager.publicState().find((item) => item.id === 'openai').available, false);
    assert.equal(manager.publicState().find((item) => item.id === 'openai').connected, false);
    await assert.rejects(manager.run({ providerId: 'openai', prompt: 'Hi', maxUsd: 1 }), /credits/);
    assert.equal(calls, 1);
    await manager.discover();
    assert.equal(manager.publicState().find((item) => item.id === 'openai').available, false);
    const saved = await readFile(join(dataDir, 'connections.json'), 'utf8');
    assert.doesNotMatch(saved, /fixture-key/);
    assert.match(saved, /blocked/);
    const restarted = new ProviderManager({ dataDir, fetchImpl, commandRunner: mockCommands, env: { OPENAI_API_KEY: 'fixture-key' } });
    await restarted.discover();
    assert.equal(restarted.publicState().find((item) => item.id === 'openai').available, false);
    assert.equal(restarted.publicState().find((item) => item.id === 'openai').connected, false);
    await manager.connect({ id: 'openai', method: 'key', key: 'replacement-key' });
    assert.equal(manager.publicState().find((item) => item.id === 'openai').available, true);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('definitive auth denials are not applied; ambiguous 429 and 502 stay unknown', async () => {
  for (const status of [401, 403]) {
    const manager = new ProviderManager({ env: {}, fetchImpl: async () => ({ status, ok: false, text: async () => { throw new Error('body should not be needed'); } }) });
    await manager.connect({ id: 'anthropic', method: 'key', key: 'fixture-key' });
    await assert.rejects(manager.run({ providerId: 'anthropic', prompt: 'Hi', maxUsd: 1 }),
      (error) => error.outcome === 'not_applied' && error.code === 'PROVIDER_UNAVAILABLE');
    assert.equal(manager.publicState().find((item) => item.id === 'anthropic').available, false);
  }
  for (const status of [429, 502]) {
    const manager = new ProviderManager({ env: {}, fetchImpl: async () => ({ status, ok: false, text: async () => JSON.stringify({ error: { type: 'rate_limit_error', message: 'Try later' } }) }) });
    await manager.connect({ id: 'openai', method: 'key', key: 'fixture-key' });
    await assert.rejects(manager.run({ providerId: 'openai', prompt: 'Hi', maxUsd: 1 }),
      (error) => error.outcome === 'unknown' && error.code === 'UNKNOWN' && error.unknown === true);
    assert.equal(manager.publicState().find((item) => item.id === 'openai').available, true);
  }
});
