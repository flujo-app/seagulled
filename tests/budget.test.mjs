import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBudgets } from '../src/budget.mjs';
import { createRuntime } from '../src/runtime.mjs';

const clock = () => Date.parse('2026-10-05T12:00:00Z');
const quote = () => ({ result: 'success', base_code: 'USD', time_last_update_unix: clock() / 1000 - 3600, rates: { USD: 1, COP: 4000, EUR: 0.9 } });
function folder(t) { const dir = mkdtempSync(path.join(tmpdir(), 'seagulled-budget-')); t.after(() => rmSync(dir, { force: true, recursive: true })); return dir; }
test('currency budget converts from a dated quote, retains entered currency, caches privately, and leaves USD independent', async t => {
  const dataDir = folder(t); let requests = 0;
  const budgets = createBudgets({ dataDir, clock, fetchImpl: async () => { requests++; return new Response(JSON.stringify(quote())); } });
  const budget = await budgets.resolve({ amount: 20000, currency: 'COP' });
  assert.equal(budget.allowanceUsd, 5); assert.equal(budget.amount, 20000); assert.equal(budget.currency, 'COP');
  assert.equal(budget.quoteAsOf, '2026-10-05T11:00:00.000Z'); assert.equal(budget.usdPerUnit, 1 / 4000);
  await budgets.resolve({ amount: 9, currency: 'EUR' }); assert.equal(requests, 1);
  assert.equal((await budgets.default('COP')).amount, 200000); assert.equal(requests, 1);
  assert.equal(existsSync(path.join(dataDir, 'exchange-rate.json')), true);
  assert.equal((await budgets.resolve(undefined, 7)).allowanceUsd, 7); assert.equal(requests, 1);
});
test('offline, stale, malformed and unsupported quotes never reinterpret local money as USD', async t => {
  const dataDir = folder(t), stale = quote(); stale.time_last_update_unix -= 3 * 86400;
  writeFileSync(path.join(dataDir, 'exchange-rate.json'), JSON.stringify(stale));
  const offline = createBudgets({ dataDir, clock, fetchImpl: async () => { throw new Error('Offline'); } });
  await assert.rejects(offline.resolve({ amount: 20000, currency: 'COP' }), /unavailable/);
  assert.equal((await offline.resolve({ amount: 5, currency: 'USD' })).allowanceUsd, 5);
  const budgets = createBudgets({ dataDir, clock, fetchImpl: async () => new Response(JSON.stringify(quote())) });
  for (const budget of [{ amount: 5, currency: 'ZZZ' }, { amount: -1, currency: 'USD' }, { amount: Infinity, currency: 'EUR' }, { amount: 1e-12, currency: 'USD' }]) await assert.rejects(budgets.resolve(budget));
});
test('goal budgets and capacity persist, and invalid limits are rejected before provider discovery', async t => {
  const dataDir = folder(t); let discoveries = 0;
  const providers = { discover: async () => { discoveries++; return []; }, publicState: () => [] };
  const budgets = createBudgets({ dataDir, clock, fetchImpl: async () => new Response(JSON.stringify(quote())) });
  const runtime = createRuntime({ executionMode: 'local', dataDir, providers, budgets, swarm: {} });
  t.after(() => runtime.close());
  for (const options of [{ maxWorkers: 7 }, { agentsPerWorker: 11 }, { maxWorkers: '3' }, { agentsPerWorker: 0 }]) await assert.rejects(runtime.chat('Build a planner.', options));
  assert.equal(discoveries, 0); assert.equal(runtime.snapshot().goals.length, 0);
  const goal = await runtime.chat('Build a planner.', { budget: { amount: 20000, currency: 'COP' }, maxWorkers: 2, agentsPerWorker: 4 });
  assert.equal(goal.budgetUsd, 5); assert.equal(goal.maxWorkers, 2); assert.equal(goal.agentsPerWorker, 4);
  await runtime.updateGoal(goal.id, { maxWorkers: 1, budget: { amount: 9, currency: 'EUR' } });
  await runtime.close();
  const reopened = createRuntime({ executionMode: 'local', dataDir, providers, budgets, swarm: {} });
  t.after(() => reopened.close());
  const saved = reopened.snapshot().goals[0];
  assert.equal(saved.maxWorkers, 1); assert.equal(saved.agentsPerWorker, 4); assert.equal(saved.budget.currency, 'EUR'); assert.equal(saved.budgetUsd, 10);
  await reopened.close();
});
test('currency edits fence the current run before waiting for a quote and never admit its next task', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'seagulled-currency-edit-'));
  let sink, releaseRun, resolveQuote, quotesStarted = false, secondDispatches = 0;
  const providers = { discover: async () => [{ id: 'fixture', connected: true, available: true }], publicState: () => [] };
  const base = createBudgets({ dataDir });
  const budgets = { resolve(input, legacy) {
    if (!input) return base.resolve(input, legacy);
    quotesStarted = true;
    return new Promise(resolve => { resolveQuote = resolve; });
  } };
  const swarm = { setEventHandler(handler) { sink = handler; }, async execute({ goal, signal }) {
    await new Promise(resolve => { releaseRun = resolve; });
    sink({ type: 'usage', goalId: goal.id, usage: { costUsd: 0.01, costKind: 'estimated' } });
    if (signal.aborted) throw Object.assign(new Error('Paused at receipt.'), { name: 'AbortError' });
    secondDispatches++; return { text: 'Unexpected second dispatch.' };
  } };
  const runtime = createRuntime({ executionMode: 'local', dataDir, providers, budgets, swarm });
  t.after(async () => { await runtime.close(); rmSync(dataDir, { force: true, recursive: true }); });
  const goal = await runtime.chat('Build safely.');
  const editing = runtime.updateGoal(goal.id, { budget: { amount: 20000, currency: 'COP' } });
  assert.equal(runtime.snapshot().goals[0].status, 'pausing'); assert.equal(quotesStarted, false);
  releaseRun();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quotesStarted, true); assert.equal(runtime.snapshot().goals[0].status, 'paused'); assert.equal(secondDispatches, 0);
  resolveQuote({ amount: 20000, currency: 'COP', allowanceUsd: 5, usdPerUnit: 1 / 4000, quoteAsOf: '2026-10-05T00:00:00Z' });
  const changed = await editing;
  assert.equal(changed.status, 'paused'); assert.equal(changed.budget.currency, 'COP'); assert.equal(changed.spentUsd, 0.01);
});
