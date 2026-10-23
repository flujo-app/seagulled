import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SOURCE = 'https://open.er-api.com/v6/latest/USD';
const MAX_AGE = 48 * 60 * 60 * 1000;
export const DEFAULT_BUDGET_USD = 50;
// Published PAYG compute rates, checked 2026-10-07. This is a planning
// snapshot for iad/ewr, never a billing receipt or an admission capability.
export const SWARM_COMPUTE_PRICING = Object.freeze({
  source: 'https://docs.fly.io/about/pricing', checkedAt: '2026-10-07',
  regions: Object.freeze(['iad', 'ewr']), cpuKind: 'shared', cpus: 1,
  baseMemoryMb: 1024, baseMonthlyUsd: 6.70, extraGbMonthlyUsd: 6,
  monthHours: 720,
});

export const budgetCeiling = goal => goal.unlimited === true && goal.budgetUsd === null ? Infinity : goal.budgetUsd;
export const unlimitedBudget = () => ({ amount: null, currency: 'USD', allowanceUsd: null, unlimited: true, usdPerUnit: 1, quoteAsOf: null, quoteSource: null });
export function planSwarm({ budgetUsd = DEFAULT_BUDGET_USD, unlimited = false,
  workers, agents = 10, memoryMb: selectedMemory, hours = 24, region = 'iad' } = {}) {
  if (typeof unlimited !== 'boolean') throw new Error('Unlimited must be on or off.');
  const allowance = unlimited ? null : usdAmount(budgetUsd);
  const agentCount = capacity(agents, 10, 10);
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 720) throw new Error('Choose a planning duration above zero and at most 720 hours.');
  if (!SWARM_COMPUTE_PRICING.regions.includes(region)) throw new Error('Compute prices are only verified for iad and ewr.');
  if (selectedMemory !== undefined && ![1024, 2048, 4096].includes(selectedMemory)) throw new Error('Choose 1, 2, or 4 GB of memory.');
  const memoryMb = selectedMemory ?? (agentCount <= 2 ? 1024 : agentCount <= 5 ? 2048 : 4096);
  const monthlyUsd = SWARM_COMPUTE_PRICING.baseMonthlyUsd
    + (memoryMb / 1024 - 1) * SWARM_COMPUTE_PRICING.extraGbMonthlyUsd;
  const workerHourlyUsd = monthlyUsd / SWARM_COMPUTE_PRICING.monthHours;
  const affordableWorkers = unlimited ? 100 : Math.min(100, Math.floor(allowance / (workerHourlyUsd * hours)));
  const requestedWorkers = workers === undefined ? Math.min(10, Math.max(1, affordableWorkers)) : capacity(workers, 10, 100);
  const computeUsd = requestedWorkers * workerHourlyUsd * hours;
  return { workers: requestedWorkers, agents: agentCount, memoryMb, region,
    budgetUsd: allowance, unlimited, hours, affordableWorkers,
    withinComputeAllowance: unlimited || computeUsd <= allowance,
    estimate: { costKind: 'estimated', workerHourlyUsd, hourlyUsd: requestedWorkers * workerHourlyUsd,
      computeUsd, inferenceUsd: null, totalUsd: null,
      excludes: ['inference', 'storage', 'egress', 'stopped-rootfs', 'taxes', 'account-adjustments'] },
    pricing: { ...SWARM_COMPUTE_PRICING, regions: [...SWARM_COMPUTE_PRICING.regions] },
    executionVerified: false };
}
export function capacity(value, fallback, maximum) {
  const number = value === undefined ? fallback : value;
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`Choose a whole number from 1 to ${maximum}.`);
  return number;
}
export function usdAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100000) throw new Error('Choose a budget above zero and at most 100,000 USD.');
  const rounded = Math.round(number * 1e6) / 1e6;
  if (rounded <= 0) throw new Error('That allowance is too small.');
  return rounded;
}
export function createBudgets({ dataDir, fetchImpl = fetch, clock = Date.now } = {}) {
  const cachePath = path.join(dataDir, 'exchange-rate.json');
  let cached, loading;
  try { cached = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* Cache is optional. */ }
  const valid = quote => quote?.result === 'success' && quote.base_code === 'USD' &&
    Number.isFinite(quote.time_last_update_unix) && quote.time_last_update_unix * 1000 <= clock() + 300000 &&
    clock() - quote.time_last_update_unix * 1000 <= MAX_AGE && quote.rates?.USD === 1;
  const quotes = async () => {
    if (valid(cached) && clock() - cached.time_last_update_unix * 1000 < 24 * 60 * 60 * 1000) return cached;
    if (!loading) loading = (async () => {
      try {
        const response = await fetchImpl(SOURCE, { signal: AbortSignal.timeout(8000), redirect: 'error' });
        if (!response.ok) throw new Error();
        // Limit bytes rather than letting a rate endpoint allocate unbounded memory.
        const chunks = []; let length = 0;
        for await (const chunk of response.body) { length += chunk.length; if (length > 64000) throw new Error(); chunks.push(chunk); }
        const quote = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!valid(quote)) throw new Error();
        cached = quote;
        const temporary = `${cachePath}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(quote), { mode: 0o600 }); renameSync(temporary, cachePath);
        return quote;
      } catch { if (valid(cached)) return cached; throw new Error('Currency conversion is unavailable; choose USD or try again later.'); }
    })().finally(() => { loading = undefined; });
    return loading;
  };
  return {
    async default(currency = 'USD') {
      if (currency === 'USD') return this.resolve(undefined, DEFAULT_BUDGET_USD);
      if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Choose a supported currency.');
      const quote = await quotes(), rate = quote.rates[currency];
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('That currency is unavailable.');
      const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
      const scale = 10 ** digits;
      return this.resolve({ currency, amount: Math.round(DEFAULT_BUDGET_USD * rate * scale) / scale });
    },
    async resolve(input, legacyUsd = DEFAULT_BUDGET_USD) {
      if (input === undefined) {
        const amount = usdAmount(legacyUsd);
        return { amount, currency: 'USD', allowanceUsd: amount, usdPerUnit: 1, quoteAsOf: null, quoteSource: null };
      }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['amount', 'currency'].includes(k)) ||
          typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0 ||
          typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) throw new Error('Choose a positive allowance and currency.');
      if (input.currency === 'USD') return this.resolve(undefined, input.amount);
      const quote = await quotes(), rate = quote.rates[input.currency];
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('That currency is unavailable.');
      return { amount: input.amount, currency: input.currency, allowanceUsd: usdAmount(input.amount / rate), usdPerUnit: 1 / rate,
        quoteAsOf: new Date(quote.time_last_update_unix * 1000).toISOString(), quoteSource: 'https://www.exchangerate-api.com' };
    },
  };
}
