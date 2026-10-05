import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL = 'qwen3.8-27b';
const RATE_USD_PER_SECOND = 0.001097 + 8 * 0.0000131 + 64 * 0.00000222;
const MAX_REQUEST_MS = 30 * 60_000;
const IDLE_RESERVE_SECONDS = 60;
const MIN_ADMISSION_USD = 6;
const REQUEST_RESERVE_USD = Math.ceil((MAX_REQUEST_MS / 1000 + IDLE_RESERVE_SECONDS) * RATE_USD_PER_SECOND * 100) / 100;
const OWNED_NAME = /^seagulled-qwen-[a-f0-9]{12}$/;
const sourceDir = dirname(fileURLToPath(new URL('./private_compute/app.py', import.meta.url)));
const unknown = (message) => Object.assign(new Error(message), { code: 'UNKNOWN', outcome: 'unknown', unknown: true });
const notApplied = (message) => Object.assign(new Error(message), { outcome: 'not_applied' });
const safeError = (reservation) => Object.assign(
  unknown('Private H100 work has an uncertain outcome. Preserve the owned attempt for reconciliation.'),
  reservation ? { reservation } : {},
);
const validGoalId = (id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);

function ownedEndpoint(raw, appName) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname.endsWith('.modal.run') || url.hostname.endsWith('.modal.direct'))
      && url.hostname.includes(appName) && (url.pathname === '/' || url.pathname === '')
      && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

function json(raw) { try { return JSON.parse(raw); } catch { return null; } }
function ownedRecord(value) {
  return value?.version === 1 && OWNED_NAME.test(value.appName) && typeof value.attemptId === 'string'
    && /^[a-f0-9-]{36}$/.test(value.attemptId) && typeof value.phase === 'string';
}

/** Product-only Modal resources. The original project's resources are never inputs. */
export class PrivateH100Manager {
  constructor({ dataDir, commandRunner, fetchImpl = fetch, credentialStore, modalCommand, modalArgs = [], modalEnv,
    clock = Date.now } = {}) {
    this.dataDir = dataDir;
    this.commandRunner = commandRunner;
    this.fetch = fetchImpl;
    this.credentialStore = credentialStore;
    this.modalCommand = modalCommand;
    this.modalArgs = [...modalArgs];
    this.modalEnv = modalEnv;
    this.clock = clock;
    this.path = dataDir ? join(dataDir, 'private-h100', 'attempt.json') : null;
    this.record = null;
    this.token = null;
    this.busy = false;
    this.activeRun = false;
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

  async restore() {
    if (this.record?.phase === 'ready') {
      try { this.token = await this.credentialStore?.get?.('private_h100') ?? null; }
      catch { this.token = null; }
      if (!this.token || !ownedEndpoint(this.record.endpoint, this.record.appName)) this.#save({ ...this.record, phase: 'unknown' });
    }
    return this.safeState();
  }

  safeState({ accountConnected = false, helperUsable = false } = {}) {
    const phase = this.record?.pendingRunId ? 'unknown' : this.record?.phase ?? 'off';
    const connected = phase === 'ready' && Boolean(this.token);
    const available = Boolean(this.path && accountConnected && helperUsable && this.credentialStore?.set && this.credentialStore?.get);
    const ready = connected && available && !this.busy && !this.activeRun && !this.record?.pendingRunId;
    const provisionable = available && (phase === 'off' || phase === 'retired');
    const detail = !['off', 'ready', 'retired'].includes(phase)
      ? 'An owned private H100 attempt needs reconciliation before further paid work.'
      : connected ? 'Owned Qwen H100 endpoint was verified; GPU availability and charges are checked per request.'
        : !accountConnected ? 'Sign in to a personal Modal account to offer private H100 compute.'
          : !helperUsable ? 'The packaged Modal helper is unavailable.'
            : 'Private H100 compute is off. Enabling it creates isolated paid resources.';
    return { id: 'private-h100', available, connected, ready, provisionable, status: phase,
      cleanupVerified: this.record?.cleanupVerified === true, detail,
      admission: { enableUsd: MIN_ADMISSION_USD, requestUsd: REQUEST_RESERVE_USD,
        kind: 'estimated', excludes: ['storage', 'egress', 'credits', 'invoice adjustments'] },
      estimate: { activeUsdPerHour: Math.round(RATE_USD_PER_SECOND * 3600 * 100) / 100,
        enableUsd: MIN_ADMISSION_USD, requestUsd: REQUEST_RESERVE_USD,
        admissionReserveUsd: MIN_ADMISSION_USD,
        requestReserveUsd: REQUEST_RESERVE_USD,
        basis: 'bounded timeout upper estimate at published compute rates; not an invoice cap',
        includes: 'H100, 8 CPU cores, 64 GiB memory; excludes storage, egress, credits, and invoice adjustments',
        kind: 'estimated' } };
  }

  #sourceWorkspace() {
    const target = join(dirname(this.path), 'source');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of ['app.py', 'settings.py', 'discovery.py', 'provision.py']) {
      const source = readFileSync(join(sourceDir, name));
      writeFileSync(join(target, name), source, { mode: 0o600 });
    }
    return target;
  }

  #environment(appName) {
    const env = { ...this.modalEnv?.() };
    for (const key of Object.keys(env)) if (/^(?:O_INFER_|SEAGULLED_PRIVATE_APP_NAME$)/i.test(key)) delete env[key];
    env.SEAGULLED_PRIVATE_APP_NAME = appName;
    if (this.record?.profileName) env.MODAL_PROFILE = this.record.profileName;
    return env;
  }

  async #cli(args, { signal, timeoutMs = 60_000, input, appName } = {}) {
    return this.commandRunner(this.modalCommand, [...this.modalArgs, ...args], {
      signal, timeoutMs, input, maxBytes: 64_000, env: this.#environment(appName),
    });
  }

  async #profile(signal, appName) {
    const result = await this.#cli(['profile', 'list', '--json'], { signal, timeoutMs: 10_000, appName });
    const profiles = json(result.stdout);
    const active = Array.isArray(profiles) ? profiles.filter(item => item?.active === true) : [];
    if (result.code !== 0 || active.length !== 1 || typeof active[0].name !== 'string'
      || !active[0].name || typeof active[0].workspace !== 'string'
      || !active[0].workspace || /^unknown/i.test(active[0].workspace)) throw notApplied('Modal profile and workspace could not be verified.');
    return { profileName: active[0].name, workspaceName: active[0].workspace };
  }

  async #modelProbe(endpoint, token, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), MAX_REQUEST_MS + 5 * 60_000);
    try {
      const response = await this.fetch(`${endpoint}/v1/models`, { headers: { authorization: `Bearer ${token}` },
        signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw safeError();
      const raw = await response.text();
      if (raw.length > 64_000) throw safeError();
      const models = json(raw)?.data;
      if (!Array.isArray(models) || !models.some(item => item?.id === MODEL)) throw safeError();
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  async enable({ budgetUsd, signal, accountConnected = false, helperUsable = false, workerAllowed = false,
    admissionId } = {}) {
    if (this.busy || this.activeRun) throw notApplied('Private H100 work is already changing.');
    if (signal?.aborted) throw notApplied('Private H100 enable was cancelled before admission.');
    if (workerAllowed !== true) throw notApplied('Allow the owned vLLM bearer to be used by isolated workers before enabling private H100.');
    if (!Number.isFinite(budgetUsd) || budgetUsd < MIN_ADMISSION_USD) throw notApplied('Private H100 needs at least 6 USD of remaining allowance for a bounded first attempt.');
    if (admissionId !== undefined && !validGoalId(admissionId)) throw notApplied('Private H100 admission ID is invalid.');
    this.busy = true;
    const started = this.clock();
    const attemptId = randomUUID();
    const appName = `seagulled-qwen-${randomBytes(6).toString('hex')}`;
    const reservation = { id: admissionId ?? randomUUID(), amountUsd: MIN_ADMISSION_USD, kind: 'estimated-upper' };
    let remoteStarted = false;
    try {
      await this.restore();
      if (!this.safeState({ accountConnected, helperUsable }).provisionable) throw notApplied('Private H100 cannot start until its account, helper, and previous attempt are ready.');
      this.#save({ version: 1, attemptId, appName, phase: 'prepared', createdAt: new Date(started).toISOString(),
        sourceCommit: '496e5930fa23836f5e805ef226afe840f728b888', workerAllowed: true, reservation });
      const profile = await this.#profile(signal, appName);
      this.#save({ ...this.record, ...profile });
      const token = randomBytes(48).toString('base64url');
      await this.credentialStore.set('private_h100', token);
      this.token = token;
      const source = this.#sourceWorkspace();
      if (signal?.aborted) throw notApplied('Private H100 enable was cancelled before remote provisioning.');
      this.#save({ ...this.record, phase: 'provisioning' });
      remoteStarted = true;
      const result = await this.commandRunner(this.modalCommand, ['-B', join(source, 'provision.py')], {
        signal, timeoutMs: MAX_REQUEST_MS + 2 * 60_000, input: JSON.stringify({ token }),
        maxBytes: 64_000, env: this.#environment(appName),
      });
      const endpoint = result?.code === 0 && ownedEndpoint(json(result.stdout)?.endpoint, appName);
      if (!endpoint) throw safeError();
      this.#save({ ...this.record, endpoint, phase: 'unverified' });
      await this.#modelProbe(endpoint, token, signal);
      this.#save({ ...this.record, phase: 'ready', verifiedAt: new Date(this.clock()).toISOString() });
      return { ...this.safeState({ accountConnected, helperUsable }), ready: true, reservation, usage: {
        reservationId: reservation.id,
        costUsd: Math.round(((this.clock() - started) / 1000 + IDLE_RESERVE_SECONDS) * RATE_USD_PER_SECOND * 1e6) / 1e6,
        costKind: 'estimated' } };
    } catch (error) {
      if (this.record?.attemptId !== attemptId) throw error;
      if (!remoteStarted) {
        await this.credentialStore?.delete?.('private_h100').catch(() => {});
        this.token = null;
        if (this.record?.attemptId === attemptId) this.#save({ ...this.record, phase: 'retired' });
        throw notApplied('Private H100 could not prepare its local source or secure credential store.');
      }
      this.#save({ ...this.record, phase: 'unknown' });
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
      if (record.phase === 'prepared') {
        await this.credentialStore?.delete?.('private_h100');
        this.token = null;
        this.#save({ ...record, phase: 'retired' });
        return { ...this.safeState({ accountConnected, helperUsable }), ready: false };
      }
      const app = record.appName;
      const profile = await this.#profile(signal, app);
      if (profile.profileName !== record.profileName || profile.workspaceName !== record.workspaceName) throw safeError();
      const stopped = await this.#cli(['app', 'stop', '--yes', app], { signal, appName: app });
      if (stopped.code !== 0) throw safeError(record.reservation);
      const listed = await this.#cli(['app', 'list', '--json'], { signal, appName: app });
      const apps = json(listed.stdout);
      if (listed.code !== 0 || !Array.isArray(apps) || !apps.some(item => item.description === app && /^stopped$/i.test(item.state))) throw safeError();
      for (const [kind, name] of [['secret', `${app}-auth`], ['volume', `${app}-hf-cache`], ['volume', `${app}-vllm-cache`]]) {
        const deletion = await this.#cli([kind, 'delete', '--allow-missing', '--yes', name], { signal, appName: app });
        if (deletion.code !== 0) throw safeError();
      }
      const [secrets, volumes] = await Promise.all([
        this.#cli(['secret', 'list', '--json'], { signal, appName: app }),
        this.#cli(['volume', 'list', '--json'], { signal, appName: app }),
      ]);
      const remaining = [json(secrets.stdout), json(volumes.stdout)];
      if (secrets.code !== 0 || volumes.code !== 0 || remaining.some(items => !Array.isArray(items))
        || remaining.some(items => items.some(item => [app + '-auth', app + '-hf-cache', app + '-vllm-cache'].includes(item.name)))) throw safeError();
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
    if (this.busy || this.activeRun || this.record?.phase !== 'ready' || this.record?.pendingRunId || !this.token)
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
    if (this.busy || this.activeRun || this.record?.phase !== 'ready' || this.record?.pendingRunId
      || this.record.workerAllowed !== true || !this.token)
      return { available: false, detail: 'Enable and verify the isolated private H100 endpoint first.' };
    if (!validGoalId(goalId) || this.record.leaseGoalId !== goalId)
      return { available: false, detail: 'Lease private H100 to this goal before routing workers.' };
    const endpoint = ownedEndpoint(this.record.endpoint, this.record.appName);
    if (!endpoint) return { available: false, detail: 'The owned private H100 endpoint needs reconciliation.' };
    return { available: true, providerId: 'private-h100', model: { name: MODEL, baseUrl: `${endpoint}/v1`,
      apiKey: this.token, provider: 'openai', adapter: 'openai' }, verification: 'previously-verified',
      costPolicy: 'estimated-gpu-seconds', ownedAttemptId: this.record.attemptId, leaseGoalId: goalId };
  }

  async run({ prompt, signal, maxUsd, goalId, requestId } = {}) {
    const route = this.fleetRoute(goalId);
    if (!route.available) throw notApplied(route.detail);
    if (!Number.isFinite(maxUsd) || maxUsd < REQUEST_RESERVE_USD) throw notApplied('The remaining allowance cannot admit one bounded H100 request.');
    if (signal?.aborted) throw notApplied('Private H100 request was cancelled before submission.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16_000) throw notApplied('Private H100 prompt is invalid.');
    if (requestId !== undefined && !validGoalId(requestId)) throw notApplied('Private H100 request ID is invalid.');
    this.activeRun = true;
    const runId = requestId ?? randomUUID();
    const reservation = { id: runId, amountUsd: REQUEST_RESERVE_USD, kind: 'estimated-upper' };
    try { this.#save({ ...this.record, pendingRunId: runId, pendingRunAt: new Date(this.clock()).toISOString(),
      pendingReservation: reservation }); }
    catch (error) { this.activeRun = false; throw error; }
    const started = this.clock();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), MAX_REQUEST_MS);
    try {
      const response = await this.fetch(`${route.model.baseUrl}/chat/completions`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
        signal: controller.signal, redirect: 'error' });
      const raw = await response.text();
      if (!response.ok || raw.length > 256_000) throw safeError();
      const result = json(raw);
      const text = result?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw safeError();
      this.#save({ ...this.record, pendingRunId: undefined, pendingRunAt: undefined,
        pendingReservation: undefined, lastRunId: runId });
      return { text: text.slice(0, 80_000), reservation, usage: { inputTokens: result?.usage?.prompt_tokens ?? null,
        outputTokens: result?.usage?.completion_tokens ?? null,
        reservationId: reservation.id,
        costUsd: Math.round(((this.clock() - started) / 1000 + IDLE_RESERVE_SECONDS) * RATE_USD_PER_SECOND * 1e6) / 1e6,
        costKind: 'estimated' } };
    } catch { throw safeError(reservation); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.activeRun = false; }
  }
}
