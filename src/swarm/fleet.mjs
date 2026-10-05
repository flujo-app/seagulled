import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Controller } from '../../upstream/swarm-teams/fleet/controller.mjs';
import { flyProvisioner } from '../../upstream/swarm-teams/fleet/provisioners.mjs';
import { FlujoClient } from '../../upstream/swarm-teams/lib/flujo-client.mjs';
import { installTemplate } from '../../upstream/swarm-teams/install.mjs';
import { collectFlyArtifacts } from '../artifacts/fly.mjs';
import { createOwnedRelay } from './relay.mjs';

const legacyProfilePath = () => path.join(process.env.SWARM_TEAMS_HOME || path.join(homedir(), '.swarm-teams'), 'config.json');
const profilePath = () => process.env.SEAGULLED_FLEET_PROFILE || legacyProfilePath();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unknown = (message) => Object.assign(new Error(message), { code: 'UNKNOWN', unknown: true });
const sourceFingerprint = (origin) => createHash('sha256').update(new URL(origin).origin.toLowerCase()).digest('hex').slice(0, 24);
const holdPath = (dataDir, origin) => path.join(dataDir, 'fleet', `source-admission-${sourceFingerprint(origin)}.json`);
const sourceHold = (dataDir, origin) => dataDir && existsSync(holdPath(dataDir, origin));
const modelFingerprint = (model) => createHash('sha256').update(`${model.baseUrl}\0${model.name}\0${model.apiKey}`).digest('hex').slice(0, 24);
const modelHoldPath = (dataDir, model) => path.join(dataDir, 'fleet', `model-admission-${modelFingerprint(model)}.json`);
const modelHold = (dataDir, model) => dataDir && existsSync(modelHoldPath(dataDir, model));
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

const nativeCodex = (model) => model?.provider === 'codex' && model?.adapter === 'codex-cli'
  && typeof model.name === 'string' && model.name.length > 0 && !model.apiKey;

/** Read-only discovery. No existing controller, registry, relay or worker is adopted. */
async function inspectFleet({ dataDir } = {}) {
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
    const client = new FlujoClient({ origin: origin.href, workspace: null });
    await client.api('GET', '/api/workspaces', undefined, { workspace: null, timeoutMs: 3000 }).then((response) => {
      if (response.status !== 200) throw new Error('source unavailable');
    });
  } catch { return { available: false, detail: 'The local FLUJO source is unavailable.' }; }
  if (nativeCodex(config.model)) {
    return { available: true, provider: 'codex-subscription-candidate',
      detail: 'A keyless Codex model is configured. The isolated boot flow must confirm this login before any Fly worker is created; cloud execution is not yet qualified.', config };
  }
  const original = await modelProbe(config.model);
  if (original.available) {
    return { available: true, provider: 'configured-model',
      detail: 'Local FLUJO and an isolated Fly provisioning path are configured; live provisioning has not been verified.', config };
  }
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

export async function fleetStatus({ dataDir } = {}) {
  const { config, ...publicState } = await inspectFleet({ dataDir });
  return publicState;
}

/** One owned Fly leaf, with no existing fleet writer or Machine adoption. */
export async function runFleetLeaf({ goal, task, dataDir, signal, maxUsd, onStatus = () => undefined }) {
  if (!goal || typeof goal.id !== 'string' || !/^[\w-]{1,100}$/.test(goal.id)) throw new Error('A safe goal id is required for isolated fleet work.');
  const discovered = await inspectFleet({ dataDir });
  if (!discovered.available) return { available: false, detail: discovered.detail };
  const config = discovered.config;
  const bootWorkspace = `seagulled-${goal.id.slice(-12)}-boot`;
  const boot = new FlujoClient({ origin: config.supervisor.origin, workspace: bootWorkspace });
  const registryPath = path.join(dataDir, 'fleet', goal.id, 'registry.json');
  const intentPath = path.join(path.dirname(registryPath), 'intent.json');
  const relayPath = path.join(path.dirname(registryPath), 'relay.json');
  if (existsSync(registryPath) || existsSync(intentPath) || existsSync(relayPath)) throw unknown('A prior Fly fleet intent exists for this goal. Reconcile its original worker before more provisioning.');
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
  let relay;
  let child;
  let bootCreated = false;
  let bootRunUnknown = false;
  let bootCleanupConfirmed = false;
  let remoteAccepted = false;
  let cleanupConfirmed = false;
  let relayCleanupConfirmed = true;
  let result;
  let artifacts = [];
  const artifactErrors = [];
  let delivered;
  let workspaceAbsent = false;
  try {
    onStatus('Preparing an isolated FLUJO boot workspace.');
    bootCreated = true; // A partial install is still our workspace and needs cleanup.
    await installTemplate(boot, { model: config.model, bootOnly: true, browser: false });
    record({ state: 'boot-ready' });
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
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError', outcome: 'not_applied' });
    const multiWorker = !nativeCodex(config.model);
    let workerCap = 1;
    if (multiWorker) {
      const { ManagedCloud } = await import(pathToFileURL(path.join(config.provisioner.flujoCloudPath, 'lib', 'managed.mjs')).href);
      const managed = new ManagedCloud();
      const org = await managed.organization(config.provisioner.org);
      workerCap = Number.isInteger(config.maxWorkers) ? Math.min(Math.max(config.maxWorkers, 1), 6) : 3;
      if (workerCap > 1) {
        onStatus('Creating an owned relay for the bounded Fly Worker tree.');
        relayCleanupConfirmed = false;
        try {
          relay = await createOwnedRelay({ journalPath: relayPath, flujoCloudPath: config.provisioner.flujoCloudPath,
            org, region: config.provisioner.region ?? 'iad' });
        } catch (error) {
          // The relay factory journals before the first Fly mutation. A failed
          // creation is safe to dismiss only when its journal confirms no app
          // remains; an ambiguous app must retain its exact intent.
          let relayState;
          try { relayState = JSON.parse(readFileSync(relayPath, 'utf8')); } catch { /* Keep the hold. */ }
          relayCleanupConfirmed = relayState?.state === 'retired' || relayState?.state === 'not-applied';
          if (!relayCleanupConfirmed) error.outcome = 'unknown';
          throw error;
        }
        record({ state: 'relay-ready', relayApp: relay.app, relayMachineId: relay.machineId });
      }
    }
    const provisioner = await flyProvisioner({ ...config.provisioner, templateWorkspace: bootWorkspace,
      fleetReachable: Boolean(relay), concurrency: workerCap,
      teamLimits: { agentTurns: 6, leadTurns: 12, concurrency: 1 } });
    controller = new Controller({ registryPath, operatorToken: randomBytes(32).toString('base64url'),
      publicUrl: 'http://127.0.0.1:1', remoteUrl: relay?.remoteUrl,
      provisioner, log: () => undefined, runTimeoutMs: 20 * 60_000,
      beforeRetire: async ({ worker, target }) => {
        if (target.kind !== 'fly') return;
        try {
          onStatus(`Collecting owned output from Worker ${worker.name}.`);
          const collected = await collectFlyArtifacts({ target, goalId: goal.id, workerId: worker.id,
            dataDir, flujoCloudPath: config.provisioner.flujoCloudPath });
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
    await relay?.start(controller.publicUrl);
    const fleetGoal = controller.registry.createGoal({ id: goal.id, text: goal.text, limits: {
      maxWorkers: workerCap, maxDepth: relay ? 2 : 1, maxChildren: relay ? 2 : 1, maxActiveRuns: 2,
    } });
    const root = controller.registry.reserve({ goalId: fleetGoal.id, role: 'supervisor', name: 'Todd' }).worker;
    controller.registry.enroll(root.id, { kind: 'external', origin: config.supervisor.origin, workspace: bootWorkspace });
    onStatus('Creating one isolated Fly Worker.');
    record({ state: 'provisioning' });
    child = controller.delegate(root, { name: 'developer', task: `${task}\n\nSave final deliverable files under `
      + `/data/flujo/workspaces/${bootWorkspace}/seagulled-output in your Worker workspace. `
      + 'Report file paths relative to seagulled-output. If you delegate to child Workers, tell each child to use '
      + 'seagulled-output in its own workspace. Do not treat a file outside that directory as a delivered artifact.' });
    remoteAccepted = true;
    record({ state: 'accepted', workerId: child.workerId, runId: child.runId });
    while (true) {
      if (signal?.aborted) throw unknown('Fly work was interrupted. The original run and worker need reconciliation.');
      const current = await controller.waitRun('operator', { runId: child.runId, timeoutMs: 10_000 });
      if (current.state !== 'running') { result = current; break; }
      await sleep(0);
    }
    if (result.state !== 'completed') {
      let failureDiagnostic = { readStatus: null, conversationStatus: result.state };
      let connection;
      try {
        const worker = controller.registry.worker(child.workerId);
        connection = await controller.connect(worker.target);
        const run = controller.registry.run(child.runId);
        failureDiagnostic = conversationFailure(await connection.client.conversation(run.conversationId));
      } catch { /* Preserve a bounded unavailable diagnostic; never replay the run. */ }
      finally { await connection?.close().catch(() => undefined); }
      record({ failureDiagnostic });
      throw unknown(`Fly run ${child.runId} ended as ${result.state}. Its original record is retained.`);
    }
    const unfinished = Object.values(controller.registry.state.runs).filter((run) => run.goalId === goal.id
      && run.id !== child.runId && ['running', 'unknown'].includes(run.state));
    if (unfinished.length) throw unknown('A descendant Fly run has not reached a confirmed terminal state. Preserve the original tree for reconciliation.');
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
    if (artifactErrors.length) throw Object.assign(new Error('Owned Fly output capture was incomplete. The worker tree was retired; inspect the private capture receipts.'),
      { outcome: 'failed' });
    controller.registry.finishGoal(goal.id, result.result);
    record({ state: 'fly-retired', flyCleanupConfirmed: true });
    delivered = { available: true, text: result.result, artifacts, usage: { inputTokens: 0, outputTokens: 0, costUsd: null, costKind: 'unknown',
      reservedUsd: maxUsd, billingPending: true },
      sandbox: { kind: 'fly', workerId: child.workerId, runId: child.runId, retired: true, cleanupConfirmed: true,
        workerCount: controller.registry.tree(goal.id).filter((worker) => worker.depth > 0).length } };
    return delivered;
  } catch (error) {
    const usage = remoteAccepted || !relayCleanupConfirmed ? { inputTokens: 0, outputTokens: 0, costUsd: null, costKind: 'unknown',
      reservedUsd: maxUsd, billingPending: true } : undefined;
    if (remoteAccepted && child && controller && !cleanupConfirmed) {
      try {
        const retirement = await controller.retire('operator', { workerId: child.workerId });
        cleanupConfirmed = !retirement.cleanupUnconfirmed?.length;
      } catch { /* Preserve the original registry and uncertain cleanup. */ }
    }
    if (!remoteAccepted && /^POST \/api\/workspaces failed \(HTTP 500\)/.test(String(error.message))) {
      try {
        workspaceAbsent = !(await boot.workspaces()).includes(bootWorkspace);
      } catch { workspaceAbsent = false; }
      if (workspaceAbsent) {
        bootCreated = false;
        bootCleanupConfirmed = true; // GET confirmed no workspace remains; setup may have rolled back a partial directory.
        recordSourceHold(dataDir, config.supervisor.origin, bootWorkspace, 'Workspace creation returned HTTP 500; exact-name readback found no workspace.');
      }
    }
    record({ state: workspaceAbsent ? 'preflight-not-applied'
      : remoteAccepted ? error.outcome === 'failed' && cleanupConfirmed ? 'artifact-capture-incomplete'
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
        try { relayCleanupConfirmed = await relay.retire(); }
        catch { relayCleanupConfirmed = false; }
      }
    }
    // The boot workspace is ours, but retain it if remote cleanup is uncertain.
    if (bootCreated && !bootRunUnknown && (!remoteAccepted || cleanupConfirmed)) {
      for (let attempt = 0; attempt < 3 && !bootCleanupConfirmed; attempt++) {
        try { await boot.deleteWorkspace(bootWorkspace); bootCleanupConfirmed = true; }
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
