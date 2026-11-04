import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ModalSelfHostedModel, modalResult, readBoundedJson, selfHostedProfiles } from 'flujo-factory';

// Private inference runs on FACTORY's self-hosted model serving (vLLM on the user's own
// Modal account). Seagulled keeps the product rules: bounded admission reserves, one goal
// lease, durable request IDs and estimated (never billed) spend.
const VERIFICATION_VERSION = 2;
const MAX_REQUEST_MS = 30 * 60_000;
const IDLE_RESERVE_SECONDS = 60;
// Native context; short answers without thinking (bounded 1,024-token replies); a one-minute
// idle stop; the same 30-minute limits the reserves below assume.
const SETTINGS = Object.freeze({ enable_thinking: false, scaledown_minutes: 1, request_timeout_minutes: 30, startup_timeout_minutes: 30 });
const DEPLOY_TIMEOUT_MS = MAX_REQUEST_MS + 2 * 60_000;
const PROBE_TIMEOUT_MS = (SETTINGS.startup_timeout_minutes + 5) * 60_000;
const ENABLE_WINDOW_SECONDS = (DEPLOY_TIMEOUT_MS + PROBE_TIMEOUT_MS) / 1000 + IDLE_RESERVE_SECONDS;
const FAMILY = { qwen: 'Qwen', nemotron: 'Nemotron' };
const profiles = Object.fromEntries(selfHostedProfiles().map(profile => [profile.id, profile]));

/** The private model routes: list-price estimates per second, admission and request reserves. */
export const PRIVATE_MODELS = Object.freeze(Object.fromEntries(Object.keys(FAMILY).filter(id => profiles[id]).map(id => {
  const profile = profiles[id];
  return [id, Object.freeze({ id, family: FAMILY[id], label: `${profile.label.replace(/ on .*$/, '')} on ${profile.gpu}`, gpu: profile.gpu,
    model: profile.model, contextWindow: profile.contextWindow, cpu: profile.cpu, memoryGiB: profile.memoryMib / 1024, ratePerSecond: profile.usdPerSecond,
    activeUsdPerHour: Math.round(profile.usdPerSecond * 3600 * 100) / 100,
    enableUsd: Math.ceil(ENABLE_WINDOW_SECONDS * profile.usdPerSecond),
    requestUsd: Math.ceil((MAX_REQUEST_MS / 1000 + IDLE_RESERVE_SECONDS) * profile.usdPerSecond * 100) / 100 })];
})));
export const DEFAULT_PRIVATE_MODEL = 'qwen';
const OWNED_NAME = /^seagulled-(qwen|nemotron)-[a-f0-9]{12}$/;
const unknown = (message) => Object.assign(new Error(message), { code: 'UNKNOWN', outcome: 'unknown', unknown: true });
const notApplied = (message) => Object.assign(new Error(message), { outcome: 'not_applied' });
const safeError = (reservation) => Object.assign(
  unknown('Private inference has an uncertain outcome. Preserve the owned attempt for reconciliation.'),
  reservation ? { reservation } : {},
);
const validGoalId = (id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
const modelOf = (record) => PRIVATE_MODELS[record?.model] ? record.model : OWNED_NAME.exec(record?.appName ?? '')?.[1] ?? null;

function ownedEndpoint(raw, appName) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname.endsWith('.modal.run') || url.hostname.endsWith('.modal.direct'))
      && url.hostname.includes(appName) && (url.pathname === '/' || url.pathname === '')
      && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}
function verifiedRecord(record) {
  const spec = PRIVATE_MODELS[modelOf(record)];
  return record?.verificationVersion === VERIFICATION_VERSION && Boolean(spec) && record?.verifiedModel === spec.model
    && typeof record?.catalogVerifiedAt === 'string' && typeof record?.completionVerifiedAt === 'string';
}
function ownedRecord(value) {
  return value?.version === 1 && typeof value.attemptId === 'string' && /^[a-f0-9-]{36}$/.test(value.attemptId)
    && typeof value.phase === 'string' && (value.appName === undefined || OWNED_NAME.test(value.appName));
}
// The Modal helper is a Python with the modal package; FACTORY runs `<python> [args] -m modal`.
const pythonArgs = (modalArgs) => modalArgs.includes('-m') ? modalArgs.slice(0, modalArgs.indexOf('-m')) : [];

/** Product-only Modal resources. Other projects' resources are never inputs. */
export class PrivateH100Manager {
  constructor({ dataDir, commandRunner, fetchImpl = fetch, credentialStore, modalCommand, modalArgs = [], modalEnv,
    clock = Date.now, model = DEFAULT_PRIVATE_MODEL } = {}) {
    if (!PRIVATE_MODELS[model]) throw new TypeError('Choose a supported private model.');
    this.dataDir = dataDir;
    this.fetch = fetchImpl;
    this.credentialStore = credentialStore;
    this.clock = clock;
    this.selectedModel = model;
    this.path = dataDir ? join(dataDir, 'private-h100', 'attempt.json') : null;
    this.record = null;
    this.token = null;
    this.busy = false;
    this.activeRun = false;
    const refusingStore = { get: async () => null, set: async () => { throw new Error('No secure credential store.'); }, delete: async () => {} };
    this.compute = dataDir ? new ModalSelfHostedModel({ directory: join(dataDir, 'private-h100', 'model'), python: modalCommand,
      pythonArgs: pythonArgs(modalArgs), commandRunner, fetchImpl, credentialStore: credentialStore ?? refusingStore,
      keyName: 'private_h100', namePrefix: 'seagulled', clock, deployTimeoutMs: DEPLOY_TIMEOUT_MS,
      env: () => {
        const env = { ...modalEnv?.() };
        for (const key of Object.keys(env)) if (/^(?:O_INFER_|SEAGULLED_PRIVATE_)/i.test(key)) delete env[key];
        return env;
      } }) : null;
    if (this.path && existsSync(this.path)) {
      try {
        const record = JSON.parse(readFileSync(this.path, 'utf8'));
        this.record = ownedRecord(record) ? record : { phase: 'unknown' };
      } catch { this.record = { phase: 'unknown' }; }
    }
  }

  #save(record) {
    if (!this.path) throw notApplied('Private state directory is unavailable.');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const next = { ...record, updatedAt: new Date(this.clock()).toISOString() };
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.record = next;
    return next;
  }

  /** The model of the current attempt, or the requested/default choice when none is active. */
  #spec(model) {
    const active = this.record && !['off', 'retired'].includes(this.record.phase) ? modelOf(this.record) : null;
    return PRIVATE_MODELS[active ?? model ?? this.selectedModel] ?? PRIVATE_MODELS[DEFAULT_PRIVATE_MODEL];
  }

  async restore() {
    if (this.record?.phase === 'ready') {
      try { this.token = await this.credentialStore?.get?.('private_h100') ?? null; }
      catch { this.token = null; }
      if (!this.token || this.compute?.status().phase !== 'ready' || !ownedEndpoint(this.record.endpoint, this.record.appName)
        || !verifiedRecord(this.record)) this.#save({ ...this.record, phase: 'unknown' });
    }
    // An attempt recorded before FACTORY owned the Modal lifecycle is handed over for retirement.
    const record = this.record;
    if (this.compute && ownedRecord(record) && record.appName && !['off', 'retired', 'prepared'].includes(record.phase)
      && this.compute.status().phase === 'off' && record.profileName && record.workspaceName) {
      try {
        this.compute.adopt({ appName: record.appName, profileName: record.profileName, workspaceName: record.workspaceName,
          endpoints: record.endpoint ? [record.endpoint] : [] });
        this.#save({ ...record, phase: 'unknown' });
      } catch { /* Kept unknown; retirement reports the remaining uncertainty. */ }
    }
    return this.safeState();
  }

  safeState({ accountConnected = false, helperUsable = false, model } = {}) {
    const spec = this.#spec(model);
    const phase = this.record?.pendingRunId || this.record?.phase === 'ready' && !verifiedRecord(this.record)
      ? 'unknown' : this.record?.phase ?? 'off';
    const connected = phase === 'ready' && Boolean(this.token);
    const available = Boolean(this.path && accountConnected && helperUsable && this.credentialStore?.set && this.credentialStore?.get);
    const ready = connected && available && !this.busy && !this.activeRun && !this.record?.pendingRunId;
    const computeIdle = ['off', 'retired'].includes(this.compute?.status().phase ?? 'off');
    const provisionable = available && (phase === 'off' || phase === 'retired') && computeIdle;
    const detail = !['off', 'ready', 'retired'].includes(phase)
      ? `An owned private ${spec.gpu} attempt needs reconciliation before further paid work.`
      : connected ? `A bounded ${spec.family} completion succeeded; requests recheck availability and spend remains estimated.`
        : !accountConnected ? `Sign in to a personal Modal account to offer private ${spec.gpu} compute.`
          : !helperUsable ? 'The packaged Modal helper is unavailable.'
            : `Private ${spec.gpu} compute is off. Enabling it creates isolated paid resources.`;
    return { id: 'private-h100', available, connected, ready, provisionable, status: phase,
      privateModel: spec.id, privateModelLabel: spec.label, gpu: spec.gpu, servedModel: spec.model,
      privateModels: Object.values(PRIVATE_MODELS).map(({ id, label, gpu, model: served, activeUsdPerHour, enableUsd, requestUsd }) =>
        ({ id, label, gpu, model: served, activeUsdPerHour, enableUsd, requestUsd, kind: 'estimated' })),
      verificationVersion: connected ? VERIFICATION_VERSION : null,
      cleanupVerified: this.record?.cleanupVerified === true, detail,
      admission: { enableUsd: spec.enableUsd, requestUsd: spec.requestUsd,
        kind: 'estimated', excludes: ['storage', 'egress', 'credits', 'invoice adjustments'] },
      estimate: { activeUsdPerHour: spec.activeUsdPerHour,
        enableUsd: spec.enableUsd, requestUsd: spec.requestUsd,
        admissionReserveUsd: spec.enableUsd,
        requestReserveUsd: spec.requestUsd,
        basis: 'bounded timeout upper estimate at published compute rates; not an invoice cap',
        includes: `${spec.gpu}, ${spec.cpu} CPU cores, ${spec.memoryGiB} GiB memory; excludes storage, egress, credits, and invoice adjustments`,
        kind: 'estimated' } };
  }

  async enable({ budgetUsd, signal, accountConnected = false, helperUsable = false, workerAllowed = false,
    admissionId, model } = {}) {
    const choice = model ?? this.selectedModel;
    const spec = PRIVATE_MODELS[choice];
    if (!spec) throw notApplied('Choose a supported private model.');
    if (this.busy || this.activeRun) throw notApplied('Private H100 work is already changing.');
    if (signal?.aborted) throw notApplied('Private H100 enable was cancelled before admission.');
    if (workerAllowed !== true) throw notApplied('Allow the owned vLLM bearer to be used by isolated workers before enabling private H100.');
    if (!Number.isFinite(budgetUsd) || budgetUsd < spec.enableUsd) throw notApplied(`Private ${spec.gpu} needs at least ${spec.enableUsd} USD of remaining allowance for a bounded first attempt.`);
    if (admissionId !== undefined && !validGoalId(admissionId)) throw notApplied('Private H100 admission ID is invalid.');
    this.busy = true;
    const started = this.clock();
    const attemptId = randomUUID();
    const reservation = { id: admissionId ?? randomUUID(), amountUsd: spec.enableUsd, kind: 'estimated-upper' };
    let deploying = false;
    try {
      await this.restore();
      if (!this.safeState({ accountConnected, helperUsable, model: choice }).provisionable) throw notApplied('Private H100 cannot start until its account, helper, and previous attempt are ready.');
      this.#save({ version: 1, attemptId, model: choice, phase: 'prepared', createdAt: new Date(started).toISOString(),
        workerAllowed: true, reservation });
      deploying = true;
      this.#save({ ...this.record, phase: 'provisioning' });
      await this.compute.deploy({ profile: choice, overrides: SETTINGS, signal });
      const compute = this.compute.record;
      const endpoint = ownedEndpoint(compute?.endpoints?.[0], compute?.appName);
      this.token = await this.credentialStore.get('private_h100');
      const verification = compute?.verification;
      if (!endpoint || !this.token || verification?.model !== spec.model) throw safeError();
      this.#save({ ...this.record, appName: compute.appName, endpoint, phase: 'ready', verificationVersion: VERIFICATION_VERSION,
        verifiedModel: verification.model, catalogVerifiedAt: verification.catalogVerifiedAt,
        completionVerifiedAt: verification.completionVerifiedAt, verifiedAt: new Date(this.clock()).toISOString() });
      return { ...this.safeState({ accountConnected, helperUsable }), ready: true, reservation, usage: {
        reservationId: reservation.id,
        costUsd: Math.round(((this.clock() - started) / 1000 + IDLE_RESERVE_SECONDS) * spec.ratePerSecond * 1e6) / 1e6,
        costKind: 'estimated' } };
    } catch (error) {
      if (this.record?.attemptId !== attemptId) throw error;
      const appName = this.compute?.record?.appName;
      const owned = OWNED_NAME.test(appName ?? '') ? { appName } : {};
      // FACTORY retires its own preparation when nothing remote was created.
      if (!deploying || error?.outcome === 'not_applied' && this.compute?.status().phase === 'retired') {
        await this.credentialStore?.delete?.('private_h100')?.catch?.(() => {});
        this.token = null;
        this.#save({ ...this.record, ...owned, phase: 'retired' });
        throw notApplied('Private H100 could not prepare its local source or secure credential store.');
      }
      this.#save({ ...this.record, ...owned, phase: 'unknown' });
      throw safeError(reservation);
    } finally { this.busy = false; }
  }

  async disable({ signal, accountConnected = false, helperUsable = false, goalId } = {}) {
    if (this.busy || this.activeRun) throw notApplied('Private H100 work is already changing.');
    if (this.record?.leaseGoalId && this.record.leaseGoalId !== goalId)
      throw notApplied('Release the active private H100 goal before retiring its resources.');
    if (signal?.aborted) throw notApplied('Private H100 stop was cancelled before cleanup.');
    const record = this.record;
    if (!record || record.phase === 'retired') return this.safeState({ accountConnected, helperUsable });
    if (!ownedRecord(record)) throw safeError();
    if (record.phase !== 'prepared' && (!accountConnected || !helperUsable)) throw safeError(record.reservation);
    this.busy = true;
    try {
      this.#save({ ...record, phase: 'retiring' });
      // FACTORY stops the owned app, deletes its secret and volumes and checks they are gone. With
      // nothing journaled there, nothing remote was ever started for this attempt.
      const retired = this.compute.status().phase === 'off' ? { phase: 'retired', cleanupVerified: true }
        : await this.compute.retire({ signal });
      if (retired.phase !== 'retired' || retired.cleanupVerified !== true) throw safeError();
      await this.credentialStore?.delete?.('private_h100');
      this.token = null;
      this.#save({ ...this.record, phase: record.pendingRunId ? 'unknown' : 'retired',
        cleanupVerified: true, leaseGoalId: undefined, endpoint: undefined });
      return this.safeState({ accountConnected, helperUsable });
    } catch { this.#save({ ...this.record, phase: 'unknown' }); throw safeError(record.reservation); }
    finally { this.busy = false; }
  }

  leaseGoal(goalId) {
    if (!validGoalId(goalId)) throw notApplied('Private H100 goal ID is invalid.');
    if (this.busy || this.activeRun || this.record?.phase !== 'ready' || !verifiedRecord(this.record)
      || this.record?.pendingRunId || !this.token)
      throw notApplied('Private H100 is not ready for a goal lease.');
    if (this.record.leaseGoalId && this.record.leaseGoalId !== goalId)
      throw notApplied('Private H100 is already leased to another goal.');
    if (!this.record.leaseGoalId) this.#save({ ...this.record, leaseGoalId: goalId });
    return { goalId, attemptId: this.record.attemptId };
  }

  releaseGoal(goalId) {
    if (!validGoalId(goalId) || this.record?.leaseGoalId !== goalId)
      throw notApplied('Private H100 goal lease does not match.');
    if (this.busy || this.activeRun || this.record?.pendingRunId)
      throw notApplied('Private H100 goal still has active or uncertain work.');
    this.#save({ ...this.record, leaseGoalId: undefined });
    return { released: true };
  }

  fleetRoute(goalId) {
    if (this.busy || this.activeRun || this.record?.phase !== 'ready' || !verifiedRecord(this.record)
      || this.record?.pendingRunId
      || this.record.workerAllowed !== true || !this.token)
      return { available: false, detail: 'Enable and verify the isolated private H100 endpoint first.' };
    if (!validGoalId(goalId) || this.record.leaseGoalId !== goalId)
      return { available: false, detail: 'Lease private H100 to this goal before routing workers.' };
    const endpoint = ownedEndpoint(this.record.endpoint, this.record.appName);
    if (!endpoint) return { available: false, detail: 'The owned private H100 endpoint needs reconciliation.' };
    return { available: true, providerId: 'private-h100', model: { name: this.#spec().model, contextWindow: this.#spec().contextWindow, baseUrl: `${endpoint}/v1`,
      apiKey: this.token, provider: 'openai', adapter: 'openai' }, verification: 'inference-verified',
      costPolicy: 'estimated-gpu-seconds', verificationVersion: VERIFICATION_VERSION,
      ownedAttemptId: this.record.attemptId, leaseGoalId: goalId };
  }

  async run({ prompt, signal, maxUsd, goalId, requestId } = {}) {
    const route = this.fleetRoute(goalId);
    if (!route.available) throw notApplied(route.detail);
    const spec = this.#spec();
    if (!Number.isFinite(maxUsd) || maxUsd < spec.requestUsd) throw notApplied(`The remaining allowance cannot admit one bounded ${spec.gpu} request.`);
    if (signal?.aborted) throw notApplied('Private H100 request was cancelled before submission.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16_000) throw notApplied('Private H100 prompt is invalid.');
    if (requestId !== undefined && !validGoalId(requestId)) throw notApplied('Private H100 request ID is invalid.');
    this.activeRun = true;
    const runId = requestId ?? randomUUID();
    const reservation = { id: runId, amountUsd: spec.requestUsd, kind: 'estimated-upper' };
    try { this.#save({ ...this.record, pendingRunId: runId, pendingRunAt: new Date(this.clock()).toISOString(),
      pendingReservation: reservation }); }
    catch (error) { this.activeRun = false; throw error; }
    const started = this.clock();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), MAX_REQUEST_MS);
    try {
      const response = await modalResult(this.fetch, `${route.model.baseUrl}/chat/completions`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ model: spec.model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      }, controller);
      if (!response.ok) { controller.abort(); throw safeError(); }
      const result = await readBoundedJson(response, 256_000, controller);
      if (controller.signal.aborted) throw safeError();
      const text = result?.choices?.[0]?.message?.content;
      if (result?.model !== spec.model || result?.choices?.[0]?.message?.role !== 'assistant'
        || typeof text !== 'string' || !text.trim()) throw safeError();
      this.#save({ ...this.record, pendingRunId: undefined, pendingRunAt: undefined,
        pendingReservation: undefined, lastRunId: runId });
      return { text: text.slice(0, 80_000), reservation, usage: { inputTokens: result?.usage?.prompt_tokens ?? null,
        outputTokens: result?.usage?.completion_tokens ?? null,
        reservationId: reservation.id,
        costUsd: Math.round(((this.clock() - started) / 1000 + IDLE_RESERVE_SECONDS) * spec.ratePerSecond * 1e6) / 1e6,
        costKind: 'estimated' } };
    } catch { throw safeError(reservation); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.activeRun = false; }
  }
}
