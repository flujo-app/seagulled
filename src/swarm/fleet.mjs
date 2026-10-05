import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Controller } from '../../upstream/swarm-teams/fleet/controller.mjs';
import { flyProvisioner } from '../../upstream/swarm-teams/fleet/provisioners.mjs';
import { FlujoClient } from '../../upstream/swarm-teams/lib/flujo-client.mjs';
import { installTemplate } from '../../upstream/swarm-teams/install.mjs';

const legacyProfilePath = () => path.join(process.env.SWARM_TEAMS_HOME || path.join(homedir(), '.swarm-teams'), 'config.json');
const profilePath = () => process.env.SEAGULLED_FLEET_PROFILE || legacyProfilePath();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unknown = (message) => Object.assign(new Error(message), { code: 'UNKNOWN', unknown: true });

async function modelProbe(model) {
  try {
    const base = model.baseUrl.endsWith('/') ? model.baseUrl : `${model.baseUrl}/`;
    const response = await fetch(new URL('models', base), {
      method: 'GET', headers: { Authorization: `Bearer ${model.apiKey}` },
      signal: AbortSignal.timeout(7000), redirect: 'error',
    });
    if (!response.ok) return { available: false, detail: `HTTP ${response.status}` };
    const catalogue = await response.json().catch(() => null);
    if (Array.isArray(catalogue?.data) && !catalogue.data.some((entry) => entry?.id === model.name)) {
      return { available: false, detail: 'model absent from catalog' };
    }
    return { available: true };
  } catch { return { available: false, detail: 'endpoint did not respond' }; }
}

/** Read-only discovery. No existing controller, registry, relay or worker is adopted. */
async function inspectFleet() {
  const location = profilePath();
  if (!existsSync(location)) return { available: false, detail: 'No local FLUJO fleet profile was found.' };
  let config;
  try { config = JSON.parse(readFileSync(location, 'utf8')); }
  catch { return { available: false, detail: 'The local FLUJO fleet profile could not be read.' }; }
  if (typeof config.model === 'string' && typeof config.baseUrl === 'string' && typeof config.token === 'string') {
    // A private direct model profile may replace only the model, in memory.
    // Its owner retains the endpoint; the old fleet profile supplies local tooling metadata only.
    try {
      const tooling = JSON.parse(readFileSync(legacyProfilePath(), 'utf8'));
      config = { ...tooling, model: { name: config.model, baseUrl: config.baseUrl,
        apiKey: config.token, contextWindow: config.contextLimit ?? config.maxModelLen } };
    } catch { return { available: false, detail: 'The local Fly tooling profile could not be read.' }; }
  }
  if (config?.provisioner?.kind !== 'fly' || !config.provisioner.flujoCloudPath
    || !existsSync(config.provisioner.flujoCloudPath) || !config.model?.name || !config.model?.baseUrl || !config.model?.apiKey
    || !config.supervisor?.origin) {
    return { available: false, detail: 'The local FLUJO fleet profile lacks a compatible Fly provisioner and model.' };
  }
  try {
    const origin = new URL(config.supervisor.origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
      return { available: false, detail: 'The FLUJO source must be a local instance.' };
    }
    const client = new FlujoClient({ origin: origin.href, workspace: null });
    await client.api('GET', '/api/workspaces', undefined, { workspace: null, timeoutMs: 3000 }).then((response) => {
      if (response.status !== 200) throw new Error('source unavailable');
    });
  } catch { return { available: false, detail: 'The local FLUJO source is unavailable.' }; }
  const original = await modelProbe(config.model);
  if (original.available) {
    return { available: true, provider: 'configured-model',
      detail: 'Local FLUJO and an isolated Fly provisioning path are configured; live provisioning has not been verified.', config };
  }
  const fallbackKey = process.env.OPENAI_API_KEY;
  if (fallbackKey) {
    const fallback = { name: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', apiKey: fallbackKey,
      contextWindow: 8192, provider: 'openai', adapter: 'openai' };
    if ((await modelProbe(fallback)).available) {
      return { available: true, provider: 'openai-api',
        detail: 'The saved model is unavailable; an existing OpenAI API key can run one isolated Fly Worker. Cloud and model billing remain pending.', config: { ...config, model: fallback } };
    }
  }
  return { available: false, detail: `The configured FLUJO model endpoint is unavailable (${original.detail}); no working API fallback was found.` };
}

export async function fleetStatus() {
  const { config, ...publicState } = await inspectFleet();
  return publicState;
}

/** One owned Fly leaf, with no existing fleet writer or Machine adoption. */
export async function runFleetLeaf({ goal, task, dataDir, signal, maxUsd, onStatus = () => undefined }) {
  if (!goal || typeof goal.id !== 'string' || !/^[\w-]{1,100}$/.test(goal.id)) throw new Error('A safe goal id is required for isolated fleet work.');
  const discovered = await inspectFleet();
  if (!discovered.available) return { available: false, detail: discovered.detail };
  const config = discovered.config;
  const bootWorkspace = `seagulled-${goal.id.slice(-12)}-boot`;
  const boot = new FlujoClient({ origin: config.supervisor.origin, workspace: bootWorkspace });
  const registryPath = path.join(dataDir, 'fleet', goal.id, 'registry.json');
  const intentPath = path.join(path.dirname(registryPath), 'intent.json');
  if (existsSync(registryPath) || existsSync(intentPath)) throw unknown('A prior Fly fleet intent exists for this goal. Reconcile its original worker before more provisioning.');
  if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError', outcome: 'not_applied' });
  if ((await boot.workspaces()).includes(bootWorkspace)) throw unknown('The isolated FLUJO boot workspace already exists. Reconcile it before cloning.');
  mkdirSync(path.dirname(intentPath), { recursive: true, mode: 0o700 });
  let intent = { version: 1, goalId: goal.id, bootWorkspace, state: 'preparing', createdAt: new Date().toISOString() };
  writeFileSync(intentPath, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
  const record = (patch) => {
    intent = { ...intent, ...patch, updatedAt: new Date().toISOString() };
    const temporary = `${intentPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(intent), { mode: 0o600 });
    renameSync(temporary, intentPath);
  };
  let controller;
  let child;
  let bootCreated = false;
  let bootCleanupConfirmed = false;
  let remoteAccepted = false;
  let cleanupConfirmed = false;
  let result;
  let artifacts = [];
  let delivered;
  try {
    onStatus('Preparing an isolated FLUJO boot workspace.');
    bootCreated = true; // A partial install is still our workspace and needs cleanup.
    await installTemplate(boot, { model: config.model, bootOnly: true, browser: false });
    record({ state: 'boot-ready' });
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError', outcome: 'not_applied' });
    const provisioner = await flyProvisioner({ ...config.provisioner, templateWorkspace: bootWorkspace,
      fleetReachable: false, concurrency: 1, teamLimits: { agentTurns: 6, leadTurns: 12, concurrency: 1 } });
    controller = new Controller({ registryPath, operatorToken: randomBytes(32).toString('base64url'),
      publicUrl: 'http://127.0.0.1:1', provisioner, log: () => undefined, runTimeoutMs: 20 * 60_000 });
    const address = await controller.listen(0, '127.0.0.1');
    controller.publicUrl = `http://127.0.0.1:${address.port}`;
    const fleetGoal = controller.registry.createGoal({ id: goal.id, text: goal.text, limits: {
      maxWorkers: 1, maxDepth: 1, maxChildren: 1, maxActiveRuns: 1,
    } });
    const root = controller.registry.reserve({ goalId: fleetGoal.id, role: 'supervisor', name: 'Todd' }).worker;
    controller.registry.enroll(root.id, { kind: 'external', origin: config.supervisor.origin, workspace: bootWorkspace });
    onStatus('Creating one isolated Fly Worker.');
    record({ state: 'provisioning' });
    child = controller.delegate(root, { name: 'developer', task });
    remoteAccepted = true;
    record({ state: 'accepted', workerId: child.workerId, runId: child.runId });
    while (true) {
      if (signal?.aborted) throw unknown('Fly work was interrupted. The original run and worker need reconciliation.');
      const current = await controller.waitRun('operator', { runId: child.runId, timeoutMs: 10_000 });
      if (current.state !== 'running') { result = current; break; }
      await sleep(0);
    }
    if (result.state !== 'completed') throw unknown(`Fly run ${child.runId} ended as ${result.state}. Its original record is retained.`);
    record({ state: 'run-completed' });
    const artifactDir = path.join(dataDir, 'artifacts', goal.id);
    const resultPath = path.join(artifactDir, 'fly-result.txt');
    const bytes = Buffer.from(result.result ?? '', 'utf8');
    try {
      mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
      writeFileSync(resultPath, bytes, { flag: 'wx', mode: 0o600 });
      artifacts = [{ path: resultPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'run-result' }];
    } catch { onStatus('The Fly result was received, but its local transcript could not be saved.'); }
    onStatus('Fly Worker finished; retiring the owned sandbox.');
    const retirement = await controller.retire('operator', { workerId: child.workerId });
    if (retirement.cleanupUnconfirmed?.length) throw unknown('Fly Worker cleanup is unconfirmed. Its original record blocks further provisioning.');
    cleanupConfirmed = true;
    controller.registry.finishGoal(goal.id, result.result);
    record({ state: 'fly-retired', flyCleanupConfirmed: true });
    delivered = { available: true, text: result.result, artifacts, usage: { inputTokens: 0, outputTokens: 0, costUsd: null, costKind: 'unknown',
      reservedUsd: maxUsd, billingPending: true },
      sandbox: { kind: 'fly', workerId: child.workerId, runId: child.runId, retired: true, cleanupConfirmed: true } };
    return delivered;
  } catch (error) {
    const usage = remoteAccepted ? { inputTokens: 0, outputTokens: 0, costUsd: null, costKind: 'unknown',
      reservedUsd: maxUsd, billingPending: true } : undefined;
    if (remoteAccepted && child && controller && !cleanupConfirmed) {
      try {
        const retirement = await controller.retire('operator', { workerId: child.workerId });
        cleanupConfirmed = !retirement.cleanupUnconfirmed?.length;
      } catch { /* Preserve the original registry and uncertain cleanup. */ }
    }
    record({ state: remoteAccepted ? result?.state === 'failed' && cleanupConfirmed ? 'run-failed' : 'unknown' : 'failed-before-dispatch',
      flyCleanupConfirmed: cleanupConfirmed,
      error: String(error.message).slice(0, 500) });
    if (remoteAccepted && !cleanupConfirmed) throw Object.assign(unknown(`${error.message} Fly cleanup is unconfirmed; do not submit replacement work.`), { usage });
    if (remoteAccepted && result?.state === 'failed') {
      throw Object.assign(new Error('The isolated Fly team failed. Its worker was retired; inspect the saved run for the provider error.'), { outcome: 'failed', usage });
    }
    if (remoteAccepted) throw Object.assign(unknown(`${error.message} The original Fly run outcome must be reconciled before replay.`), { usage });
    if (!error.outcome) error.outcome = 'not_applied';
    throw error;
  } finally {
    await controller?.close().catch(() => undefined);
    // The boot workspace is ours, but retain it if remote cleanup is uncertain.
    if (bootCreated && (!remoteAccepted || cleanupConfirmed)) {
      for (let attempt = 0; attempt < 3 && !bootCleanupConfirmed; attempt++) {
        try { await boot.deleteWorkspace(bootWorkspace); bootCleanupConfirmed = true; }
        catch { if (attempt < 2) await sleep(1000); }
      }
    }
    record({ bootCleanupConfirmed, ...(delivered ? { state: 'completed' } : {}) });
    if (delivered) delivered.sandbox.bootCleanupConfirmed = bootCleanupConfirmed;
  }
}
