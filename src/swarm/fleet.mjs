import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { Controller } from '@flujo-app/swarm-teams/fleet/controller.mjs';
import { flyProvisioner } from '@flujo-app/swarm-teams/fleet/provisioners.mjs';
import { FlujoClient } from '@flujo-app/swarm-teams/lib/flujo-client.mjs';
import { installTemplate } from '@flujo-app/swarm-teams/install.mjs';
import { BOOT_FLOW } from '@flujo-app/swarm-teams/template/flows.mjs';
import { teamProfile, specialistStaffingBrief } from './team-profile.mjs';
import { cloudSdkEntry, importCloudSdk } from './cloud-sdk.mjs';
import { collectFlyArtifacts } from '../artifacts/fly.mjs';
import { createOwnedRelay, relayFailureCleanupConfirmed } from './relay.mjs';
import { assertNetworkVacant, assertPlannedNetworkMembers, readFlyOrgApps,
  verifyFreshAppPlan } from './fly-network.mjs';

const legacyProfilePath = () => path.join(process.env.SWARM_TEAMS_HOME || path.join(homedir(), '.swarm-teams'), 'config.json');
const profilePath = () => process.env.SEAGULLED_FLEET_PROFILE || legacyProfilePath();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unknown = (message) => Object.assign(new Error(message), { code: 'UNKNOWN', unknown: true });
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
/** The cloud SDK and all Fly CLI children receive only this selected personal account. */
export function isolatedFlyEnvironment(account, sourceEnv = process.env, sourceInstanceDir) {
  if (!validFlyAccount(account)) {
    throw new Error(flyUnavailable);
  }
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) {
    if (typeof sourceEnv[key] === 'string') env[key] = sourceEnv[key];
  }
  env.FLY_CONFIG_DIR = account.flyConfigDir;
  env.FLYCTL_PATH = account.flyctlPath;
  if (sourceInstanceDir !== undefined) {
    if (typeof sourceInstanceDir !== 'string' || !path.isAbsolute(sourceInstanceDir)) {
      throw new Error('A product-private FLUJO instance directory is required.');
    }
    env.FLUJO_LOCAL_INSTANCE_DIR = sourceInstanceDir;
  }
  return env;
}
/** A product goal always bills the provider-verified personal org, never a legacy profile slug. */
export function bindVerifiedFlyOrganization(config, account) {
  if (!validFlyAccount(account)) throw new Error(flyUnavailable);
  return { ...config, provisioner: { ...config.provisioner, org: account.orgSlug } };
}
const productSourceUnavailable = 'A product-owned FLUJO source and compatible installed cloud SDK are required for isolated Workers.';
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
function verifiedSourceBinding(binding, dataDir) {
  if (!binding || typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) return null;
  try {
    const origin = new URL(binding.sourceOrigin);
    if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      || binding.sourceOrigin !== origin.origin) return null;
    for (const key of ['cloudSdkRoot', 'sourceInstanceDir', 'sourceDataRoot', 'sourceAppRoot']) {
      if (typeof binding[key] !== 'string' || !path.isAbsolute(binding[key])) return null;
    }
    const productRoot = realpathSync(path.dirname(path.resolve(dataDir)));
    const sourceInstanceDir = realpathSync(binding.sourceInstanceDir);
    const sourceDataRoot = realpathSync(binding.sourceDataRoot);
    const sourceAppRoot = realpathSync(binding.sourceAppRoot);
    const cloudSdkRoot = realpathSync(binding.cloudSdkRoot);
    const workspaceRoot = path.join(sourceDataRoot, 'workspaces');
    if (!inside(productRoot, sourceInstanceDir) || !inside(productRoot, sourceDataRoot)
      || sourceInstanceDir === workspaceRoot || inside(workspaceRoot, sourceInstanceDir)
      || sourceAppRoot === sourceDataRoot || inside(sourceDataRoot, sourceAppRoot)
      || cloudSdkRoot === sourceDataRoot || inside(sourceDataRoot, cloudSdkRoot)
      || !statSync(sourceInstanceDir).isDirectory() || !statSync(sourceDataRoot).isDirectory()
      || !statSync(sourceAppRoot).isDirectory() || !statSync(cloudSdkRoot).isDirectory()
      || !regularFile(cloudSdkEntry('.', cloudSdkRoot))) return null;
    return { cloudSdkRoot, sourceOrigin: origin.origin, sourceInstanceDir, sourceDataRoot, sourceAppRoot };
  } catch { return null; }
}
/** Backend-only, read-only proof of this product's exact local source and Fly identity. */
export async function boundFleetSource({ dataDir, sourceBinding, flyAccount, signal, deadlineAt } = {}) {
  assertAdmission(signal, deadlineAt);
  const binding = verifiedSourceBinding(sourceBinding, dataDir);
  if (!binding) return { available: false, detail: productSourceUnavailable };
  if (!validFlyAccount(flyAccount)) return { available: false, detail: flyUnavailable };
  try {
    const { ManagedCloud } = await importCloudSdk('.', binding.cloudSdkRoot);
    const env = isolatedFlyEnvironment(flyAccount, process.env, binding.sourceInstanceDir);
    const discoveryFetch = (url, options = {}) => fetch(url, { ...options,
      signal: AbortSignal.any([options.signal, signal,
        deadlineAt === undefined ? undefined : AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]
        .filter(Boolean)) });
    const managed = new ManagedCloud({ env, directory: path.join(dataDir, 'fleet', 'source-proof'),
      fetchImpl: discoveryFetch });
    const source = await managed.source({ source: binding.sourceOrigin });
    assertAdmission(signal, deadlineAt);
    if (source.source !== binding.sourceOrigin || realpathSync(source.dataRoot) !== binding.sourceDataRoot
      || realpathSync(source.appRoot) !== binding.sourceAppRoot) {
      return { available: false, detail: 'The product FLUJO source identity did not match its owned binding.' };
    }
    return { available: true, binding };
  } catch {
    assertAdmission(signal, deadlineAt);
    return { available: false, detail: 'The product FLUJO source could not be verified.' };
  }
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
  const maxWorkers = boundedCount(goal.maxWorkers, strict ? 10 : 5, strict ? 10 : 6, 'maxWorkers');
  // Earlier saved goals allowed ten child agents (eleven total conversations).
  // Preserve that exact legacy capacity only when its derived child count agrees.
  const legacyEleven = !strict && goal.conversationsPerWorker === 11 && goal.agentsPerWorker === 10;
  const selected = goal.conversationsPerWorker === undefined ? undefined
    : legacyEleven ? 11 : boundedCount(goal.conversationsPerWorker, 5, 10, 'conversationsPerWorker');
  const legacy = goal.agentsPerWorker;
  if (legacy !== undefined && (!Number.isInteger(legacy) || legacy < 0 || legacy > (strict ? 9 : 10))) {
    throw new RangeError(`agentsPerWorker must be an integer from 0 to ${strict ? 9 : 10}.`);
  }
  if (selected !== undefined && legacy !== undefined && legacy !== selected - 1) {
    throw new RangeError('conversationsPerWorker and agentsPerWorker disagree.');
  }
  const conversationsPerWorker = selected ?? (legacy === undefined ? strict ? 10 : 5 : legacy + 1);
  return { maxWorkers, conversationsPerWorker, agentsPerWorker: conversationsPerWorker - 1 };
}
export function fleetTopology(goal, { workerCap, relay = false } = {}) {
  const strict = goal?.workerTopologyVersion === 3;
  if (!Number.isInteger(workerCap) || workerCap < 1 || workerCap > (strict ? 10 : 6)) throw new RangeError(`Worker count must be 1 to ${strict ? 10 : 6}.`);
  if (strict) return { initialWorkers: workerCap, limits: { maxWorkers: workerCap,
    maxDepth: relay ? 2 : 1, maxChildren: relay ? Math.max(1, workerCap - 1) : 1, maxActiveRuns: 1 } };
  const version = goal?.workerTopologyVersion === 2 ? 2 : 1;
  const initialWorkers = version === 2 ? workerCap : 1;
  const maxWorkers = version === 2 ? Math.min(12, workerCap * 2) : workerCap;
  return { initialWorkers, limits: { maxWorkers,
    maxDepth: relay ? version === 2 ? 3 : 2 : 1,
    maxChildren: relay ? Math.max(1, workerCap - 1) : 1, maxActiveRuns: 2 } };
}
const legacyWorkerCap = (config) => Number.isInteger(config?.maxWorkers)
  ? Math.min(Math.max(config.maxWorkers, 1), 6) : 3;
export function fleetExecutionLimits({ goal, config, diagnostic = false, native = false } = {}) {
  const capacity = goalCapacity(goal);
  return {
    workerCap: native ? 1 : diagnostic && goal?.maxWorkers === undefined
      ? legacyWorkerCap(config) : capacity.maxWorkers,
    teamLimits: { agentTurns: 6, leadTurns: 12, concurrency: capacity.agentsPerWorker },
  };
}
const STAFF_BRANCHES = Object.freeze([
  { name: 'context-evidence', angle: 'Map the context and gather primary evidence.' },
  { name: 'solution-build', angle: 'Develop and check a concrete solution.' },
  { name: 'independent-verification', angle: 'Independently verify the proposed result and artifacts.' },
  { name: 'adversarial-review', angle: 'Challenge the conclusion with counterexamples and unresolved risks.' },
  { name: 'handoff-synthesis', angle: 'Reconcile the evidence and prepare a bounded handoff.' },
  { name: 'requirements-check', angle: 'Check every user requirement and identify missing acceptance criteria.' },
  { name: 'integration-check', angle: 'Exercise component boundaries and validate the combined result.' },
  { name: 'regression-check', angle: 'Check existing behavior and failure paths for regressions.' },
  { name: 'delivery-check', angle: 'Check deliverable integrity, instructions and reproducibility.' },
]);

/** Admit real controller Worker runs, with one coordinating parent and bounded descendants. */
export function staffOwnedTeam(controller, root, { task, workerCap, localChildTarget = 4,
  onReserved = () => undefined, onStaffed = () => undefined } = {}) {
  if (!Number.isInteger(workerCap) || workerCap < 1 || workerCap > 10) throw new RangeError('Worker count must be 1 to 10.');
  if (!Number.isInteger(localChildTarget) || localChildTarget < 0 || localChildTarget > 10) {
    throw new RangeError('Local child conversation count must be 0 to 10.');
  }
  const localStaffing = localChildTarget
    ? `At the start of this run, call the installed start_subflow_ tool exactly ${localChildTarget} times with distinct concrete tasks. ` +
      'Record the returned child conversation IDs; then steer and wait for those same children. ' +
      'Do not start replacement local subflows or report a capacity gate as actual staffing. '
      + specialistStaffingBrief(localChildTarget)
    : 'This Worker has only its lead conversation; do not start a local subflow. ';
  const leadTask = `${task}\n\n` +
    `You coordinate ${workerCap} owned Worker Machine${workerCap === 1 ? '' : 's'}, including yourself. ` +
    localStaffing +
    'Read fleet_info for the already staffed child run IDs, steer them with fleet_message, wait for their original results, ' +
    'and compare findings on the shared board. Do not redelegate a branch that is already staffed. ' +
    'Report which Worker runs and local agent conversations actually completed.';
  const lead = controller.delegate(root, { name: 'coordinating-worker', task: leadTask, deferRun: true });
  onReserved(lead);
  const leadWorker = controller.registry.worker(lead.workerId);
  const prepared = [{ actor: root, worker: leadWorker, task: leadTask }];
  for (const branch of STAFF_BRANCHES.slice(0, workerCap - 1)) {
    const childTask = `${task}\n\n` +
      `YOUR DISTINCT ANGLE: ${branch.angle} ${localStaffing}` +
      'post findings with evidence to the shared board, and report actual conversation IDs and remaining uncertainty. ' +
      'Your coordinating Worker can send you messages through the owned relay.';
    const child = controller.delegate(leadWorker, { name: branch.name, task: childTask, deferRun: true });
    onReserved(child);
    prepared.push({ actor: leadWorker, worker: controller.registry.worker(child.workerId), task: childTask });
  }
  const runs = new Array(prepared.length);
  // Child run IDs exist before the coordinating lead can inspect fleet_info.
  for (const index of [...prepared.keys()].slice(1).concat(0)) {
    const entry = prepared[index];
    const run = controller.startDelegatedRun(entry.actor, entry.worker, entry.task);
    const accepted = { workerId: entry.worker.id, runId: run.id, state: 'provisioning' };
    runs[index] = accepted; onStaffed(accepted, runs.filter(Boolean));
  }
  return { lead: runs[0], runs };
}
export function verifiedLocalConversations(read, parentConversationId, target, { requireCompleted = false } = {}) {
  const page = read?.body;
  if (read?.status !== 200 || !Array.isArray(page?.items) || !Number.isInteger(page.total)
    || page.hasMore !== false || page.total !== page.items.length) {
    throw unknown('FLUJO did not confirm the original Worker conversation tree.');
  }
  const descendants = page.items;
  const ids = new Set();
  for (const item of descendants) {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id)
      || typeof item.parentConversationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.parentConversationId)
      || ids.has(item.id)) throw unknown('FLUJO returned an invalid Worker conversation tree.');
    ids.add(item.id);
  }
  if (descendants.length !== target || descendants.some((item) => item.parentConversationId !== parentConversationId)) {
    throw Object.assign(new Error(`Worker started ${descendants.length} local conversations; exactly ${target} were requested.`),
      { outcome: 'failed', localConversations: descendants.map((item) => ({
        id: item.id, parentConversationId: item.parentConversationId, status: safeFailureField(item.status) ?? 'unknown',
      })) });
  }
  if (requireCompleted && descendants.some(item => item.status !== 'completed')) {
    throw unknown('A local agent has not completed successfully; agreement from its team lead cannot verify it.');
  }
  return descendants.map(({ id, status }) => ({ id, status: safeFailureField(status) ?? 'unknown' }));
}

/** Count original identities, not capacity or a lead's claim about staffing. */
export function verifiedTeamStaffing(entries, workerCount, childCount) {
  if (!Array.isArray(entries) || entries.length !== workerCount) throw unknown('The original Worker staffing receipt is incomplete.');
  const workers = new Set(), conversations = new Set();
  for (const entry of entries) {
    if (typeof entry.workerId !== 'string' || workers.has(entry.workerId)
      || typeof entry.leadConversationId !== 'string' || !entry.leadConversationId
      || !Array.isArray(entry.children) || entry.children.length !== childCount) throw unknown('The original Worker staffing receipt is invalid.');
    workers.add(entry.workerId);
    for (const id of [entry.leadConversationId, ...entry.children.map(child => child.id)]) {
      if (typeof id !== 'string' || !id || conversations.has(id)) throw unknown('A staffing receipt repeats a conversation identity.');
      conversations.add(id);
    }
    if (entry.children.some(child => child.status !== 'completed')) throw unknown('A staffing receipt contains an unfinished local agent.');
  }
  return { workerCount: workers.size, localConversationCount: workerCount * childCount,
    conversationCountVerified: conversations.size, childCompletionVerified: true };
}
const sourceFingerprint = (origin) => createHash('sha256').update(new URL(origin).origin.toLowerCase()).digest('hex').slice(0, 24);
const holdPath = (dataDir, origin) => path.join(dataDir, 'fleet', `source-admission-${sourceFingerprint(origin)}.json`);
const sourceHold = (dataDir, origin) => dataDir && existsSync(holdPath(dataDir, origin));
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
export function conversationFailure(read) {
  const error = read?.body?.lastError;
  return { readStatus: read?.status,
    conversationStatus: safeFailureField(read?.body?.status),
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599
      ? { providerHttpStatus: error.httpStatus } : {}),
    ...(safeFailureField(error?.code) ? { code: safeFailureField(error.code) } : {}),
    ...(safeFailureField(error?.errorClass) ? { errorClass: safeFailureField(error.errorClass) } : {}),
    ...(safeFailureField(error?.providerType) ? { providerType: safeFailureField(error.providerType) } : {}) };
}
function recordSourceHold(dataDir, origin, workspace, reason) {
  const target = holdPath(dataDir, origin);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (existsSync(target)) return;
  writeFileSync(target, JSON.stringify({ version: 1, sourceFingerprint: sourceFingerprint(origin), workspace,
    reason, observedAt: new Date().toISOString(), state: 'held' }), { flag: 'wx', mode: 0o600 });
}

/** Only a completed read of the original failed conversation may hold an account. */
export function recordConfirmedQuotaHold({ dataDir, model, providerId, goalId, runId, read } = {}) {
  const error = read?.body?.lastError;
  const status = read?.body?.status;
  const quotaCode = error?.httpStatus === 429 && error?.code === 'insufficient_quota';
  const exactNoCredits = [402, 429].includes(error?.httpStatus)
    && typeof error?.message === 'string' && /^no credits remaining[.!]?$/i.test(error.message.trim());
  if (read?.status !== 200 || !['error', 'failed'].includes(status) || !(quotaCode || exactNoCredits)
    || !dataDir || !model?.apiKey || !exactProductBinding(providerId, model)) return false;
  const target = accountHoldPath(dataDir, model);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) {
    try {
      writeFileSync(target, JSON.stringify({ version: 1, state: 'held', accountFingerprint: accountFingerprint(model),
        providerId, classification: 'confirmed_no_credits', source: 'original_fly_conversation',
        goalId, runId, observedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
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

const nativeCodex = (model) => model?.provider === 'codex' && model?.adapter === 'codex-cli'
  && typeof model.name === 'string' && model.name.length > 0 && !model.apiKey;
const PRODUCT_BINDINGS = Object.freeze({
  openai: { provider: 'openai', adapter: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { provider: 'anthropic', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com' },
});
const exactProductBinding = (providerId, model, route) => {
  if (providerId === 'private-h100') {
    try {
      const url = new URL(model?.baseUrl);
      return model.name === 'qwen3.8-27b' && model.provider === 'openai' && model.adapter === 'openai'
        && url.protocol === 'https:' && !url.username && !url.password && !url.port
        && (url.hostname.endsWith('.modal.run') || url.hostname.endsWith('.modal.direct'))
        && /(?:^|[.-])seagulled-qwen-[a-f0-9]{12}(?:[.-]|$)/.test(url.hostname)
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
async function inspectFleet({ dataDir, providerId, fleetRoute, goalId, diagnostic = false,
  flyAccount, sourceBinding, signal, deadlineAt } = {}) {
  assertAdmission(signal, deadlineAt);
  if (!diagnostic && (fleetRoute?.available !== true || fleetRoute.providerId !== providerId
    || typeof providerId !== 'string' || !providerId)) {
    return { available: false, detail: 'The selected provider has no Fly route. Local provider work remains available.' };
  }
  if (!diagnostic && providerId === 'private-h100' && fleetRoute.leaseGoalId !== goalId) {
    return { available: false, detail: 'The private Worker route is not leased to this goal.' };
  }
  if (!diagnostic && (!exactProductBinding(providerId, fleetRoute.model, fleetRoute)
    || typeof fleetRoute.model.name !== 'string' || !fleetRoute.model.name
    || typeof fleetRoute.model.apiKey !== 'string' || !fleetRoute.model.apiKey)) {
    return { available: false, detail: 'The selected provider has no usable Fly model binding.' };
  }
  if (!diagnostic && (modelHold(dataDir, fleetRoute.model) || knownQuotaHold(dataDir, fleetRoute.model))) {
    return { available: false, detail: 'The selected provider account has a saved no-credits hold. Local provider work remains available.' };
  }
  let binding;
  if (!diagnostic) {
    const source = await boundFleetSource({ dataDir, sourceBinding, flyAccount, signal, deadlineAt });
    if (!source.available) return source;
    binding = source.binding;
  }
  let config;
  if (diagnostic) {
    const location = profilePath();
    if (!existsSync(location)) return { available: false, detail: 'No local FLUJO fleet profile was found.' };
    try { config = JSON.parse(readFileSync(location, 'utf8')); }
    catch { return { available: false, detail: 'The local FLUJO fleet profile could not be read.' }; }
    if (typeof config.model === 'string' && typeof config.baseUrl === 'string' && typeof config.token === 'string') {
      try {
        const tooling = JSON.parse(readFileSync(legacyProfilePath(), 'utf8'));
        config = { ...tooling, model: { name: config.model, baseUrl: config.baseUrl,
          apiKey: config.token, contextWindow: config.contextLimit ?? config.maxModelLen } };
      } catch { return { available: false, detail: 'The local Fly tooling profile could not be read.' }; }
    }
  } else {
    config = bindVerifiedFlyOrganization({ model: fleetRoute.model,
      sourceInstanceDir: binding.sourceInstanceDir,
      supervisor: { origin: binding.sourceOrigin },
      provisioner: { kind: 'fly', flujoCloudPath: binding.cloudSdkRoot, source: binding.sourceOrigin } }, flyAccount);
  }
  if (config?.provisioner?.kind !== 'fly' || !config.provisioner.flujoCloudPath
    || !existsSync(config.provisioner.flujoCloudPath) || !config.model?.name
    || (!nativeCodex(config.model) && (!config.model?.baseUrl || !config.model?.apiKey))
    || !config.supervisor?.origin) {
    return { available: false, detail: 'The local FLUJO fleet profile lacks a compatible Fly provisioner and model.' };
  }
  try {
    const origin = new URL(config.supervisor.origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
      return { available: false, detail: 'The FLUJO source must be a local instance.' };
    }
    if (sourceHold(dataDir, config.supervisor.origin)) {
      return { available: false, detail: 'Local FLUJO workspace creation is held after a confirmed failure. Native provider work remains available.' };
    }
    const client = new FlujoClient({ origin: origin.href, workspace: null, signal, deadlineAt });
    await client.api('GET', '/api/workspaces', undefined, { workspace: null, timeoutMs: 3000 }).then((response) => {
      if (response.status !== 200) throw new Error('source unavailable');
    });
  } catch {
    assertAdmission(signal, deadlineAt);
    return { available: false, detail: 'The local FLUJO source is unavailable.' };
  }
  if (nativeCodex(config.model)) {
    if (!diagnostic && fleetRoute.verification !== 'qualified') {
      return { available: false, detail: 'The selected keyless Codex route is not qualified for Fly. Local provider work remains available.' };
    }
    return { available: true, provider: 'codex-subscription-candidate',
      detail: 'A keyless Codex model is configured. The isolated boot flow must confirm this login before any Fly worker is created; cloud execution is not yet qualified.',
      ...(!diagnostic ? { providerId } : {}), config };
  }
  const original = await modelProbe(config.model, { signal, deadlineAt });
  if (original.available) {
    return { available: true, provider: 'configured-model',
      modelIdentityVerified: true,
      detail: 'Local FLUJO and the selected provider model catalog are configured; live Fly execution has not been verified.',
      ...(!diagnostic ? { providerId } : {}), config };
  }
  if (!diagnostic) return { available: false,
    detail: `The selected provider model endpoint is unavailable (${original.detail}); local provider work remains available.` };
  const fallbackKey = process.env.OPENAI_API_KEY;
  if (fallbackKey) {
    const fallback = { name: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', apiKey: fallbackKey,
      contextWindow: 8192, provider: 'openai', adapter: 'openai' };
    if (modelHold(dataDir, fallback)) {
      return { available: false, detail: 'The OpenAI API model rejected a real execution because this account has no credits. Native provider work remains available.' };
    }
    if ((await modelProbe(fallback)).available) {
      return { available: true, provider: 'openai-api',
        detail: 'The saved model is unavailable; an existing OpenAI API key can run a bounded owned Fly Worker tree. Cloud and model billing remain pending.', config: { ...config, model: fallback } };
    }
  }
  return { available: false, detail: `The configured FLUJO model endpoint is unavailable (${original.detail}); no working API fallback was found.` };
}

export async function fleetStatus({ dataDir, providerId, fleetRoute, goalId, flyAccount, sourceBinding,
  signal, deadlineAt } = {}) {
  const { config, ...publicState } = await inspectFleet({ dataDir, providerId, fleetRoute, goalId,
    flyAccount, sourceBinding, signal, deadlineAt });
  return publicState;
}

/** Explicit legacy-profile diagnostic; never used by a product goal. */
export async function fleetDiagnosticStatus({ dataDir } = {}) {
  const { config, ...publicState } = await inspectFleet({ dataDir, diagnostic: true });
  return publicState;
}

/** One owned Fly leaf, with no existing fleet writer or Machine adoption. */
export async function runFleetLeaf({ goal, task, dataDir, signal, maxUsd, fleetRoute,
  diagnostic = false, reservationId, reserveCloud, flyAccount, sourceBinding,
  assertFlyAccountCurrent,
  onStatus = () => undefined, onCompany = () => undefined }) {
  if (!goal || typeof goal.id !== 'string' || !/^[\w-]{1,100}$/.test(goal.id)) throw new Error('A safe goal id is required for isolated fleet work.');
  goalCapacity(goal);
  const fleetDeadlineAt = Date.now() + 30 * 60_000;
  assertAdmission(signal, fleetDeadlineAt);
  if (!diagnostic && !validFlyAccount(flyAccount)) return { available: false, detail: flyUnavailable };
  const discovered = await inspectFleet({ dataDir, providerId: goal.providerId, fleetRoute, goalId: goal.id,
    diagnostic, flyAccount, sourceBinding, signal, deadlineAt: fleetDeadlineAt });
  assertAdmission(signal, fleetDeadlineAt);
  if (!discovered.available) return { available: false, detail: discovered.detail };
  const config = discovered.config;
  const bootWorkspace = `seagulled-${goal.id.slice(-12)}-boot`;
  const boot = new FlujoClient({ origin: config.supervisor.origin, workspace: bootWorkspace,
    signal, deadlineAt: fleetDeadlineAt });
  const bootCleanup = new FlujoClient({ origin: config.supervisor.origin, workspace: bootWorkspace });
  const registryPath = path.join(dataDir, 'fleet', goal.id, 'registry.json');
  const intentPath = path.join(path.dirname(registryPath), 'intent.json');
  const relayPath = path.join(path.dirname(registryPath), 'relay.json');
  const cloudDirectory = path.join(path.dirname(registryPath), 'cloud');
  if (existsSync(registryPath) || existsSync(intentPath) || existsSync(relayPath) || existsSync(cloudDirectory)) {
    throw unknown('A prior Fly fleet intent exists for this goal. Reconcile its original worker before more provisioning.');
  }
  assertAdmission(signal, fleetDeadlineAt);
  if ((await boot.workspaces()).includes(bootWorkspace)) throw unknown('The isolated FLUJO boot workspace already exists. Reconcile it before cloning.');
  assertAdmission(signal, fleetDeadlineAt);
  mkdirSync(path.dirname(intentPath), { recursive: true, mode: 0o700 });
  let intent = { version: 1, goalId: goal.id, bootWorkspace,
    network: `seagulled-g-${randomBytes(16).toString('hex')}`,
    org: diagnostic ? config.provisioner.org : flyAccount.orgSlug,
    accountRef: diagnostic ? null : flyAccount.accountRef,
    apps: {}, state: 'preparing', createdAt: new Date().toISOString() };
  writeFileSync(intentPath, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
  const record = (patch) => {
    intent = { ...intent, ...patch, updatedAt: new Date().toISOString() };
    const temporary = `${intentPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(intent), { mode: 0o600 });
    renameSync(temporary, intentPath);
  };
  const planApp = ({ app, org, network, accountRef, kind }) => {
    assertAdmission(signal, fleetDeadlineAt);
    if (!/^[a-z][a-z0-9-]{2,62}$/.test(app ?? '')
      || !['relay', 'worker'].includes(kind) || org !== intent.org || network !== intent.network
      || accountRef !== intent.accountRef
      || intent.apps[app]) throw unknown('The goal Fly app plan changed before creation.');
    record({ apps: { ...intent.apps, [app]: { kind, state: 'planned' } } });
  };
  const confirmApp = ({ app, appId, ownerMarker, kind }) => {
    const prior = intent.apps[app];
    if (!prior || prior.kind !== kind || prior.state !== 'planned'
      || typeof appId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(appId)
      || typeof ownerMarker !== 'string'
      || !/^(SEAGULLED_RELAY_OWNER|FLUJO_CLOUD_OWNER)_[A-F0-9]{16,64}$/.test(ownerMarker)) {
      throw unknown('The goal Fly app confirmation does not match its private plan.');
    }
    record({ apps: { ...intent.apps, [app]: { kind, state: 'confirmed', appId, ownerMarker } } });
  };
  const retireApp = (app) => {
    const prior = intent.apps[app];
    if (!prior || !['planned', 'confirmed'].includes(prior.state)) {
      throw unknown('The goal Fly app retirement does not match its private plan.');
    }
    record({ apps: { ...intent.apps, [app]: { ...prior, state: 'retired' } } });
  };
  const assertAccountCurrent = async ({ operation = 'dispatch' } = {}) => {
    if (diagnostic) return;
    return assertFleetAccountCurrent({ lease: flyAccount, intent,
      assertCurrent: assertFlyAccountCurrent, signal, deadlineAt: fleetDeadlineAt, operation });
  };
  let controller;
  let cloudManaged;
  let relay;
  let child;
  let staffed = [];
  let bootCreated = false;
  let bootRunUnknown = false;
  let bootCleanupConfirmed = false;
  let remoteAccepted = false;
  let cloudReserved = false;
  let cleanupConfirmed = false;
  let relayCleanupConfirmed = true;
  let result;
  let artifacts = [];
  const localConversations = [];
  const localConversationErrors = [];
  const artifactErrors = [];
  let delivered;
  let workspaceAbsent = false;
  try {
    onStatus('Preparing an isolated FLUJO boot workspace.');
    bootCreated = true; // A partial install is still our workspace and needs cleanup.
    await installTemplate(boot, { model: config.model, bootOnly: true, browser: false });
    record({ state: 'boot-ready' });
    assertAdmission(signal, fleetDeadlineAt);
    if (nativeCodex(config.model)) {
      onStatus('Checking the keyless Codex model in the isolated local boot flow.');
      const admission = await boot.runFlow({ flowName: 'swarm_boot', prompt: 'Reply with the single word READY.', timeoutMs: 90_000 });
      record({ state: admission.status === 'completed' && admission.output.trim() === 'READY' ? 'model-ready' : 'model-refused',
        bootConversationId: admission.conversationId,
        modelCallStatus: admission.status });
      if (admission.status !== 'completed' || admission.output.trim() !== 'READY') {
        bootRunUnknown = admission.status === 'unknown';
        throw Object.assign(new Error('The local Codex subscription boot flow did not return READY. No Fly worker was created.'),
          { outcome: admission.status === 'unknown' ? 'unknown' : 'failed',
            usage: { inputTokens: 0, outputTokens: 0, costUsd: null, costKind: 'subscription', billingPending: false } });
      }
    }
    assertAdmission(signal, fleetDeadlineAt);
    if (!validFlyAccount(flyAccount)) {
      throw Object.assign(new Error(flyUnavailable), { outcome: 'not_applied' });
    }
    const flyEnv = isolatedFlyEnvironment(flyAccount, process.env,
      diagnostic ? undefined : config.sourceInstanceDir);
    mkdirSync(cloudDirectory, { recursive: true, mode: 0o700 });
    const { ManagedCloud } = await importCloudSdk('.', config.provisioner.flujoCloudPath);
    if (ManagedCloud.privateNetworkContractVersion !== 1
      || typeof ManagedCloud.prototype.openOwnedProxy !== 'function'
      || typeof ManagedCloud.prototype.credential !== 'function'
      || typeof ManagedCloud.prototype.preflight !== 'function') {
      throw Object.assign(new Error('The pinned cloud SDK has no verified private network and owned proxy contract.'),
        { outcome: 'not_applied' });
    }
    await assertAccountCurrent();
    cloudManaged = new ManagedCloud({ env: flyEnv, directory: cloudDirectory });
    const workerSource = config.provisioner.source ?? config.supervisor.origin;
    const workerOrg = intent.org;
    const workerRegion = config.provisioner.region ?? 'iad';
    if (workerSource !== config.supervisor.origin) {
      throw Object.assign(new Error('The Worker source does not match the isolated boot workspace.'),
        { outcome: 'not_applied' });
    }
    const workerPreflight = await cloudManaged.preflight({ profile: 'private-workspace',
      source: workerSource, workspace: bootWorkspace, org: workerOrg,
      region: workerRegion, flowIds: [BOOT_FLOW] });
    if (workerPreflight?.readyToDeploy !== true
      || workerPreflight.profile !== 'private-workspace' || workerPreflight.captureScope !== 'workspace'
      || workerPreflight.source !== workerSource || workerPreflight.workspace !== bootWorkspace
      || workerPreflight.org !== workerOrg || workerPreflight.region !== workerRegion
      || workerPreflight.image?.mode !== 'official' || workerPreflight.image.compatibility !== 'verified'
      || workerPreflight.flows?.length !== 1 || workerPreflight.flows[0].name !== BOOT_FLOW) {
      throw Object.assign(new Error('The pinned cloud SDK did not confirm a private-workspace Worker source and image.'),
        { outcome: 'not_applied' });
    }
    assertAdmission(signal, fleetDeadlineAt);
    const { createFlyRunner } = await importCloudSdk('./process', config.provisioner.flujoCloudPath);
    const selectedFly = createFlyRunner({ env: flyEnv, binary: flyAccount.flyctlPath });
    const flyToken = (await selectedFly.run(['auth', 'token'])).trim();
    const org = await cloudManaged.organization(diagnostic ? config.provisioner.org : flyAccount.orgSlug);
    if (!flyToken || org !== intent.org || flyAccount.accountRef !== intent.accountRef) {
      throw unknown('The selected Fly account or goal organization changed.');
    }
    assertNetworkVacant(await readFlyOrgApps({ org, token: flyToken, signal,
      deadlineAt: fleetDeadlineAt }), intent.network);
    const verifyFreshApp = async ({ app, kind, org: plannedOrg, network, accountRef }) => {
      await verifyFreshAppPlan({ app, kind, org: plannedOrg, network, accountRef,
        expectedOrg: org, expectedNetwork: intent.network, expectedAccountRef: intent.accountRef,
        getPlans: () => intent.apps, token: flyToken, assertCurrent: assertAccountCurrent,
        signal, deadlineAt: fleetDeadlineAt });
    };
    const verifyNetwork = async ({ allowPending = true, operation = 'dispatch' } = {}) => {
      try {
        await assertAccountCurrent({ operation });
        return assertPlannedNetworkMembers(await readFlyOrgApps({ org, token: flyToken,
          ...(operation === 'dispatch' ? { signal, deadlineAt: fleetDeadlineAt } : {}) }),
          intent.network, intent.apps, { allowPending });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw Object.assign(error, { code: error.code === 'NETWORK_PENDING'
          ? 'NETWORK_PENDING' : 'NETWORK_MEMBERSHIP' });
      }
    };
    const multiWorker = !nativeCodex(config.model);
    const { workerCap, teamLimits } = fleetExecutionLimits({ goal, config, diagnostic, native: !multiWorker });
    if (!diagnostic && goal.providerId === 'private-h100') {
      if (typeof reservationId !== 'string' || !/^[\w-]{1,100}$/.test(reservationId)
        || typeof reserveCloud !== 'function' || !Number.isFinite(maxUsd) || maxUsd <= 0) {
        throw Object.assign(new Error('Private Fly work needs a durable allowance reservation.'), { outcome: 'not_applied' });
      }
      reserveCloud({ id: reservationId, amountUsd: maxUsd });
      cloudReserved = true;
      record({ state: 'budget-reserved', reservationId, reservedUsd: maxUsd });
    }
    if (multiWorker) {
      assertAdmission(signal, fleetDeadlineAt);
      if (workerCap > 1) {
        onStatus('Creating an owned relay for the bounded Fly Worker tree.');
        relayCleanupConfirmed = false;
        try {
          relay = await createOwnedRelay({ journalPath: relayPath, flujoCloudPath: config.provisioner.flujoCloudPath,
            org, network: intent.network, accountRef: intent.accountRef,
            region: config.provisioner.region ?? 'iad',
            flyEnv, flyctlPath: flyAccount.flyctlPath, verifyFreshApp, onPlannedApp: planApp,
            verifyNetwork });
        } catch (error) {
          // The relay factory journals before the first Fly mutation. A failed
          // creation is safe to dismiss only when its journal confirms no app
          // remains; an ambiguous app must retain its exact intent.
          let relayState;
          try { relayState = JSON.parse(readFileSync(relayPath, 'utf8')); } catch { /* Keep the hold. */ }
          relayCleanupConfirmed = relayFailureCleanupConfirmed(error, relayState,
            existsSync(relayPath), relayPath);
          if (relayState?.state === 'retired' && intent.apps[relayState.app]?.state === 'planned') {
            retireApp(relayState.app);
          }
          if (!relayCleanupConfirmed) error.outcome = 'unknown';
          throw error;
        }
        const relayState = JSON.parse(readFileSync(relayPath, 'utf8'));
        if (relayState.app !== relay.app || relayState.appId !== relay.appId
          || relayState.network !== intent.network || relayState.ownershipConfirmed !== true) {
          throw unknown('The owned relay app receipt does not match the goal network intent.');
        }
        confirmApp({ app: relay.app, appId: relay.appId,
          ownerMarker: `SEAGULLED_RELAY_OWNER_${relayState.owner.toUpperCase()}`, kind: 'relay' });
        await verifyNetwork();
        record({ state: 'relay-ready', relayApp: relay.app, relayMachineId: relay.machineId });
      }
    }
    assertAdmission(signal, fleetDeadlineAt);
    const topology = fleetTopology(goal, { workerCap, relay: Boolean(relay) });
    const provisioner = await flyProvisioner({ ...config.provisioner, templateWorkspace: bootWorkspace,
      source: workerSource,
      fleetReachable: Boolean(relay), concurrency: workerCap,
      initialWorkers: topology.initialWorkers,
      teamLimits, specialists: teamProfile(goal), flyEnv, cloudDirectory, network: intent.network,
      accountRef: intent.accountRef,
      verifyFreshApp, onPlannedApp: planApp, onConfirmedApp: confirmApp, onRetiredApp: retireApp,
      verifyNetwork });
    const observeWorkerConversations = async (worker, { operation = 'dispatch' } = {}) => {
      if (localConversations.some((entry) => entry.workerId === worker.id)) return;
      const runs = Object.values(controller.registry.state.runs).filter((run) => run.workerId === worker.id);
      if (runs.length !== 1 || runs[0].state !== 'completed') {
        throw unknown(`Worker ${worker.id} has no single completed original conversation to verify.`);
      }
      let connection;
      try {
        connection = await controller.connect(worker.target, { operation });
        const observed = verifiedLocalConversations(await connection.client.descendants(runs[0].conversationId),
          runs[0].conversationId, teamLimits.concurrency, { requireCompleted: goal.workerTopologyVersion === 3 });
        localConversations.push({ workerId: worker.id, leadConversationId: runs[0].conversationId,
          children: observed });
        record({ localConversations });
      } catch (error) {
        if (error.localConversations) record({ localConversationMismatch: {
          workerId: worker.id, children: error.localConversations,
        } });
        throw error;
      } finally { await connection?.close().catch(() => undefined); }
    };
    controller = new Controller({ registryPath, operatorToken: randomBytes(32).toString('base64url'),
      publicUrl: 'http://127.0.0.1:1', remoteUrl: relay?.remoteUrl,
      provisioner, log: () => undefined, runTimeoutMs: 20 * 60_000, deadlineAt: fleetDeadlineAt,
      maxRunsPerWorker: [2, 3].includes(goal.workerTopologyVersion) ? 1 : undefined,
      specialists: teamProfile(goal),
      beforeRetire: async ({ worker, target }) => {
        if (target.kind !== 'fly') return;
        await verifyNetwork({ operation: 'cleanup' });
        if ([2, 3].includes(goal.workerTopologyVersion) && Object.values(controller.registry.state.runs)
          .some((run) => run.workerId === worker.id && run.state === 'completed')) {
          try { await observeWorkerConversations(worker, { operation: 'cleanup' }); }
          catch (error) {
            localConversationErrors.push({ workerId: worker.id, detail: String(error.message).slice(0, 200) });
            record({ localConversationErrors });
          }
        }
        try {
          onStatus(`Collecting owned output from Worker ${worker.name}.`);
          const collected = await collectFlyArtifacts({ target, goalId: goal.id, workerId: worker.id,
            dataDir, flujoCloudPath: config.provisioner.flujoCloudPath, managed: cloudManaged });
          artifacts.push(...collected);
          record({ artifactCount: artifacts.length });
        } catch (error) {
          artifactErrors.push({ workerId: worker.id, detail: String(error.message).slice(0, 200) });
          record({ artifactCaptureIncomplete: artifactErrors });
          const deliveredRun = Object.values(controller.registry.state.runs).some((run) => run.workerId === worker.id
            && run.state === 'completed');
          if (deliveredRun) throw new Error('Completed Worker output is not safely captured. Preserve its exact sandbox.');
        }
      } });
    const address = await controller.listen(0, '127.0.0.1');
    controller.publicUrl = `http://127.0.0.1:${address.port}`;
    assertAdmission(signal, fleetDeadlineAt);
    await relay?.start(controller.publicUrl);
    assertAdmission(signal, fleetDeadlineAt);
    const fleetGoal = controller.registry.createGoal({ id: goal.id, text: goal.text, limits: topology.limits,
      ...(goal.workerTopologyVersion === 3 ? { maxTotalWorkers: workerCap } : {}) });
    fleetGoal.teamLimits = teamLimits; controller.registry.save();
    const root = controller.registry.reserve({ goalId: fleetGoal.id, role: 'supervisor', name: 'Todd' }).worker;
    controller.registry.enroll(root.id, { kind: 'external', origin: config.supervisor.origin, workspace: bootWorkspace });
    onStatus(`Staffing ${topology.initialWorkers} isolated Fly Worker Machine${topology.initialWorkers === 1 ? '' : 's'}; billing remains pending.`);
    record({ state: 'provisioning' });
    staffOwnedTeam(controller, root, { task: `${task}\n\nSave final deliverable files under `
      + `/data/flujo/workspaces/${bootWorkspace}/seagulled-output in your own Worker workspace. `
      + 'Report paths relative to seagulled-output. Each child Worker must produce its own files.',
    workerCap: topology.initialWorkers, localChildTarget: teamLimits.concurrency, onReserved: (worker) => {
      child ??= worker;
      remoteAccepted = true;
      record({ state: 'provisioning', workerId: child.workerId });
    }, onStaffed: (run, runs) => {
      if (child?.workerId === run.workerId) child = run;
      staffed = [...runs]; remoteAccepted = true;
      record({ state: 'accepted', workerId: child.workerId, runId: child.runId,
        staffedRuns: staffed.map((item) => ({ workerId: item.workerId, runId: item.runId })) });
    } });
    const settled = [];
    for (const staffedRun of staffed) {
      while (true) {
        if (signal?.aborted) throw unknown('Fly work was interrupted. The original runs and Workers need reconciliation.');
        if (Date.now() >= fleetDeadlineAt) throw unknown('The Fly fleet reached its 30-minute deadline. Preserve its original runs for reconciliation.');
        const current = await controller.waitRun('operator', { runId: staffedRun.runId, timeoutMs: 10_000 });
        if (current.state !== 'running') { settled.push(current); break; }
        await sleep(0);
      }
    }
    result = settled[0];
    const failed = settled.find((entry) => entry.state !== 'completed');
    if (failed) {
      let failureDiagnostic = { readStatus: null, conversationStatus: failed.state };
      let failureRead;
      let connection;
      try {
        const worker = controller.registry.worker(failed.workerId);
        connection = await controller.connect(worker.target);
        const run = controller.registry.run(failed.runId);
        failureRead = await connection.client.conversation(run.conversationId);
        failureDiagnostic = conversationFailure(failureRead);
      } catch { /* Preserve a bounded unavailable diagnostic; never replay the run. */ }
      finally { await connection?.close().catch(() => undefined); }
      record({ failureDiagnostic, failedRunId: failed.runId });
      if (!diagnostic && failureRead) recordConfirmedQuotaHold({ dataDir, model: config.model,
        providerId: goal.providerId, goalId: goal.id, runId: failed.runId, read: failureRead });
      throw unknown(`Fly run ${failed.runId} ended as ${failed.state}. Its original record is retained.`);
    }
    const unfinished = Object.values(controller.registry.state.runs).filter((run) => run.goalId === goal.id
      && run.id !== child.runId && ['running', 'unknown'].includes(run.state));
    if (unfinished.length) throw unknown('A descendant Fly run has not reached a confirmed terminal state. Preserve the original tree for reconciliation.');
    for (const staffedRun of staffed) {
      await observeWorkerConversations(controller.registry.worker(staffedRun.workerId));
    }
    if (goal.workerTopologyVersion === 3) verifiedTeamStaffing(localConversations, workerCap, teamLimits.concurrency);
    record({ state: 'run-completed' });
    const artifactDir = path.join(dataDir, 'artifacts', goal.id);
    const resultPath = path.join(artifactDir, 'fly-result.txt');
    const bytes = Buffer.from(result.result ?? '', 'utf8');
    try {
      mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
      writeFileSync(resultPath, bytes, { flag: 'wx', mode: 0o600 });
      artifacts.push({ path: resultPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'run-result' });
    } catch { onStatus('The Fly result was received, but its local transcript could not be saved.'); }
    onStatus('Fly Worker finished; retiring the owned sandbox.');
    const retirement = await controller.retire('operator', { workerId: child.workerId });
    if (retirement.cleanupUnconfirmed?.length) throw unknown('Fly Worker cleanup is unconfirmed. Its original record blocks further provisioning.');
    cleanupConfirmed = true;
    if ([2, 3].includes(goal.workerTopologyVersion) && (localConversationErrors.length || Object.values(controller.registry.state.workers)
      .filter((worker) => worker.depth > 0).some((worker) =>
        !localConversations.some((entry) => entry.workerId === worker.id)))) {
      throw unknown('A spawned Worker lacks its requested conversation receipt. Preserve the private tree for reconciliation.');
    }
    if (artifactErrors.length) throw Object.assign(new Error('Owned Fly output capture was incomplete. The worker tree was retired; inspect the private capture receipts.'),
      { outcome: 'failed' });
    controller.registry.finishGoal(goal.id, result.result);
    record({ state: 'fly-retired', flyCleanupConfirmed: true });
    delivered = { available: true, text: result.result, artifacts, usage: { inputTokens: 0, outputTokens: 0, costUsd: null, costKind: 'unknown',
      reservedUsd: maxUsd, billingPending: true, ...(cloudReserved ? { reservationId } : {}) },
      sandbox: { kind: 'fly', workerId: child.workerId, runId: child.runId, retired: true, cleanupConfirmed: true,
        verification: goal.workerTopologyVersion === 3 ? 'original-worker-hierarchy-v2' : 'original-worker-hierarchy-v1', relayUsed: Boolean(relay),
        ...(goal.workerTopologyVersion === 3 ? verifiedTeamStaffing(localConversations, workerCap, teamLimits.concurrency) : {}),
        workerCount: localConversations.length, initialWorkerCount: staffed.length,
        teamLeadRuns: staffed.map((item) => item.runId),
        localConversationCount: localConversations.reduce((sum, item) => sum + item.children.length, 0),
        conversationCountVerified: localConversations.length + localConversations.reduce((sum, item) => sum + item.children.length, 0) } };
    if (!diagnostic && [2, 3].includes(goal.workerTopologyVersion)) {
      try { onCompany({ verifiedWorkers: localConversations.length,
        verifiedChildConversations: delivered.sandbox.localConversationCount }); }
      catch { /* A status listener cannot invalidate a verified Worker result. */ }
    }
    return delivered;
  } catch (error) {
    if (typeof error?.message === 'string' && config.model.apiKey) {
      error.message = error.message.replaceAll(config.model.apiKey, '[redacted]');
    }
    const usage = remoteAccepted || !relayCleanupConfirmed || cloudReserved ? { inputTokens: 0, outputTokens: 0, costUsd: null, costKind: 'unknown',
      reservedUsd: maxUsd, billingPending: true, ...(cloudReserved ? { reservationId } : {}) } : undefined;
    if (remoteAccepted && child && controller && !cleanupConfirmed) {
      try {
        const retirement = await controller.retire('operator', { workerId: child.workerId });
        cleanupConfirmed = !retirement.cleanupUnconfirmed?.length;
      } catch { /* Preserve the original registry and uncertain cleanup. */ }
    }
    if (!remoteAccepted && /^POST \/api\/workspaces failed \(HTTP 500\)/.test(String(error.message))) {
      try {
        workspaceAbsent = !(await bootCleanup.workspaces()).includes(bootWorkspace);
      } catch { workspaceAbsent = false; }
      if (workspaceAbsent) {
        bootCreated = false;
        bootCleanupConfirmed = true; // GET confirmed no workspace remains; setup may have rolled back a partial directory.
        recordSourceHold(dataDir, config.supervisor.origin, bootWorkspace, 'Workspace creation returned HTTP 500; exact-name readback found no workspace.');
      }
    }
    record({ state: workspaceAbsent ? 'preflight-not-applied'
      : remoteAccepted ? error.outcome === 'failed' && cleanupConfirmed ? 'completed-but-unverified'
        : result?.state === 'failed' && cleanupConfirmed ? 'run-failed' : 'unknown'
        : !relayCleanupConfirmed ? 'relay-cleanup-unknown' : bootRunUnknown ? 'boot-run-unknown' : 'failed-before-dispatch',
      flyCleanupConfirmed: cleanupConfirmed,
      error: String(error.message).slice(0, 500) });
    if (workspaceAbsent) return { available: false, detail: 'Local FLUJO could not create an isolated workspace. Native provider work remains available.' };
    if (remoteAccepted && !cleanupConfirmed) throw Object.assign(unknown(`${error.message} Fly cleanup is unconfirmed; do not submit replacement work.`), { usage });
    if (remoteAccepted && result?.state === 'failed') {
      throw Object.assign(new Error('The isolated Fly team failed. Its worker was retired; inspect the saved run for the provider error.'), { outcome: 'failed', usage });
    }
    if (remoteAccepted && error.outcome === 'failed' && cleanupConfirmed) throw Object.assign(error, { usage });
    if (remoteAccepted) throw Object.assign(unknown(`${error.message} The original Fly run outcome must be reconciled before replay.`), { usage });
    if (cloudReserved) error = unknown(`${error.message} The private Fly allowance remains pending until cloud billing is reconciled.`);
    if (!error.outcome) error.outcome = 'not_applied';
    if (usage) error.usage = usage;
    throw error;
  } finally {
    await controller?.close().catch(() => undefined);
    if (relay) {
      if (remoteAccepted && !cleanupConfirmed) {
        await relay.close().catch(() => undefined);
        relayCleanupConfirmed = false; // Keep the exact relay app journal for held Worker reconciliation.
      } else {
        try {
          relayCleanupConfirmed = await relay.retire();
          if (relayCleanupConfirmed) { retireApp(relay.app); await verifyNetwork({ operation: 'cleanup' }); }
        }
        catch { relayCleanupConfirmed = false; }
      }
    }
    // The boot workspace is ours, but retain it if remote cleanup is uncertain.
    if (bootCreated && !bootRunUnknown && (!remoteAccepted || cleanupConfirmed)) {
      for (let attempt = 0; attempt < 3 && !bootCleanupConfirmed; attempt++) {
        try { await bootCleanup.deleteWorkspace(bootWorkspace); bootCleanupConfirmed = true; }
        catch { if (attempt < 2) await sleep(1000); }
      }
    }
    record({ bootCleanupConfirmed, relayCleanupConfirmed,
      ...(delivered ? { state: bootCleanupConfirmed && relayCleanupConfirmed ? 'completed' : 'cleanup-unknown' } : {}) });
    if (!relayCleanupConfirmed && !remoteAccepted) {
      throw Object.assign(unknown('Owned relay cleanup is unconfirmed; inspect its exact private intent before another cloud attempt.'),
        { outcome: 'unknown', usage: { inputTokens: 0, outputTokens: 0, costUsd: null, costKind: 'unknown',
          reservedUsd: maxUsd, billingPending: true } });
    }
    if (delivered) {
      delivered.sandbox.bootCleanupConfirmed = bootCleanupConfirmed;
      delivered.sandbox.relayCleanupConfirmed = relayCleanupConfirmed;
      if (!bootCleanupConfirmed || !relayCleanupConfirmed) {
        throw Object.assign(unknown('Owned boot or relay cleanup is unconfirmed; inspect the private intent before any new cloud work.'),
          { usage: delivered.usage });
      }
    }
  }
}
