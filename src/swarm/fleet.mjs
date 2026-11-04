import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { collectFlyArtifacts } from '../artifacts/fly.mjs';
import { planSwarm } from '../budget.mjs';
import { PRODUCT_WORKER_IMAGE } from '../product-runtime.mjs';
import { teamProfile, specialistStaffingBrief } from './team-profile.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unknown = (message) => Object.assign(new Error(message), { code: 'UNKNOWN', unknown: true });
const cancelled = () => Object.assign(new Error('Goal execution was cancelled.'), { name: 'AbortError' });
const assertAdmission = (signal, deadlineAt) => {
  if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError', outcome: 'not_applied' });
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw Object.assign(new Error('The fleet deadline passed before submission.'), { code: 'DEADLINE', outcome: 'not_applied' });
  }
};
export const flyUnavailable = 'A verified personal Fly sign-in, one selected personal organization, and the bundled Fly helper are required for isolated Workers.';
const regularFile = (value) => {
  try { return typeof value === 'string' && path.isAbsolute(value) && statSync(value).isFile(); }
  catch { return false; }
};
const validFlyAccount = (account) => Boolean(account
  && typeof account.flyConfigDir === 'string' && path.isAbsolute(account.flyConfigDir)
  && regularFile(account.flyctlPath) && regularFile(path.join(account.flyConfigDir, 'config.yml'))
  && typeof account.orgSlug === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(account.orgSlug)
  && ['private', 'shared'].includes(account.scope)
  && typeof account.accountRef === 'string'
  && /^fly-account-sha256:[a-f0-9]{64}$/.test(account.accountRef));
/** Backend-only, read-only account lease. It never returns a Fly token or public path. */
export async function flyAccountLease(providers, signal) {
  if (typeof providers?.flyFleetLease !== 'function') return null;
  const lease = await providers.flyFleetLease({ signal }).catch((error) => {
    if (error?.name === 'AbortError') throw Object.assign(error, { outcome: 'not_applied' });
    return null;
  });
  return lease?.available === true && validFlyAccount(lease)
    ? { flyctlPath: lease.flyctlPath, flyConfigDir: lease.flyConfigDir,
      orgSlug: lease.orgSlug, scope: lease.scope, accountRef: lease.accountRef } : null;
}
/** Dispatch obeys Stop; exact-resource cleanup rechecks identity without the aborted dispatch signal. */
export async function assertFleetAccountCurrent({ lease, intent, assertCurrent, signal, deadlineAt,
  operation = 'dispatch' } = {}) {
  if (!['dispatch', 'cleanup'].includes(operation)) throw new Error('Invalid Fly account operation.');
  if (operation === 'dispatch') assertAdmission(signal, deadlineAt);
  if (typeof assertCurrent !== 'function' || lease?.accountRef !== intent?.accountRef
    || lease?.orgSlug !== intent?.org
    || await assertCurrent(lease, { signal: operation === 'dispatch' ? signal : undefined }) !== true) {
    throw unknown('The selected Fly account continuation could not be verified.');
  }
}
/** The cloud helpers and all Fly CLI children receive only this selected personal account. */
export function isolatedFlyEnvironment(account, sourceEnv = process.env) {
  if (!validFlyAccount(account)) throw new Error(flyUnavailable);
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) {
    if (typeof sourceEnv[key] === 'string') env[key] = sourceEnv[key];
  }
  env.FLY_CONFIG_DIR = account.flyConfigDir;
  env.FLYCTL_PATH = account.flyctlPath;
  return env;
}
const productSourceUnavailable = 'The cloud helpers for isolated Workers are not ready in this installation.';
const CLOUD_HELPERS = ['process.mjs', 'machines.mjs', 'bridge.mjs', 'images.mjs'];
/** FACTORY runs the fleet; it needs the installed cloud helpers for its Fly calls. */
export async function boundFleetSource({ sourceBinding, flyAccount, signal, deadlineAt } = {}) {
  assertAdmission(signal, deadlineAt);
  let cloudSdkRoot;
  try {
    if (!path.isAbsolute(sourceBinding?.cloudSdkRoot ?? '')) return { available: false, detail: productSourceUnavailable };
    cloudSdkRoot = realpathSync(sourceBinding.cloudSdkRoot);
    if (!CLOUD_HELPERS.every((name) => regularFile(path.join(cloudSdkRoot, 'lib', name)))) {
      return { available: false, detail: productSourceUnavailable };
    }
  } catch { return { available: false, detail: productSourceUnavailable }; }
  if (!validFlyAccount(flyAccount)) return { available: false, detail: flyUnavailable };
  return { available: true, binding: { cloudSdkRoot } };
}
const boundedCount = (value, fallback, maximum, name) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
};
export function goalCapacity(goal = {}) {
  if (goal.workerTopologyVersion !== undefined && ![1, 2, 3].includes(goal.workerTopologyVersion)) {
    throw new RangeError('workerTopologyVersion must be 1, 2 or 3.');
  }
  const strict = goal.workerTopologyVersion === 3;
  const maxWorkers = boundedCount(goal.maxWorkers, 10, strict ? 10 : 100, 'maxWorkers');
  if (goal.memoryMb !== undefined && ![1024, 2048, 4096].includes(goal.memoryMb)) throw new RangeError('Memory must be 1, 2, or 4 GB.');
  // Earlier saved goals allowed ten child agents (eleven total conversations).
  // Preserve that exact legacy capacity only when its derived child count agrees.
  const legacyEleven = !strict && goal.conversationsPerWorker === 11 && goal.agentsPerWorker === 10;
  const selected = goal.conversationsPerWorker === undefined ? undefined
    : legacyEleven ? 11 : boundedCount(goal.conversationsPerWorker, 10, 10, 'conversationsPerWorker');
  const legacy = goal.agentsPerWorker;
  if (legacy !== undefined && (!Number.isInteger(legacy) || legacy < 0 || legacy > (strict ? 9 : 10))) {
    throw new RangeError(`agentsPerWorker must be an integer from 0 to ${strict ? 9 : 10}.`);
  }
  if (selected !== undefined && legacy !== undefined && legacy !== selected - 1) {
    throw new RangeError('conversationsPerWorker and agentsPerWorker disagree.');
  }
  const conversationsPerWorker = selected ?? (legacy === undefined ? 10 : legacy + 1);
  return { maxWorkers, conversationsPerWorker, agentsPerWorker: conversationsPerWorker - 1 };
}
/** FLUJO's team flow has one gate of at most nine local agents, so a saved goal with ten cannot be staffed as it asked. */
export const FACTORY_TEAM_LIMIT = 9;
export function fleetExecutionLimits({ goal } = {}) {
  const capacity = goalCapacity(goal);
  return { workerCap: capacity.maxWorkers,
    teamLimits: { agentTurns: 6, leadTurns: 12, concurrency: capacity.agentsPerWorker } };
}
const STAFF_BRANCHES = Object.freeze([
  { name: 'context-evidence', angle: 'Map the context and gather primary evidence.' },
  { name: 'solution-build', angle: 'Develop and check a concrete solution.' },
  { name: 'independent-verification', angle: 'Independently verify the proposed result and artifacts.' },
  { name: 'adversarial-review', angle: 'Challenge the conclusion with counterexamples and unresolved risks.' },
  { name: 'handoff-synthesis', angle: 'Reconcile the evidence and prepare a bounded handoff.' },
]);
const TOOL_SCOPE_BRIEF = 'For an authorized file or shell task, filesystem allowed directories describe path scope, not read-only permission. ' +
  'Use a declared Bash or filesystem write tool before reporting a permission block; honor an actual tool denial. ';
const OUTPUT_BRIEF = 'Save final deliverable files under /data/results on your own Machine, and report paths relative to that folder. Each Worker must produce its own files. ';

/** One Worker's first message. Its angle, local staffing and duties come from the goal's team, never from a model's plan. */
export function workerBrief({ task, index, workerCap, localChildTarget = 0, profile, staffingBrief = specialistStaffingBrief, memberOf } = {}) {
  if (!Number.isInteger(workerCap) || workerCap < 1) throw new RangeError('Worker count must be positive.');
  if (!Number.isInteger(localChildTarget) || localChildTarget < 0 || localChildTarget > FACTORY_TEAM_LIMIT) {
    throw new RangeError(`Local child conversation count must be 0 to ${FACTORY_TEAM_LIMIT}.`);
  }
  const branch = STAFF_BRANCHES[(index - 1) % STAFF_BRANCHES.length];
  const staffing = localChildTarget
    ? `At the start of this run, call the installed start_subflow_ tool exactly ${localChildTarget} times with distinct concrete tasks. ` +
      'Record the returned child conversation IDs; then steer and wait for those same children. ' +
      'Do not start replacement local subflows or report a capacity gate as actual staffing. ' + staffingBrief(localChildTarget, profile)
    : memberOf ? '' : 'This Worker has only its lead conversation; do not start a local subflow. ';
  if (memberOf) {
    return `${task}\n\nYou are a team member under ${memberOf} on this Machine. YOUR DISTINCT ANGLE: ${branch.angle} ` +
      `${TOOL_SCOPE_BRIEF}${OUTPUT_BRIEF}Post findings with evidence through the FACTORY board tools and report what you actually ran.`;
  }
  if (index === 0) {
    return `${task}\n\nYou coordinate ${workerCap} Worker Machine${workerCap === 1 ? '' : 's'}, including yourself. ` +
      `${staffing}${TOOL_SCOPE_BRIEF}${OUTPUT_BRIEF}` +
      (workerCap > 1 ? 'The other Workers have their own angles and report through the FACTORY board tools, which also let you message them. You get their final reports when they finish. ' : '') +
      'Report which conversations actually completed and what remains uncertain.';
  }
  return `${task}\n\nYOUR DISTINCT ANGLE: ${branch.angle} Own partition ${index} of ${workerCap - 1}; coordinate concrete non-overlapping work with the team lead m0-a0. ` +
    `${staffing}${TOOL_SCOPE_BRIEF}${OUTPUT_BRIEF}Post findings with evidence through the FACTORY board tools, and report actual conversation IDs and remaining uncertainty.`;
}
/** Exactly the requested local conversations, from the Machine's own trace rather than a lead's claim. */
export function verifiedLocalConversations(traces, agentId, target, { requireCompleted = false } = {}) {
  const children = new Map();
  for (const event of traces) {
    const item = event.body?.item;
    if (event.source !== agentId || event.kind !== 'item/completed' || item?.type !== 'subflow') continue;
    if (typeof item.conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.conversationId)) {
      throw unknown('The Worker trace has an invalid conversation record.');
    }
    children.set(item.conversationId, item.phase === 'done' ? (item.status ?? 'unknown') : children.get(item.conversationId) ?? 'running');
  }
  const observed = [...children].map(([id, status]) => ({ id, status }));
  if (observed.length !== target) {
    throw Object.assign(new Error(`Worker started ${observed.length} local conversations; exactly ${target} were requested.`),
      { outcome: 'failed', localConversations: observed });
  }
  if (requireCompleted && observed.some((child) => child.status !== 'completed')) {
    throw Object.assign(new Error('A local agent has not completed successfully; agreement from its team lead cannot verify it.'), { outcome: 'failed' });
  }
  return observed;
}
/** Count retained original identities rather than a lead's staffing claim. */
export function verifiedTeamStaffing(entries, workerCount, childCount) {
  if (!Array.isArray(entries) || entries.length !== workerCount) throw unknown('The original Worker staffing receipt is incomplete.');
  const workers = new Set(), conversations = new Set();
  for (const entry of entries) {
    if (typeof entry.workerId !== 'string' || workers.has(entry.workerId) || typeof entry.leadConversationId !== 'string'
      || !entry.leadConversationId || !Array.isArray(entry.children) || entry.children.length !== childCount) {
      throw unknown('The original Worker staffing receipt is invalid.');
    }
    workers.add(entry.workerId);
    for (const id of [entry.leadConversationId, ...entry.children.map((child) => child.id)]) {
      if (typeof id !== 'string' || !id || conversations.has(id)) throw unknown('A staffing receipt repeats a conversation identity.');
      conversations.add(id);
    }
    if (entry.children.some((child) => child.status !== 'completed')) throw unknown('A staffing receipt contains an unfinished local agent.');
  }
  return { workerCount: workers.size, localConversationCount: workerCount * childCount,
    conversationCountVerified: conversations.size, childCompletionVerified: true };
}
const modelFingerprint = (model) => createHash('sha256').update(`${model.baseUrl}\0${model.name}\0${model.apiKey}`).digest('hex').slice(0, 24);
const modelHoldPath = (dataDir, model) => path.join(dataDir, 'fleet', `model-admission-${modelFingerprint(model)}.json`);
const modelHold = (dataDir, model) => dataDir && existsSync(modelHoldPath(dataDir, model));
const accountFingerprint = (model) => createHash('sha256').update(`${model.baseUrl}\0${model.apiKey}`).digest('hex').slice(0, 24);
const accountHoldPath = (dataDir, model) => path.join(dataDir, 'fleet', `account-admission-${accountFingerprint(model)}.json`);
function knownQuotaHold(dataDir, model) {
  if (!dataDir || !model?.apiKey) return false;
  if (existsSync(accountHoldPath(dataDir, model))) return true;
  // A prior isolated OpenAI boot call returned the exact no-credits denial for
  // gpt-4.1-mini. Preserve that account hold when the same key selects a new
  // model name; a catalog listing is not evidence that credits were restored.
  if (model.baseUrl !== 'https://api.openai.com/v1') return false;
  const legacy = modelHoldPath(dataDir, { ...model, name: 'gpt-4.1-mini' });
  try {
    const bytes = readFileSync(legacy);
    if (bytes.length > 8192) return false;
    const receipt = JSON.parse(bytes.toString('utf8'));
    return receipt?.state === 'held' && receipt.provider === 'openai-api'
      && /no credits remaining|insufficient_quota/i.test(receipt.reason ?? '');
  } catch { return false; }
}
const safeFailureField = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : undefined;
/** What a failed turn left in the trace: bounded fields only, never a provider's message body. */
export function turnFailure(traces, agentId) {
  const own = traces.filter((event) => event.source === agentId);
  const completed = own.filter((event) => event.kind === 'native.turn.completed').at(-1)?.body?.turn;
  const error = own.filter((event) => event.kind === 'flujo/error').at(-1)?.body;
  const httpStatus = completed?.error?.code;
  return { status: safeFailureField(completed?.status),
    ...(Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? { providerHttpStatus: httpStatus } : {}),
    ...(safeFailureField(error?.code) ? { code: safeFailureField(error.code) } : {}),
    ...(typeof error?.message === 'string' ? { message: error.message.slice(0, 200) } : {}) };
}

/** Only a failed original turn may hold an account, and only for an explicit no-credits denial. */
export function recordConfirmedQuotaHold({ dataDir, model, providerId, goalId, workerId, failure } = {}) {
  const quotaCode = failure?.providerHttpStatus === 429 && failure?.code === 'insufficient_quota';
  const exactNoCredits = [402, 429].includes(failure?.providerHttpStatus)
    && typeof failure?.message === 'string' && /no credits remaining[.!]?$/i.test(failure.message.trim());
  if (failure?.status !== 'failed' || !(quotaCode || exactNoCredits)
    || !dataDir || !model?.apiKey || !exactProductBinding(providerId, model)) return false;
  const target = accountHoldPath(dataDir, model);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) {
    try {
      writeFileSync(target, JSON.stringify({ version: 1, state: 'held', accountFingerprint: accountFingerprint(model),
        providerId, classification: 'confirmed_no_credits', source: 'original_fly_turn',
        goalId, workerId, observedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  return true;
}

async function modelProbe(model, { signal, deadlineAt } = {}) {
  assertAdmission(signal, deadlineAt);
  try {
    const anthropic = model.provider === 'anthropic' && model.adapter === 'anthropic';
    const base = model.baseUrl.endsWith('/') ? model.baseUrl : `${model.baseUrl}/`;
    const url = anthropic ? new URL(`v1/models/${encodeURIComponent(model.name)}`, base) : new URL('models', base);
    const response = await fetch(url, {
      method: 'GET', headers: anthropic
        ? { 'x-api-key': model.apiKey, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${model.apiKey}` },
      signal: AbortSignal.any([AbortSignal.timeout(7000), signal,
        deadlineAt === undefined ? undefined : AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]
        .filter(Boolean)), redirect: 'error',
    });
    if (!response.ok) return { available: false, detail: `HTTP ${response.status}` };
    const maxBytes = 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) {
      return { available: false, detail: 'model catalog is oversized' };
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > maxBytes) return { available: false, detail: 'model catalog is oversized' };
      chunks.push(chunk);
    }
    let catalogue;
    try { catalogue = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return { available: false, detail: 'invalid model catalog' }; }
    if (anthropic && catalogue?.id !== model.name) return { available: false, detail: 'model identity not confirmed' };
    if (!anthropic && (!Array.isArray(catalogue?.data)
      || !catalogue.data.every((entry) => entry && typeof entry.id === 'string'))) {
      return { available: false, detail: 'invalid model catalog' };
    }
    if (!anthropic && !catalogue.data.some((entry) => entry.id === model.name)) {
      return { available: false, detail: 'model absent from catalog' };
    }
    assertAdmission(signal, deadlineAt);
    return { available: true };
  } catch (error) {
    if (signal?.aborted || deadlineAt !== undefined && Date.now() >= deadlineAt) assertAdmission(signal, deadlineAt);
    return { available: false, detail: 'endpoint did not respond' };
  }
}

const PRIVATE_SERVED_MODELS = Object.freeze({ 'qwen3.8-27b': 'qwen', 'nemotron-3.5-super-vl': 'nemotron' });
const nativeCodex = (model) => model?.provider === 'codex' && model?.adapter === 'codex-cli'
  && typeof model.name === 'string' && model.name.length > 0 && !model.apiKey;
const PRODUCT_BINDINGS = Object.freeze({
  openai: { provider: 'openai', adapter: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { provider: 'anthropic', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com' },
});
const exactProductBinding = (providerId, model, route) => {
  if (providerId === 'codex') return nativeCodex(model)
    && typeof model.reasoningEffort === 'string'
    && route?.authTransfer === 'host-refreshed-token';
  if (providerId === 'private-h100') {
    try {
      const url = new URL(model?.baseUrl);
      // Each served model belongs to exactly one owned app family (Qwen on H100, Nemotron on B300).
      const family = PRIVATE_SERVED_MODELS[model?.name];
      return Boolean(family) && model.provider === 'openai' && model.adapter === 'openai'
        && url.protocol === 'https:' && !url.username && !url.password && !url.port
        && (url.hostname.endsWith('.modal.run') || url.hostname.endsWith('.modal.direct'))
        && new RegExp(`(?:^|[.-])seagulled-${family}-[a-f0-9]{12}(?:[.-]|$)`).test(url.hostname)
        && model.baseUrl === `${url.origin}/v1` && !url.search && !url.hash
        && (route?.verification === 'inference-verified'
          && route.costPolicy === 'estimated-gpu-seconds'
          && /^[a-f0-9-]{36}$/.test(route.ownedAttemptId ?? ''));
    } catch { return false; }
  }
  const expected = PRODUCT_BINDINGS[providerId];
  return Boolean(expected && model && Object.entries(expected).every(([field, value]) => model[field] === value));
};

/** Read-only discovery. Product calls require the selected provider's private route. */
async function inspectFleet({ dataDir, providerId, fleetRoute, goalId, flyAccount, sourceBinding, signal, deadlineAt, probeModel = modelProbe } = {}) {
  assertAdmission(signal, deadlineAt);
  if (fleetRoute?.available !== true || fleetRoute.providerId !== providerId
    || typeof providerId !== 'string' || !providerId) {
    return { available: false, detail: 'The selected provider has no Fly route. Local provider work remains available.' };
  }
  if (providerId === 'private-h100' && fleetRoute.leaseGoalId !== goalId) {
    return { available: false, detail: 'The private Worker route is not leased to this goal.' };
  }
  const model = fleetRoute.model;
  if (!exactProductBinding(providerId, model, fleetRoute)
    || typeof model.name !== 'string' || !model.name
    || typeof model.apiKey !== 'string' || !model.apiKey && !nativeCodex(model)) {
    return { available: false, detail: 'The selected provider has no usable Fly model binding.' };
  }
  if (modelHold(dataDir, model) || knownQuotaHold(dataDir, model)) {
    return { available: false, detail: 'The selected provider account has a saved no-credits hold. Local provider work remains available.' };
  }
  const source = await boundFleetSource({ sourceBinding, flyAccount, signal, deadlineAt });
  if (!source.available) return source;
  const config = { model, cloudSdkRoot: source.binding.cloudSdkRoot };
  if (nativeCodex(model)) {
    return { available: true, provider: 'codex-subscription-candidate',
      detail: 'Codex runs on each Worker with short-lived tokens from this computer; inference executes on Fly and is verified from original Worker receipts.',
      providerId, config };
  }
  const original = await probeModel(model, { signal, deadlineAt });
  if (original.available) {
    return { available: true, provider: 'configured-model', modelIdentityVerified: true,
      detail: 'The selected provider model catalog is configured; live Fly execution has not been verified.',
      providerId, config };
  }
  return { available: false,
    detail: `The selected provider model endpoint is unavailable (${original.detail}); local provider work remains available.` };
}

export async function fleetStatus({ dataDir, providerId, fleetRoute, goalId, flyAccount, sourceBinding,
  signal, deadlineAt } = {}) {
  const { config, ...publicState } = await inspectFleet({ dataDir, providerId, fleetRoute, goalId,
    flyAccount, sourceBinding, signal, deadlineAt });
  return publicState;
}

/** How one provider route maps to a FACTORY plan. FLUJO runs every keyed model; Codex has its own native program. */
export function workerProgramForRoute(route, { localChildTarget, teamLimits, profile } = {}) {
  const { model } = route;
  if (nativeCodex(model)) {
    return { plan: { workerProgram: 'codex', model: model.name, subagentModel: model.name, reasoningEffort: model.reasoningEffort,
      agentsPerMachine: localChildTarget + 1 }, members: localChildTarget, localChildTarget: 0 };
  }
  const apis = model.adapter === 'anthropic' ? ['anthropic'] : model.adapter === 'openai-responses' ? ['responses'] : ['chat'];
  return { key: model.apiKey, members: 0, localChildTarget,
    plan: { workerProgram: 'flujo', agentsPerMachine: 1,
      modelProvider: { id: route.providerId, name: route.providerId, envKey: 'SEAGULLED_MODEL_KEY', model: model.name, baseUrls: [model.baseUrl], apis,
        ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}) },
      flujo: { agentTurns: teamLimits.agentTurns, leadTurns: teamLimits.leadTurns,
        ...(localChildTarget ? { teamConcurrency: localChildTarget } : {}), ...(profile ? { specialists: profile } : {}) } } };
}
const installedSdk = () => import('flujo-factory');
const textTraces = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
/** An agent's last written words, optionally from one turn only so that an older progress note cannot pass as its report. */
const lastAnswer = (traces, agentId, turnId) => traces.filter((event) => event.source === agentId && event.kind === 'item/completed'
  && event.body?.item?.type === 'agentMessage' && !event.body.item.depth && (!turnId || event.body.turnId === turnId)).at(-1)?.body.item.text ?? '';
/** A model route may not report token counts at all. That is unknown, not zero. */
const tokenTotals = (traces) => {
  const reports = traces.filter((event) => event.kind === 'thread/tokenUsage/updated');
  if (!reports.length) return { inputTokens: null, outputTokens: null };
  return reports.reduce((sum, event) => ({
    inputTokens: sum.inputTokens + (event.body?.tokenUsage?.last?.inputTokens ?? 0),
    outputTokens: sum.outputTokens + (event.body?.tokenUsage?.last?.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 });
};

/**
 * One goal's company on its own FACTORY fleet: one Machine per Worker. FACTORY owns provisioning,
 * the board, operator commands, stop receipts and traces. This file maps a goal to a plan, keeps
 * the product's guarantees (budget hold, no replay, verified staffing, output before retirement),
 * and owns nothing that talks to a Worker directly.
 */
export async function runFleetLeaf({ goal, task, dataDir, signal, maxUsd, fleetRoute, reservationId, reserveCloud,
  flyAccount, sourceBinding, assertFlyAccountCurrent,
  onStatus = () => undefined, onCompany = () => undefined, onWorker = () => undefined,
  loadSdk = installedSdk, fleetFactory, probeModel, image = PRODUCT_WORKER_IMAGE, pollMs = 5000, enrolTimeoutMs = 25 * 60_000, runTimeoutMs = 60 * 60_000, retryWindowMs = 180_000 } = {}) {
  if (!goal || typeof goal.id !== 'string' || !/^[\w-]{1,100}$/.test(goal.id)) throw new Error('A safe goal id is required for isolated fleet work.');
  goalCapacity(goal);
  const fleetDeadlineAt = Date.now() + 90 * 60_000;
  assertAdmission(signal, fleetDeadlineAt);
  if (!validFlyAccount(flyAccount)) return { available: false, detail: flyUnavailable };
  const discovered = await inspectFleet({ dataDir, providerId: goal.providerId, fleetRoute, goalId: goal.id,
    flyAccount, sourceBinding, signal, deadlineAt: fleetDeadlineAt, ...(probeModel ? { probeModel } : {}) });
  assertAdmission(signal, fleetDeadlineAt);
  if (!discovered.available) return { available: false, detail: discovered.detail };
  const { workerCap, teamLimits } = fleetExecutionLimits({ goal });
  if (teamLimits.concurrency > FACTORY_TEAM_LIMIT) {
    throw Object.assign(new Error('This saved goal asks for more local agents per Worker than a Worker can run.'), { outcome: 'not_applied' });
  }
  const goalDirectory = path.join(dataDir, 'fleet', goal.id);
  const intentPath = path.join(goalDirectory, 'intent.json');
  const directory = path.join(goalDirectory, 'factory');
  if (existsSync(intentPath) || existsSync(directory)) {
    throw unknown('A prior Fly fleet intent exists for this goal. Reconcile its original Workers before more provisioning.');
  }
  const sdk = await loadSdk();
  assertAdmission(signal, fleetDeadlineAt);
  const profile = teamProfile(goal, sdk.CASE_SPECIALISTS_V1);
  const program = workerProgramForRoute(fleetRoute, { localChildTarget: teamLimits.concurrency, teamLimits, profile });
  const suffix = randomBytes(8).toString('hex');
  mkdirSync(goalDirectory, { recursive: true, mode: 0o700 });
  let intent = { version: 2, goalId: goal.id, app: `seagulled-${suffix}`, network: `seagulled-g-${randomBytes(16).toString('hex')}`,
    org: flyAccount.orgSlug, accountRef: flyAccount.accountRef, state: 'preparing', createdAt: new Date().toISOString() };
  writeFileSync(intentPath, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
  const record = (patch) => {
    intent = { ...intent, ...patch, updatedAt: new Date().toISOString() };
    const temporary = `${intentPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(intent), { mode: 0o600 });
    renameSync(temporary, intentPath);
  };
  const assertAccountCurrent = ({ operation = 'dispatch' } = {}) => assertFleetAccountCurrent({ lease: flyAccount, intent,
    assertCurrent: assertFlyAccountCurrent, signal, deadlineAt: fleetDeadlineAt, operation });
  const flyEnv = isolatedFlyEnvironment(flyAccount);
  const fleetOptions = { directory, flujoCloudPath: discovered.config.cloudSdkRoot, flyCommand: flyAccount.flyctlPath, flyEnv, proxyEnv: flyEnv,
    ...(nativeCodex(fleetRoute.model) ? { auth: new sdk.CodexSubscriptionBroker({ authFile: fleetRoute.codexAuthFile, codexCommand: fleetRoute.codexCommand }) } : {}) };
  const fleet = fleetFactory ? fleetFactory(fleetOptions, sdk) : new sdk.FactoryCloudLiteFleet(fleetOptions);
  const leads = Array.from({ length: workerCap }, (_, index) => `m${index}-a0`);
  const workers = leads.map((agent, index) => ({ workerId: `m${index}`, agent, index }));
  const members = workers.flatMap((worker) => Array.from({ length: program.members }, (_, member) => ({ agent: `m${worker.index}-a${member + 1}`, worker, member: member + 1 })));
  const announce = (worker, status) => { try { onWorker({ workerId: worker.workerId, parentId: null, depth: 1, status }); } catch { /* A status listener cannot change an outcome. */ } };
  const tracesFile = path.join(directory, 'traces.jsonl');
  let accepted = false, cloudReserved = false, reservedUsd = Number.isFinite(maxUsd) ? maxUsd : undefined;
  let cleanupConfirmed = false, deliveredWork = false, delivered;
  const artifacts = [];
  const usage = (traces = []) => ({ ...tokenTotals(traces), costUsd: null, costKind: 'unknown', reservedUsd, billingPending: true,
    ...(cloudReserved ? { reservationId } : {}) });
  const deadlineLeft = () => { if (Date.now() >= fleetDeadlineAt) throw unknown('The Fly fleet reached its transport deadline. Preserve its original Workers for reconciliation.'); };
  const stopped = () => { if (signal?.aborted) throw cancelled(); };
  /** A Fly proxy can drop for a moment; reads and stable-id commands are safe to send again. Cleanup keeps trying after a stop. */
  const steady = async (operation, { cleanup = false } = {}) => {
    const giveUp = Date.now() + retryWindowMs;
    for (;;) {
      if (!cleanup) stopped();
      try { return await operation(); }
      catch (error) { if (error?.name === 'AbortError' || Date.now() >= giveUp) throw error; await sleep(Math.min(pollMs, 5000)); }
    }
  };
  const observe = () => steady(async () => {
    for (let page = 0; ; page++) {
      const status = await fleet.observe({ maxPages: 25 });
      if (status.traceCollection?.complete !== false || page >= 20) return status;
    }
  });
  const waitForTurns = async (jobs, ms) => {
    const giveUp = Date.now() + ms;
    for (;;) {
      stopped(); deadlineLeft();
      if (Date.now() >= giveUp) throw unknown('The Fly run reached its time limit. Its original Workers are retired, and its work is unconfirmed.');
      const status = await observe();
      const natives = new Map(status.agents.map((agent) => [agent.id, agent.nativeRuntime]));
      const finished = jobs.map((job) => {
        const native = natives.get(job.agent);
        const done = native?.turnId && native.turnId !== job.before && ['completed', 'failed', 'interrupted'].includes(native.turnStatus);
        return done ? { ...job, status: native.turnStatus, turnId: native.turnId, threadId: native.threadId } : null;
      });
      if (finished.every(Boolean)) return finished;
      await sleep(pollMs);
    }
  };
  const sendJob = async (id, agent, message, before = null) => {
    await steady(() => fleet.command(agent, { id, action: 'message', message }));
    return { id, agent, before };
  };
  const retire = async ({ capture }) => {
    for (const worker of workers) announce(worker, 'retiring');
    onStatus('Fly Workers finished; retiring the owned fleet.');
    await steady(() => fleet.quiesce({ attempt: 'final', timeoutMs: 120_000 }), { cleanup: true }).catch(() => { record({ quiesceUnconfirmed: true }); });
    let captureFailure = false;
    if (capture) {
      for (const worker of workers) {
        const machine = fleet.snapshot().machines[worker.index];
        try {
          onStatus(`Collecting owned output from Worker ${worker.workerId}.`);
          artifacts.push(...await steady(() => collectFlyArtifacts({ target: { kind: 'fly', app: intent.app, machineId: machine?.id, outputRoot: '/data/results' },
            goalId: goal.id, workerId: worker.workerId, dataDir, run: (args, options) => fleet.fly(args, options) }), { cleanup: true }));
          record({ artifactCount: artifacts.length });
        } catch (error) {
          captureFailure = true;
          record({ artifactCaptureIncomplete: [...(intent.artifactCaptureIncomplete ?? []), { workerId: worker.workerId, detail: String(error.message).slice(0, 200) }] });
        }
      }
    }
    await assertAccountCurrent({ operation: 'cleanup' });
    if (captureFailure && deliveredWork) {
      // The volumes hold the only copy. The Machines stop, so nothing else is billed for compute.
      await fleet.stop().catch(() => undefined);
      throw unknown('Completed Worker output is not safely captured. Preserve its exact sandbox.');
    }
    await fleet.stop();
    await fleet.retire();
    const apps = JSON.parse(await fleet.fly(['apps', 'list', '--org', intent.org, '--json']));
    if (!Array.isArray(apps) || apps.some((app) => (app.name ?? app.Name) === intent.app)) throw unknown('The retired Fly app is still listed. Its cleanup is unconfirmed.');
    cleanupConfirmed = true;
    for (const worker of workers) announce(worker, 'retired');
    record({ flyCleanupConfirmed: true });
    if (captureFailure) throw Object.assign(new Error('Owned Fly output capture was incomplete. The fleet was retired; inspect the private capture receipts.'), { outcome: 'failed' });
  };
  let traces = [];
  try {
    if (goal.providerId === 'private-h100') {
      if (typeof reservationId !== 'string' || !/^[\w-]{1,100}$/.test(reservationId)
        || typeof reserveCloud !== 'function' || !(maxUsd === Infinity && goal.unlimited === true || Number.isFinite(maxUsd)) || maxUsd <= 0) {
        throw Object.assign(new Error('Private Fly work needs a durable allowance reservation.'), { outcome: 'not_applied' });
      }
      const cloudAllowance = Number.isFinite(maxUsd) ? maxUsd : Math.ceil((planSwarm({ unlimited: true, workers: workerCap,
        agents: goal.conversationsPerWorker ?? 10, memoryMb: goal.memoryMb ?? 4096, hours: .5 }).estimate.computeUsd + .01) * 100) / 100;
      reservedUsd = cloudAllowance;
      reserveCloud({ id: reservationId, amountUsd: cloudAllowance });
      cloudReserved = true;
      record({ state: 'budget-reserved', reservationId, reservedUsd: cloudAllowance });
    }
    await assertAccountCurrent();
    const bundlePath = path.join(goalDirectory, 'factory-sdk.tgz');
    sdk.packFactorySdk(bundlePath);
    onStatus(`Staffing ${workerCap} isolated Fly Worker Machine${workerCap === 1 ? '' : 's'}; billing remains pending.`);
    for (const worker of workers) announce(worker, 'provisioning');
    accepted = true;
    record({ state: 'provisioning' });
    await fleet.deploy({ runId: intent.app, app: intent.app, org: intent.org, network: intent.network, goal: 'Wait for operator messages; each one is your assignment.',
      machines: workerCap, cpuKind: 'shared', cpus: 2, memoryMb: goal.memoryMb ?? 4096, diskGb: 10, region: 'iad', supervision: 'operator', monitorIntervalMs: 4000, ...program.plan },
    { image, bundlePath, ...(program.key ? { providerKey: program.key } : {}) });
    record({ state: 'waiting-for-workers', machines: fleet.snapshot().machines.length });
    const sessions = workerCap * program.plan.agentsPerMachine;
    const enrolled = Date.now() + enrolTimeoutMs;
    for (;;) {
      stopped(); deadlineLeft();
      let status = null;
      try { status = await fleet.request('/operator/status'); }
      catch { /* The first Machine is still installing its programs. */ }
      if (status?.agents?.length === sessions && status.agents.every((agent) => agent.nativeRuntime?.threadId)) break;
      if (Date.now() >= enrolled) throw unknown('The Fly Workers did not become ready in time.');
      await sleep(pollMs);
    }
    for (const worker of workers) announce(worker, 'ready');
    onStatus('The company is ready; sending each Worker its assignment.');
    record({ state: 'accepted' });
    await assertAccountCurrent();
    // Everyone starts together; the lead gets the others' reports when they have finished.
    const firstRound = [];
    for (const worker of [...workers].reverse()) {
      firstRound.push(await sendJob(`company-${worker.agent}-1`, worker.agent, workerBrief({ task, index: worker.index, workerCap, localChildTarget: program.localChildTarget, profile })));
      announce(worker, 'dispatching');
    }
    for (const member of members) {
      firstRound.push(await sendJob(`company-${member.agent}-1`, member.agent, workerBrief({ task, index: member.member, workerCap, memberOf: member.worker.agent })));
    }
    const settled = await waitForTurns(firstRound, runTimeoutMs);
    traces = textTraces(tracesFile);
    const failedJobs = settled.filter((job) => job.status !== 'completed');
    for (const job of settled) {
      const worker = workers.find((entry) => entry.agent === job.agent);
      if (worker) announce(worker, job.status === 'completed' ? 'completed' : 'failed');
    }
    if (failedJobs.length) {
      const failure = turnFailure(traces, failedJobs[0].agent);
      record({ state: 'run-failed', failureDiagnostic: { agent: failedJobs[0].agent, status: failure.status, providerHttpStatus: failure.providerHttpStatus, code: failure.code } });
      recordConfirmedQuotaHold({ dataDir, model: discovered.config.model, providerId: goal.providerId, goalId: goal.id, workerId: failedJobs[0].agent, failure });
      throw Object.assign(new Error('The isolated Fly team failed. Its Workers were retired; inspect the saved run for the provider error.'), { outcome: 'failed' });
    }
    deliveredWork = true;
    const verifiedSessions = new Map(settled.map((job) => [job.agent, job]));
    let leadTurn = verifiedSessions.get('m0-a0');
    if (workerCap > 1 || members.length) {
      const reports = settled.filter((job) => job.agent !== 'm0-a0').map((job) => `--- ${job.agent} ---\n${String(lastAnswer(traces, job.agent)).slice(0, 12_000)}`).join('\n\n');
      onStatus('Workers reported; the team lead is reconciling their results.');
      announce(workers[0], 'dispatching');
      const [closing] = await waitForTurns([await sendJob('company-m0-a0-2', 'm0-a0',
        `All your other Workers have finished. Their final reports follow. Compare them with your own findings, resolve conflicts, and write the company's final report: what was actually run and checked, which conversations completed, the paths of the files saved under /data/results, and what remains uncertain.\n\n${reports}`, leadTurn.turnId)], 30 * 60_000);
      traces = textTraces(tracesFile);
      announce(workers[0], closing.status === 'completed' ? 'completed' : 'failed');
      if (closing.status !== 'completed') throw Object.assign(new Error('The team lead could not reconcile the Worker reports. Its Workers were retired; inspect the saved run.'), { outcome: 'failed' });
      leadTurn = closing;
    }
    // A Worker's staffing is read from its own trace, or from the sessions FACTORY started for it.
    const localConversations = workers.map((worker) => ({ workerId: worker.workerId, leadConversationId: verifiedSessions.get(worker.agent).threadId,
      children: program.members
        ? members.filter((member) => member.worker === worker).map((member) => ({ id: verifiedSessions.get(member.agent).threadId, status: verifiedSessions.get(member.agent).status }))
        : verifiedLocalConversations(traces, worker.agent, program.localChildTarget, { requireCompleted: goal.workerTopologyVersion === 3 }) }));
    const childCount = teamLimits.concurrency;
    const staffingProof = goal.workerTopologyVersion === 3 ? verifiedTeamStaffing(localConversations, workerCap, childCount) : null;
    record({ state: 'run-completed', localConversations });
    // A lead can end a turn without writing anything. The Workers' own reports are then the result, never an old progress note.
    let text = lastAnswer(traces, 'm0-a0', leadTurn.turnId);
    if (!text) {
      text = settled.map((job) => [job.agent, lastAnswer(traces, job.agent)]).filter(([, answer]) => answer).map(([agent, answer]) => `--- ${agent} ---\n${answer}`).join('\n\n');
      onStatus('The team lead wrote no closing report, so the result holds the reports the Workers wrote.');
    }
    await retire({ capture: true });
    const artifactDir = path.join(dataDir, 'artifacts', goal.id);
    const resultPath = path.join(artifactDir, 'fly-result.txt');
    const bytes = Buffer.from(text, 'utf8');
    try {
      mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
      writeFileSync(resultPath, bytes, { flag: 'wx', mode: 0o600 });
      artifacts.push({ path: resultPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'run-result' });
    } catch { onStatus('The Fly result was received, but its local transcript could not be saved.'); }
    record({ state: 'completed' });
    delivered = { available: true, text, artifacts, usage: usage(traces),
      sandbox: { kind: 'fly', workerId: workers[0].workerId, runId: leadTurn.turnId, retired: true, cleanupConfirmed: true,
        verification: 'factory-fleet-v1', ...(staffingProof ?? {}),
        workerCount: localConversations.length, initialWorkerCount: workers.length,
        teamLeadRuns: workers.map((worker) => verifiedSessions.get(worker.agent).turnId),
        localConversationCount: localConversations.reduce((sum, item) => sum + item.children.length, 0),
        conversationCountVerified: localConversations.length + localConversations.reduce((sum, item) => sum + item.children.length, 0) } };
    try { onCompany({ verifiedWorkers: localConversations.length, verifiedChildConversations: delivered.sandbox.localConversationCount }); }
    catch { /* A status listener cannot invalidate a verified Worker result. */ }
    return delivered;
  } catch (error) {
    const key = program.key;
    if (typeof error?.message === 'string' && key) error.message = error.message.replaceAll(key, '[redacted]');
    if (accepted && !cleanupConfirmed) {
      try {
        // The original outcome stands; retirement only ends the spending.
        traces = textTraces(tracesFile);
        await retire({ capture: deliveredWork });
      } catch (cleanupError) {
        record({ flyCleanupConfirmed: false, cleanupError: String(cleanupError.message).slice(0, 200) });
        for (const worker of workers) announce(worker, 'cleanup-unconfirmed');
      }
    }
    record({ state: error?.name === 'AbortError' ? 'stopped' : error.outcome === 'failed' && cleanupConfirmed ? 'run-failed' : accepted ? 'unknown' : 'failed-before-dispatch',
      flyCleanupConfirmed: cleanupConfirmed, error: String(error.message).slice(0, 500) });
    const held = accepted || cloudReserved ? usage(traces) : undefined;
    if (accepted && !cleanupConfirmed) throw Object.assign(unknown(`${error.message} Fly cleanup is unconfirmed; do not submit replacement work.`), { usage: held });
    if (error?.name === 'AbortError' || error.outcome === 'failed') { if (held) error.usage = held; throw error; }
    if (accepted) throw Object.assign(unknown(`${error.message} The original Fly run outcome must be reconciled before replay.`), { usage: held });
    if (cloudReserved) { const pending = unknown(`${error.message} The private Fly allowance remains pending until cloud billing is reconciled.`); pending.usage = held; throw pending; }
    if (!error.outcome) error.outcome = 'not_applied';
    throw error;
  } finally {
    await fleet.disconnect?.().catch(() => undefined);
  }
}

/** The private Codex login files this computer owns; only short-lived access tokens leave it. */
export function codexAuthFile(env = process.env) {
  return path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'auth.json');
}
