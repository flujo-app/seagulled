import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ProviderManager } from './providers/index.mjs';
import { SwarmCoordinator } from './swarm/index.mjs';
import { createVoice } from './voice/index.mjs';
import { createBudgets, capacity, usdAmount, DEFAULT_BUDGET_USD } from './budget.mjs';

export const defaultDataDir = () => process.env.SEAGULLED_HOME || path.join(homedir(), '.seagulled');
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID()}`;
const copy = (value) => structuredClone(value);
function conversations(options, previous) {
  if (options.conversationsPerWorker !== undefined && options.agentsPerWorker !== undefined) throw new Error('Choose one conversation limit.');
  if (options.conversationsPerWorker !== undefined) return capacity(options.conversationsPerWorker, 5, 10);
  if (options.agentsPerWorker !== undefined) return capacity(options.agentsPerWorker, 4, 10) + 1;
  return previous?.conversationsPerWorker ?? (previous?.agentsPerWorker === undefined ? 5 : previous.agentsPerWorker + 1);
}
export function createRuntime({ dataDir = defaultDataDir(), providers, swarm, voice, budgets } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(dataDir, 'state.json');
  const lockPath = path.join(dataDir, 'runtime.lock');
  if (existsSync(lockPath)) {
    let previous;
    try { previous = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { throw new Error('Saved runtime ownership is damaged. Preserve it and reconcile the previous session.'); }
    let live = false;
    try { process.kill(previous.pid, 0); live = true; } catch (e) { if (e.code !== 'ESRCH') live = true; }
    if (live) throw new Error('Seagulled is already running. Open the existing session.');
    unlinkSync(lockPath);
  }
  const owner = randomUUID();
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 });
  let state;
  try {
    state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {
      version: 1,
      conversation: [{ id: id('message'), role: 'todd', text: 'Alright. What are we building? Give me the goal. I’ll get my people on it.', at: now() }],
      goals: [], providers: [], spend: { usd: 0, reportedUsd: 0, estimatedUsd: 0, unknownCalls: 0, subscriptionCalls: 0 }, swarm: { status: 'idle' },
    };
    if (state.version !== 1 || !Array.isArray(state.goals) || !Array.isArray(state.conversation) || !state.spend) throw new Error('Unsupported saved state.');
  } catch (e) { unlinkSync(lockPath); throw new Error(`Saved conversation needs recovery: ${e.message}. Your original file is preserved.`); }
  for (const goal of state.goals) {
    if (goal.status === 'running' || goal.status === 'pausing' || goal.status === 'stopping') {
      goal.status = 'interrupted'; goal.error = 'Previous execution was interrupted. Its outcome needs reconciliation before more work can run.';
      goal.recoveryHold = true;
    }
  }
  // Provider availability is observed afresh; saved login summaries are never authority.
  state.providers = [];
  const events = new EventEmitter();
  const jobs = new Map();
  let closed = false;
  let discovering;
  let accountLogin;
  const manager = providers || new ProviderManager({ dataDir: path.join(dataDir, 'providers') });
  const speech = voice || createVoice({ dataDir });
  const allowances = budgets || createBudgets({ dataDir });
  const persist = () => {
    state.swarm = { admissionPaused: Boolean(state.swarm?.admissionPaused), status: jobs.size ? 'working' : state.goals.some(g => g.recoveryHold) ? 'needs-attention' : state.swarm?.admissionPaused ? 'paused' : 'idle' };
    const temp = `${statePath}.${owner}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 }); renameSync(temp, statePath);
  };
  const publish = () => { persist(); events.emit('event', { type: 'state', state: copy(state) }); };
  const message = (role, text, goalId) => {
    if (!text) return;
    state.conversation.push({ id: id('message'), role, text: String(text), at: now(), ...(goalId ? { goalId } : {}) });
  };
  const find = (goalId) => {
    const goal = state.goals.find(g => g.id === goalId);
    if (!goal) throw new Error('That goal could not be found.');
    return goal;
  };
  function reserveUsage(goal, reservation) {
    if (!reservation || typeof reservation.id !== 'string' || !/^[\w-]{1,100}$/.test(reservation.id) || ['__proto__', 'constructor', 'prototype'].includes(reservation.id)
      || typeof reservation.amountUsd !== 'number' || !Number.isFinite(reservation.amountUsd) || reservation.amountUsd <= 0) {
      throw Object.assign(new Error('The provider reservation is invalid.'), { outcome: 'not_applied' });
    }
    goal.reservations ||= {};
    const previous = goal.reservations[reservation.id];
    if (previous) {
      if (previous.amountUsd !== reservation.amountUsd) throw Object.assign(new Error('An accepted reservation changed amount.'), { code: 'UNKNOWN', unknown: true });
      return;
    }
    if (reservation.amountUsd > goal.budgetUsd - goal.spentUsd - (goal.pendingUsd || 0)) {
      throw Object.assign(new Error('The remaining allowance cannot reserve this private request.'), { outcome: 'not_applied' });
    }
    goal.reservations[reservation.id] = { amountUsd: reservation.amountUsd, status: 'pending', at: now() };
    goal.pendingUsd = (goal.pendingUsd || 0) + reservation.amountUsd;
    state.spend.pendingUsd = (state.spend.pendingUsd || 0) + reservation.amountUsd;
    goal.billingPending = true;
  }
  function recordUsage(goal, usage = {}) {
    const cost = usage.costUsd;
    const monetary = Number.isFinite(cost) && cost >= 0;
    const suppliedKind = usage.costKind;
    const kind = suppliedKind === 'subscription' ? 'subscription'
      : monetary && ['reported', 'estimated'].includes(suppliedKind) ? suppliedKind : 'unknown';
    const reservation = typeof usage.reservationId === 'string' ? goal.reservations?.[usage.reservationId] : undefined;
    if (reservation?.receiptRecorded) return;
    if (reservation) {
      reservation.receiptRecorded = true;
      if (['reported', 'estimated', 'subscription'].includes(kind)) {
        goal.pendingUsd = Math.max(0, (goal.pendingUsd || 0) - reservation.amountUsd);
        state.spend.pendingUsd = Math.max(0, (state.spend.pendingUsd || 0) - reservation.amountUsd);
        reservation.status = 'settled'; goal.billingPending = goal.pendingUsd > 0;
      } else reservation.status = 'unknown';
    }
    if (!reservation && Number.isFinite(usage.reservedUsd) && usage.reservedUsd > 0) {
      goal.pendingUsd = (goal.pendingUsd || 0) + usage.reservedUsd;
      state.spend.pendingUsd = (state.spend.pendingUsd || 0) + usage.reservedUsd;
      goal.billingPending = true;
    }
    if (monetary && ['reported', 'estimated'].includes(kind)) {
      goal.spentUsd = Math.round((goal.spentUsd + cost) * 1e9) / 1e9;
      state.spend.usd = Math.round((state.spend.usd + cost) * 1e9) / 1e9;
      const field = kind === 'reported' ? 'reportedUsd' : 'estimatedUsd';
      state.spend[field] = (state.spend[field] || 0) + cost;
    } else if (kind === 'subscription') { state.spend.subscriptionCalls++; }
    else { state.spend.unknownCalls++; }
    goal.usage = { inputTokens: (goal.usage?.inputTokens || 0) + (Number(usage.inputTokens) || 0), outputTokens: (goal.usage?.outputTokens || 0) + (Number(usage.outputTokens) || 0), costKind: kind };
    goal.updatedAt = now();
    if (goal.spentUsd >= goal.budgetUsd && jobs.has(goal.id)) {
      goal.status = 'pausing'; goal.error = 'Budget reached. Increase it to continue.';
      jobs.get(goal.id).controller.abort(new Error('Budget reached.'));
    }
  }
  function onEvent(event) {
    const goal = event.goalId ? state.goals.find(g => g.id === event.goalId) : undefined;
    if (goal) {
      if (event.type === 'reservation') reserveUsage(goal, event.reservation);
      if (event.type === 'task' && event.task) {
        const index = goal.tasks.findIndex(t => t.id === event.task.id);
        if (index >= 0) goal.tasks[index] = { ...goal.tasks[index], ...event.task };
        else goal.tasks.push(copy(event.task));
      }
      if (event.type === 'message') message(event.role === 'todd' ? 'todd' : 'team', event.text, goal.id);
      if (event.type === 'usage') {
        const job = jobs.get(goal.id);
        if (job) job.usageEvents++;
        recordUsage(goal, event.usage);
        // Pause at a durable terminal receipt, preserving the completed call for
        // resume. Stop remains immediate and may require remote reconciliation.
        if (job?.pauseRequested) job.controller.abort(new Error('Pause after current task.'));
      }
      goal.updatedAt = now();
    }
    events.emit('event', copy(event)); publish();
  }
  const coordinator = swarm || new SwarmCoordinator({ providers: manager, onEvent, dataDir: path.join(dataDir, 'swarm'), fleet: process.env.SEAGULLED_DISABLE_FLEET === '1' ? undefined : 'auto' });
  // Test/integration injection supports the same event sink without a mock-only runtime branch.
  if (swarm?.setEventHandler) swarm.setEventHandler(onEvent);
  const privateLifecycle = () => typeof manager.privateComputeEnable === 'function'
    && typeof manager.privateComputeDisable === 'function' && typeof manager.privateComputeLeaseGoal === 'function';
  function releasePrivateReserve(goal, status) {
    const admission = goal.privateCompute;
    if (!admission || admission.reservationStatus !== 'pending') return;
    goal.pendingUsd = Math.max(0, (goal.pendingUsd || 0) - admission.reservedUsd);
    state.spend.pendingUsd = Math.max(0, (state.spend.pendingUsd || 0) - admission.reservedUsd);
    admission.reservationStatus = status;
    goal.billingPending = goal.pendingUsd > 0;
  }
  async function preparePrivate(goal, job) {
    if (!goal.privateH100 || !privateLifecycle()) return;
    const status = await manager.privateComputeState();
    if (job.controller.signal.aborted) throw Object.assign(new Error('Private startup was cancelled before admission.'), { name: 'AbortError' });
    if (!status.provisionable) throw Object.assign(new Error(status.detail || 'Private H100 is unavailable.'), { outcome: 'not_applied' });
    const reserve = status.admission?.enableUsd;
    if (!Number.isFinite(reserve) || reserve <= 0 || goal.budgetUsd - goal.spentUsd - (goal.pendingUsd || 0) < reserve) {
      throw Object.assign(new Error('The remaining budget cannot reserve private H100 startup.'), { outcome: 'not_applied' });
    }
    goal.privateCompute = { admissionId: id('gpu'), reservedUsd: reserve, reservationStatus: 'pending', cleanupStatus: 'not-started' };
    goal.pendingUsd = (goal.pendingUsd || 0) + reserve;
    state.spend.pendingUsd = (state.spend.pendingUsd || 0) + reserve;
    goal.billingPending = true;
    publish();
    try {
      const result = await manager.privateComputeEnable({ budgetUsd: goal.budgetUsd - goal.spentUsd,
        signal: job.controller.signal, workerAllowed: true, admissionId: goal.privateCompute.admissionId });
      job.privateOwned = true;
      const cost = result?.usage?.costUsd;
      if (result?.reservation?.id !== goal.privateCompute.admissionId || result.reservation.amountUsd !== reserve || result.ready !== true
        || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || result.usage.costKind !== 'estimated') {
        throw Object.assign(new Error('Private startup has no valid terminal cost estimate.'), { code: 'UNKNOWN', unknown: true });
      }
      releasePrivateReserve(goal, 'estimated');
      recordUsage(goal, result.usage);
      if (job.pauseRequested) job.controller.abort(new Error('Pause after private startup.'));
      if (job.controller.signal.aborted) return;
      await manager.privateComputeLeaseGoal(goal.id);
      goal.privateCompute.cleanupStatus = 'required';
      state.providers = manager.publicState();
      publish();
    } catch (error) {
      if (error.outcome === 'not_applied' && !job.privateOwned) releasePrivateReserve(goal, 'not-applied');
      else {
        job.privateOwned = true;
        if (error.outcome !== 'not_applied') {
          error.code = 'UNKNOWN'; error.unknown = true;
          if (!error.usage) error.usage = { costKind: 'unknown', costUsd: null };
        }
        goal.privateCompute.reservationStatus = goal.privateCompute.reservationStatus === 'pending' ? 'unknown' : goal.privateCompute.reservationStatus;
        goal.privateCompute.cleanupStatus = 'required';
      }
      publish(); throw error;
    }
  }
  async function retirePrivate(goal, job) {
    if (!job.privateOwned) return;
    const terminalStatus = goal.status;
    if (['completed', 'paused', 'stopped', 'failed'].includes(terminalStatus)) goal.status = 'stopping';
    goal.privateCompute.cleanupStatus = 'retiring'; publish();
    try {
      // Goal cancellation must not cancel the independently required retirement.
      const result = await manager.privateComputeDisable({ goalId: goal.id });
      if (result?.cleanupVerified !== true) throw new Error('Private resource retirement could not be verified.');
      goal.privateCompute.cleanupStatus = 'verified';
      goal.status = terminalStatus;
    } catch {
      goal.privateCompute.cleanupStatus = 'unknown';
      goal.recoveryHold = true; goal.status = 'interrupted';
      goal.error = 'Private GPU cleanup needs reconciliation; its allowance and owned attempt are preserved.';
    }
    state.providers = manager.publicState(); publish();
  }
  function start(goal) {
    if (closed || jobs.has(goal.id) || goal.recoveryHold || goal.status !== 'queued') return;
    if (state.swarm.admissionPaused) { goal.error = 'The team is paused. Resume the team to start new work.'; publish(); return; }
    if (state.goals.some(g => g.recoveryHold)) { goal.error = 'A previous run needs reconciliation. New work is held.'; publish(); return; }
    if (goal.privateH100 && [...jobs.keys()].some(goalId => find(goalId).privateH100)) {
      goal.error = 'Private H100 is working on another goal.'; publish(); return;
    }
    const selectedId = goal.privateH100 ? 'private-h100' : goal.providerId || (state.preferredProviderId !== 'private-h100' ? state.preferredProviderId : undefined);
    const provider = state.providers.find(p => p.connected && p.available && (goal.privateH100 || p.id !== 'private-h100') && (!selectedId || p.id === selectedId));
    if (!provider && !(goal.privateH100 && privateLifecycle())) { goal.error = goal.privateH100 ? 'Private H100 inference is not ready yet.' : 'Connect a provider and I’ll get the team started.'; publish(); return; }
    goal.providerId = goal.privateH100 ? 'private-h100' : provider.id;
    goal.error = undefined; goal.status = 'running'; goal.updatedAt = now();
    const controller = new AbortController();
    const job = { controller, usageEvents: 0, promise: null };
    jobs.set(goal.id, job); publish();
    job.promise = (async () => {
      try {
        await preparePrivate(goal, job);
        if (controller.signal.aborted) throw Object.assign(new Error('Goal execution was cancelled.'), { name: 'AbortError' });
        const result = await coordinator.execute({ goal: copy(goal), signal: controller.signal });
        // The coordinator emits each terminal receipt once. Aggregates may include
        // prior checkpoints and are never charged again after a resume.
        if (controller.signal.aborted) {
          goal.status = goal.status === 'stopping' ? 'stopped' : 'paused';
        } else if (result.completed === false) {
          goal.status = 'paused'; goal.result = result.text;
          goal.error = result.reason || 'The team reached its work limit. Review the progress before continuing.';
          message('todd', result.text || goal.error, goal.id);
        } else {
          goal.status = 'completed'; goal.result = result.text;
          job.completionText = result.text || 'The team has wrapped up. Open the goal to review their work.';
        }
      } catch (e) {
        if (typeof manager.publicState === 'function') state.providers = manager.publicState();
        if (e.usage && !e.usageRecorded) recordUsage(goal, e.usage);
        if (controller.signal.aborted && !e.unknown && e.code !== 'UNKNOWN') goal.status = goal.status === 'stopping' ? 'stopped' : 'paused';
        else {
          goal.status = e.unknown || ['UNKNOWN', 'SWARM_RECOVERY_HOLD'].includes(e.code) ? 'interrupted' : 'failed';
          goal.recoveryHold = goal.status === 'interrupted';
          goal.error = e.message || 'The team could not finish this goal.';
          if (!closed) message('todd', `The team hit a blocker: ${goal.error}`, goal.id);
        }
      } finally {
        await retirePrivate(goal, job);
        if (goal.status === 'completed' && job.completionText && !state.conversation.some(m => m.goalId === goal.id && m.text === job.completionText)) message('todd', job.completionText, goal.id);
        jobs.delete(goal.id); goal.updatedAt = now(); publish();
      }
    })();
  }
  persist();
  return {
    dataDir,
    snapshot: () => copy(state),
    defaultBudget: currency => allowances.default(currency),
    voiceCapabilities: () => speech.capabilities(),
    transcribeAudio: payload => speech.transcribe(payload),
    speak: text => speech.speak(text),
    stopSpeaking: () => speech.stop(),
    async authState() {
      if (!manager.authState) return { fly: { id: 'fly', installed: false, connected: false, available: false }, modal: { id: 'modal', installed: false, connected: false, available: false } };
      return manager.authState();
    },
    async authConnect(payload) {
      if (closed) throw new Error('This session has closed.');
      if (!payload || !['fly', 'modal'].includes(payload.id) || Object.keys(payload).some(k => k !== 'id')) throw new Error('Choose Fly or Modal sign-in.');
      if (accountLogin) throw new Error('Finish the current sign-in first.');
      if (!manager.authConnect) throw new Error('Browser sign-in is unavailable.');
      const controller = new AbortController();
      const job = { controller }; accountLogin = job;
      job.promise = manager.authConnect({ id: payload.id, signal: controller.signal });
      try { return await job.promise; } finally { if (accountLogin === job) accountLogin = undefined; }
    },
    async authCancel() {
      const job = accountLogin; job?.controller.abort();
      await job?.promise?.catch(() => {});
      return { cancelled: Boolean(job) };
    },
    readArtifact(goalId, taskId, index) {
      const goal = find(goalId);
      const task = goal.tasks.find(t => t.id === taskId);
      const artifact = task?.artifacts?.[Number(index)];
      if (!artifact || !Number.isInteger(Number(index)) || Number(index) < 0) throw new Error('That artifact could not be found.');
      const roots = [path.join(dataDir, 'providers', 'workspaces', goalId), path.join(dataDir, 'swarm', 'artifacts', goalId)];
      const absolute = realpathSync(artifact.path);
      if (!roots.some(root => absolute.startsWith(path.resolve(root) + path.sep))) throw new Error('That artifact is outside the owned workspace.');
      const bytes = readFileSync(absolute);
      if (bytes.length > 20_000_000 || bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('This artifact changed after verification. Its original receipt is preserved.');
      return { name: path.basename(absolute), data: bytes.toString('base64'), sha256: artifact.sha256, bytes: bytes.length };
    },
    subscribe(listener) { events.on('event', listener); return () => events.off('event', listener); },
    async discover() {
      if (!discovering) discovering = (async () => {
        const result = await manager.discover();
        state.providers = Array.isArray(result) ? result : manager.publicState();
        publish(); for (const goal of state.goals) if (goal.status === 'queued') start(goal);
        return copy(state.providers);
      })().finally(() => { discovering = undefined; });
      return discovering;
    },
    async connect(payload) {
      await manager.connect(payload);
      state.providers = manager.publicState();
      if (state.providers.some(p => p.id === payload.id && p.connected)) state.preferredProviderId = payload.id;
      publish();
      for (const goal of state.goals) if (goal.status === 'queued') start(goal);
      return copy(state.providers);
    },
    async disconnect(providerId) {
      const running = state.goals.filter(g => g.providerId === providerId && jobs.has(g.id));
      for (const goal of running) { goal.status = 'pausing'; jobs.get(goal.id).controller.abort(); }
      await Promise.all(running.map(g => jobs.get(g.id)?.promise));
      await manager.disconnect(providerId);
      if (state.preferredProviderId === providerId) delete state.preferredProviderId;
      state.providers = manager.publicState(); publish();
      return copy(state.providers);
    },
    async chat(text, options = {}) {
      if (closed) throw new Error('This session has closed.');
      if (typeof text !== 'string' || !text.trim() || text.length > 50000) throw new Error('Tell Todd your goal in 1–50,000 characters.');
      if (options.budget !== undefined && options.budgetUsd !== undefined) throw new Error('Choose one budget currency.');
      if (options.privateH100 !== undefined && typeof options.privateH100 !== 'boolean') throw new Error('Private inference must be on or off.');
      if (options.providerId === 'private-h100' && options.privateH100 !== true) throw new Error('Enable private inference to use H100.');
      const maxWorkers = capacity(options.maxWorkers, 5, 6), conversationsPerWorker = conversations(options);
      const budget = await allowances.resolve(options.budget, options.budgetUsd ?? DEFAULT_BUDGET_USD);
      if (!state.providers.length) await this.discover();
      if (closed) throw new Error('This session has closed.');
      const goal = { id: id('goal'), text: text.trim(), status: 'queued', budgetUsd: budget.allowanceUsd, budget, spentUsd: 0,
        providerId: options.privateH100 === true ? 'private-h100' : options.providerId || (state.preferredProviderId !== 'private-h100' ? state.preferredProviderId : null) || null,
        privateH100: options.privateH100 === true, workerTopologyVersion: 2, maxWorkers, conversationsPerWorker, agentsPerWorker: conversationsPerWorker - 1, tasks: [], createdAt: now(), updatedAt: now(),
        context: state.conversation.slice(-12).map(m => ({ role: m.role, text: m.text })) };
      state.goals.push(goal); message('user', goal.text, goal.id);
      message('todd', state.providers.some(p => p.available && p.connected) ? 'Got it. I’m putting the team on this. I’ll check what they bring back.' : 'Got it. Connect your provider once and I’ll put the team on this.', goal.id);
      publish(); start(goal); return copy(goal);
    },
    async updateGoal(goalId, patch) {
      const goal = find(goalId);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['text', 'budget', 'budgetUsd', 'providerId', 'maxWorkers', 'conversationsPerWorker', 'agentsPerWorker', 'privateH100'].includes(k))) throw new Error('You can edit the goal, budget, provider, and team limits.');
      if (patch.text !== undefined) {
        if (typeof patch.text !== 'string' || !patch.text.trim() || patch.text.length > 50000) throw new Error('Enter a goal in 1–50,000 characters.');
      }
      if (patch.budget !== undefined && patch.budgetUsd !== undefined) throw new Error('Choose one budget currency.');
      if (patch.privateH100 !== undefined && typeof patch.privateH100 !== 'boolean') throw new Error('Private inference must be on or off.');
      if (patch.privateH100 !== undefined && patch.providerId !== undefined) throw new Error('Choose one inference route.');
      if (patch.providerId === 'private-h100') throw new Error('Use the private inference switch to select H100.');
      const nextWorkers = capacity(patch.maxWorkers, goal.maxWorkers ?? 5, 6), nextConversations = conversations(patch, goal);
      if (patch.budgetUsd !== undefined) usdAmount(patch.budgetUsd);
      if (patch.budget !== undefined && (!patch.budget || typeof patch.budget !== 'object' || Array.isArray(patch.budget) ||
          Object.keys(patch.budget).some(k => !['amount', 'currency'].includes(k)) || typeof patch.budget.amount !== 'number' ||
          !Number.isFinite(patch.budget.amount) || patch.budget.amount <= 0 || !/^[A-Z]{3}$/.test(patch.budget.currency))) throw new Error('Choose a positive allowance and currency.');
      // Fence admission before waiting on a currency quote. The already-accepted
      // call can settle once; it cannot admit another task while an edit is pending.
      if (jobs.has(goal.id) && (patch.text !== undefined || patch.providerId !== undefined || patch.budget !== undefined ||
          patch.maxWorkers !== undefined || patch.conversationsPerWorker !== undefined || patch.agentsPerWorker !== undefined || patch.privateH100 !== undefined || Number(patch.budgetUsd) < goal.budgetUsd)) {
        const current = jobs.get(goal.id);
        await this.controlGoal(goal.id, 'pause');
        await current.promise;
      }
      const currencyBudget = patch.budget !== undefined || patch.budgetUsd !== undefined
        ? await allowances.resolve(patch.budget, patch.budgetUsd) : goal.budget;
      const budget = currencyBudget?.allowanceUsd ?? goal.budgetUsd;
      if (goal.pendingUsd > 0 && budget < goal.spentUsd + goal.pendingUsd) throw new Error('This allowance is already committed while billing is pending. Pause the goal; its held allowance is preserved.');
      if (patch.providerId !== undefined && !state.providers.some(p => p.id === patch.providerId)) throw new Error('Choose an available provider.');
      // Stop the old intent before accepting an edited intent or reduced allowance.
      if (jobs.has(goal.id) && (patch.text !== undefined || patch.providerId !== undefined || budget < goal.budgetUsd || patch.maxWorkers !== undefined || patch.agentsPerWorker !== undefined)) {
        const current = jobs.get(goal.id);
        await this.controlGoal(goal.id, 'pause');
        await current.promise;
      }
      if (patch.text !== undefined) goal.text = patch.text.trim();
      if (patch.providerId !== undefined) goal.providerId = patch.providerId;
      if (patch.privateH100 !== undefined) {
        goal.privateH100 = patch.privateH100;
        goal.providerId = patch.privateH100 ? 'private-h100' : (state.preferredProviderId !== 'private-h100' ? state.preferredProviderId : null) || null;
      }
      if (currencyBudget) goal.budget = currencyBudget;
      goal.maxWorkers = nextWorkers; goal.conversationsPerWorker = nextConversations; goal.agentsPerWorker = nextConversations - 1;
      goal.budgetUsd = budget; goal.updatedAt = now(); publish(); return copy(goal);
    },
    async controlGoal(goalId, action) {
      const goal = find(goalId);
      if (!['pause', 'resume', 'stop'].includes(action)) throw new Error('Choose pause, resume, or stop.');
      const job = jobs.get(goal.id);
      if (action === 'resume') {
        if (state.swarm.admissionPaused) throw new Error('The team is paused. Resume the team before this goal.');
        if (goal.recoveryHold) throw new Error('This interrupted run needs reconciliation. Its original records are preserved.');
        if (!['paused', 'queued'].includes(goal.status)) throw new Error('Only a paused or waiting goal can resume.');
        if (goal.spentUsd >= goal.budgetUsd) throw new Error('Increase the budget before resuming.');
        goal.status = 'queued'; publish(); start(goal);
      } else {
        if (goal.recoveryHold) throw new Error('This run has an uncertain outcome. Its recovery hold cannot be cleared by a stop button.');
        if (job) {
          goal.status = action === 'stop' ? 'stopping' : 'pausing';
          if (action === 'pause') job.pauseRequested = true;
          else job.controller.abort();
          publish();
          // Pausing returns promptly while the current accepted call settles.
          // Its next usage receipt fences dispatch before the next task.
          if (action === 'stop') await job.promise;
        }
        else if (!['completed', 'stopped', 'failed'].includes(goal.status)) { goal.status = action === 'stop' ? 'stopped' : 'paused'; publish(); }
      }
      return copy(goal);
    },
    async controlSwarm(action) {
      if (!['pause', 'resume', 'stop'].includes(action)) throw new Error('Choose pause, resume, or stop.');
      if (action === 'resume') {
        if (state.goals.some(g => g.recoveryHold)) throw new Error('An interrupted run needs reconciliation before the team can resume.');
        state.swarm.admissionPaused = false; publish();
        for (const goal of state.goals) {
          if (goal.status === 'paused' && goal.spentUsd < goal.budgetUsd) goal.status = 'queued';
          if (goal.status === 'queued') start(goal);
        }
      } else {
        state.swarm.admissionPaused = true; publish();
        await Promise.all(state.goals.filter(g => ['running', 'queued', 'paused'].includes(g.status)).map(g => this.controlGoal(g.id, action)));
      }
      return copy(state);
    },
    async wait(goalId) { await jobs.get(goalId)?.promise; return copy(find(goalId)); },
    async close() {
      if (closed) return;
      closed = true;
      await this.authCancel(); await speech.close();
      for (const [goalId, job] of jobs) { find(goalId).status = 'pausing'; job.controller.abort(); }
      await Promise.all([...jobs.values()].map(j => j.promise));
      await coordinator.close?.(); await manager.close?.(); persist();
      try { if (JSON.parse(readFileSync(lockPath, 'utf8')).owner === owner) unlinkSync(lockPath); } catch {}
      events.removeAllListeners();
    },
  };
}
