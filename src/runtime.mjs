import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ProviderManager } from './providers/index.mjs';
import { SwarmCoordinator } from './swarm/index.mjs';

export const defaultDataDir = () => process.env.SEAGULLED_HOME || path.join(homedir(), '.seagulled');
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID()}`;
const copy = (value) => structuredClone(value);
function amount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) throw new Error('Choose a budget greater than $0 and at most $100,000.');
  return Math.round(n * 1000000) / 1000000;
}

export function createRuntime({ dataDir = defaultDataDir(), providers, swarm } = {}) {
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
  const manager = providers || new ProviderManager({ dataDir: path.join(dataDir, 'providers') });
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
  function recordUsage(goal, usage = {}) {
    const cost = usage.costUsd;
    const monetary = Number.isFinite(cost) && cost >= 0;
    const suppliedKind = usage.costKind;
    const kind = suppliedKind === 'subscription' ? 'subscription'
      : monetary && ['reported', 'estimated'].includes(suppliedKind) ? suppliedKind : 'unknown';
    if (Number.isFinite(usage.reservedUsd) && usage.reservedUsd > 0) {
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
  function start(goal) {
    if (closed || jobs.has(goal.id) || goal.recoveryHold || goal.status !== 'queued') return;
    if (state.swarm.admissionPaused) { goal.error = 'The team is paused. Resume the team to start new work.'; publish(); return; }
    if (state.goals.some(g => g.recoveryHold)) { goal.error = 'A previous run needs reconciliation. New work is held.'; publish(); return; }
    const selectedId = goal.providerId || state.preferredProviderId;
    const provider = state.providers.find(p => p.connected && p.available && (!selectedId || p.id === selectedId));
    if (!provider) { goal.error = 'Connect a provider and I’ll get the team started.'; publish(); return; }
    goal.providerId = provider.id;
    goal.error = undefined; goal.status = 'running'; goal.updatedAt = now();
    const controller = new AbortController();
    const job = { controller, usageEvents: 0, promise: null };
    jobs.set(goal.id, job); publish();
    job.promise = (async () => {
      try {
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
          if (!state.conversation.some(m => m.goalId === goal.id && m.text === result.text)) message('todd', result.text || 'The team has wrapped up. Open the goal to review their work.', goal.id);
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
      } finally { jobs.delete(goal.id); goal.updatedAt = now(); publish(); }
    })();
  }
  persist();
  return {
    dataDir,
    snapshot: () => copy(state),
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
      if (!state.providers.length) await this.discover();
      const goal = { id: id('goal'), text: text.trim(), status: 'queued', budgetUsd: amount(options.budgetUsd ?? 5), spentUsd: 0,
        providerId: options.providerId || state.preferredProviderId || null, maxWorkers: 6, tasks: [], createdAt: now(), updatedAt: now(),
        context: state.conversation.slice(-12).map(m => ({ role: m.role, text: m.text })) };
      state.goals.push(goal); message('user', goal.text, goal.id);
      message('todd', state.providers.some(p => p.available && p.connected) ? 'Got it. I’m putting the team on this. I’ll check what they bring back.' : 'Got it. Connect your provider once and I’ll put the team on this.', goal.id);
      publish(); start(goal); return copy(goal);
    },
    async updateGoal(goalId, patch) {
      const goal = find(goalId);
      if (!patch || typeof patch !== 'object' || Object.keys(patch).some(k => !['text', 'budgetUsd', 'providerId'].includes(k))) throw new Error('You can edit the goal, budget, and provider.');
      if (patch.text !== undefined) {
        if (typeof patch.text !== 'string' || !patch.text.trim() || patch.text.length > 50000) throw new Error('Enter a goal in 1–50,000 characters.');
      }
      const budget = patch.budgetUsd !== undefined ? amount(patch.budgetUsd) : goal.budgetUsd;
      if (goal.pendingUsd > 0 && budget < goal.spentUsd + goal.pendingUsd) throw new Error('This allowance is already committed while billing is pending. Pause the goal; its held allowance is preserved.');
      if (patch.providerId !== undefined && !state.providers.some(p => p.id === patch.providerId)) throw new Error('Choose an available provider.');
      // Stop the old intent before accepting an edited intent or reduced allowance.
      if (jobs.has(goal.id) && (patch.text !== undefined || patch.providerId !== undefined || budget < goal.budgetUsd)) {
        const current = jobs.get(goal.id);
        await this.controlGoal(goal.id, 'pause');
        await current.promise;
      }
      if (patch.text !== undefined) goal.text = patch.text.trim();
      if (patch.providerId !== undefined) goal.providerId = patch.providerId;
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
      for (const [goalId, job] of jobs) { find(goalId).status = 'pausing'; job.controller.abort(); }
      await Promise.all([...jobs.values()].map(j => j.promise));
      await coordinator.close?.(); await manager.close?.(); persist();
      try { if (JSON.parse(readFileSync(lockPath, 'utf8')).owner === owner) unlinkSync(lockPath); } catch {}
      events.removeAllListeners();
    },
  };
}
