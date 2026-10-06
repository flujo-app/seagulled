import path from 'node:path';
import { homedir } from 'node:os';
import { Registry } from '@flujo-app/swarm-teams/fleet/registry.mjs';
import { boundFleetSource, fleetStatus, flyAccountLease, flyUnavailable, goalCapacity, runFleetLeaf } from './fleet.mjs';

export const TODD_PERSONA = `You are Todd, the lead of a bounded team: busy, blunt, dryly funny, and good at checking actual work. Translate the user's goal into concrete assignments, inspect the developer and reviewer results supplied to you, and revise the plan when evidence warrants it. The host application handles delegation. Do not invoke Codex collaboration, spawn agents, or attempt tool calls yourself; answer only with the requested JSON or prose. Never claim that a plan, fixture, estimate, or proposed change is a completed real-world action. State uncertainty and remaining work plainly. In user-facing prose name downloadable files by filename, without host paths, commands, or ports.`;

const MAX_CALLS = 6;
const PRIVATE_REQUEST_RESERVE_USD = 2.50;
const trim = (value, length = 64_000) => String(value ?? '').slice(0, length);
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const COMPANY_REASON = Object.freeze({
  source: 'The product-owned local source is unavailable for the company.',
  account: 'A verified personal Fly account is unavailable for the company.',
  provider: 'The selected provider has no verified company route.',
  capacity: 'The requested company size is outside the supported limits.',
  budget: 'The goal allowance cannot admit this company.',
  unavailable: 'The owned company is unavailable; no local substitute was run.',
});
const companyUnavailable = (reasonCode) => Object.assign(new Error(COMPANY_REASON[reasonCode]), {
  code: 'COMPANY_UNAVAILABLE', reasonCode, publicDetail: COMPANY_REASON[reasonCode], outcome: 'not_applied',
});
const companyStamp = (goal) => JSON.stringify({ id: goal.id, text: goal.text,
  providerId: goal.providerId, budgetUsd: goal.budgetUsd, spentUsd: goal.spentUsd,
  maxWorkers: goal.maxWorkers, conversationsPerWorker: goal.conversationsPerWorker,
  agentsPerWorker: goal.agentsPerWorker, privateH100: goal.privateH100,
  executionMode: goal.executionMode, workerTopologyVersion: goal.workerTopologyVersion });
const sameFlyAccount = (left, right) => left?.orgSlug === right?.orgSlug
  && left?.flyctlPath === right?.flyctlPath && left?.flyConfigDir === right?.flyConfigDir
  && left?.scope === right?.scope && left?.accountRef === right?.accountRef;
const sourceFields = Object.freeze(['cloudSdkRoot', 'sourceOrigin', 'sourceInstanceDir', 'sourceDataRoot', 'sourceAppRoot']);
const completeSourceBinding = (binding) => Boolean(binding
  && sourceFields.every((key) => typeof binding[key] === 'string' && binding[key]));
const sameSourceBinding = (left, right) => completeSourceBinding(left) && completeSourceBinding(right)
  && sourceFields.every((key) => left[key] === right[key]);
const companyTopologyMatches = (record, { maxWorkers, conversationsPerWorker, agentsPerWorker }) =>
  record?.requestedWorkers === maxWorkers
  && record?.requestedConversationsPerWorker === conversationsPerWorker
  && record?.requestedAgentsPerWorker === agentsPerWorker;
const companyIdentityMatches = (record, goal, capacity) => companyTopologyMatches(record, capacity)
  && record?.companyProviderId === goal.providerId && record?.text === goal.text
  && record?.workerTopologyVersion === goal.workerTopologyVersion;
const aborted = (signal) => {
  if (signal?.aborted) throw Object.assign(new Error('Goal execution was cancelled.'), { name: 'AbortError' });
};
const parseObject = (value) => {
  const text = String(value ?? '').trim();
  for (const candidate of [text, text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; }
    catch { /* The provider may answer in prose. */ }
  }
  return null;
};
const usageOf = (value) => {
  const usage = value && typeof value === 'object' ? value : {};
  const costUsd = finite(usage.costUsd) ? usage.costUsd : null;
  const costKind = ['reported', 'estimated', 'unknown', 'subscription'].includes(usage.costKind) ? usage.costKind : 'unknown';
  return {
    inputTokens: finite(usage.inputTokens) ? usage.inputTokens : 0,
    outputTokens: finite(usage.outputTokens) ? usage.outputTokens : 0,
    costUsd,
    costKind,
    ...(finite(usage.reservedUsd) ? { reservedUsd: usage.reservedUsd } : {}),
    ...(usage.billingPending === true ? { billingPending: true } : {}),
    ...(typeof usage.reservationId === 'string' && /^[\w-]{1,100}$/.test(usage.reservationId)
      ? { reservationId: usage.reservationId } : {}),
  };
};

/** Durable, bounded provider team. The registry is stored in the caller's private dataDir. */
export class SwarmCoordinator {
  constructor({ providers, onEvent = () => undefined, dataDir, fleet = 'off', fleetRunner = runFleetLeaf,
    sourceBinding, sourceProvider, sourceInspector = boundFleetSource, readyInspector = fleetStatus } = {}) {
    if (!providers || typeof providers.run !== 'function') throw new Error('SwarmCoordinator needs a ProviderManager.');
    this.providers = providers;
    this.onEvent = onEvent;
    this.dataDir = dataDir ?? path.join(homedir(), '.seagulled');
    this.fleet = fleet;
    this.fleetRunner = fleetRunner;
    this.sourceBinding = sourceBinding && typeof sourceBinding === 'object'
      ? Object.freeze({ ...sourceBinding }) : null;
    this.sourceProvider = sourceProvider ?? (async () => this.sourceBinding);
    this.sourceInspector = sourceInspector;
    this.readyInspector = readyInspector;
    this.companySources = new Map();
    this.companyAdmissions = new Map();
    this.registry = new Registry(path.join(this.dataDir, 'swarm', 'registry.json'));
    this.active = new Set();
  }

  emit(event) { this.onEvent(event); }
  async fleetStatus(providerId, goalId) {
    const fleetRoute = typeof this.providers.fleetRoute === 'function'
      ? await this.providers.fleetRoute(providerId, goalId) : { available: false };
    const flyAccount = fleetRoute.available === true ? await flyAccountLease(this.providers) : null;
    if (fleetRoute.available === true && !flyAccount) return { available: false, detail: flyUnavailable };
    return fleetStatus({ dataDir: this.dataDir, providerId, goalId, fleetRoute, flyAccount,
      sourceBinding: this.sourceBinding });
  }

  /** Two read-only stages. The returned leases remain backend-only and are never persisted. */
  async prepareCompany(goal, { signal, stage, priorAdmission } = {}) {
    if (!goal || typeof goal.id !== 'string' || !/^[\w-]{1,100}$/.test(goal.id)
      || goal.executionMode !== 'company' || ![2, 3].includes(goal.workerTopologyVersion)
      || typeof goal.providerId !== 'string' || !goal.providerId) throw companyUnavailable('unavailable');
    if (Object.values(this.registry.state.runs).some((run) => run.goalId === goal.id
      && ['running', 'unknown'].includes(run.state))) {
      throw Object.assign(new Error('This goal has an uncertain provider call. Inspect its saved task before starting more work.'),
        { code: 'UNKNOWN', unknown: true });
    }
    const priorGoal = this.registry.state.goals[goal.id];
    if (priorGoal && (priorGoal.executionMode !== 'company' || priorGoal.workerTopologyVersion !== goal.workerTopologyVersion)) {
      throw companyUnavailable('unavailable');
    }
    let capacity;
    try { capacity = goalCapacity(goal); }
    catch { throw companyUnavailable('capacity'); }
    if (priorGoal && !companyIdentityMatches(priorGoal, goal, capacity)
      && (priorGoal.state === 'done' || Object.values(this.registry.state.runs).some((run) =>
        run.goalId === goal.id && run.sandbox?.kind === 'fly'))) throw companyUnavailable('unavailable');
    if (!finite(goal.budgetUsd) || !finite(goal.spentUsd ?? 0)
      || goal.budgetUsd <= (goal.spentUsd ?? 0)) throw companyUnavailable('budget');
    aborted(signal);
    if (this.fleet !== 'auto') throw companyUnavailable('unavailable');
    if (stage === 'source') {
      this.companySources.delete(goal.id);
      this.companyAdmissions.delete(goal.id);
      const flyAccount = await flyAccountLease(this.providers, signal);
      aborted(signal);
      if (!flyAccount) throw companyUnavailable('account');
      let supplied;
      try { supplied = await this.sourceProvider({ goalId: goal.id, signal }); }
      catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') { aborted(signal); throw error; }
        throw companyUnavailable('source');
      }
      aborted(signal);
      let checked;
      try { checked = await this.sourceInspector({ dataDir: this.dataDir, sourceBinding: supplied,
        flyAccount, signal, deadlineAt: Date.now() + 30_000 }); }
      catch (error) {
        aborted(signal);
        if (error?.name === 'AbortError') throw error;
        throw companyUnavailable('source');
      }
      aborted(signal);
      if (!checked?.available || !completeSourceBinding(checked.binding)
        || checked.binding.sourceOrigin !== supplied?.sourceOrigin) {
        throw companyUnavailable('source');
      }
      const lease = Object.freeze({ kind: 'company-source', goalId: goal.id, providerId: goal.providerId,
        sourceBinding: Object.freeze({ ...checked.binding }), flyAccount: Object.freeze({ ...flyAccount }) });
      this.companySources.set(goal.id, lease);
      return lease;
    }
    if (stage !== 'ready') throw companyUnavailable('unavailable');
    const sourceLease = this.companySources.get(goal.id);
    if (!sourceLease || sourceLease !== priorAdmission || sourceLease.providerId !== goal.providerId) {
      throw companyUnavailable('source');
    }
    this.companyAdmissions.delete(goal.id);
    const flyAccount = await flyAccountLease(this.providers, signal);
    aborted(signal);
    if (!flyAccount || !sameFlyAccount(flyAccount, sourceLease.flyAccount)) throw companyUnavailable('account');
    let source;
    try { source = await this.sourceInspector({ dataDir: this.dataDir,
      sourceBinding: sourceLease.sourceBinding, flyAccount, signal, deadlineAt: Date.now() + 30_000 }); }
    catch (error) {
      aborted(signal);
      if (error?.name === 'AbortError') throw error;
      throw companyUnavailable('source');
    }
    aborted(signal);
    if (!source?.available || !sameSourceBinding(source.binding, sourceLease.sourceBinding)) {
      throw companyUnavailable('source');
    }
    let route;
    try { route = await this.providers.fleetRoute?.(goal.providerId, goal.id); }
    catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') { aborted(signal); throw error; }
      throw companyUnavailable('provider');
    }
    aborted(signal);
    if (route?.available !== true || route.providerId !== goal.providerId
      || goal.providerId === 'private-h100' && route.leaseGoalId !== goal.id) {
      throw companyUnavailable('provider');
    }
    let state;
    try { state = await this.readyInspector({ dataDir: this.dataDir, providerId: goal.providerId,
      goalId: goal.id, fleetRoute: route, flyAccount, sourceBinding: sourceLease.sourceBinding,
      signal, deadlineAt: Date.now() + 30_000 }); }
    catch (error) {
      aborted(signal);
      if (error?.name === 'AbortError') throw error;
      throw companyUnavailable('provider');
    }
    aborted(signal);
    if (!state.available || typeof route.model?.name !== 'string' || !route.model.name) {
      throw companyUnavailable('provider');
    }
    const verifiedModel = state.modelIdentityVerified === true && /^[\w./:-]{1,160}$/.test(route.model.name)
      ? Object.freeze({ providerId: goal.providerId, name: route.model.name }) : null;
    const lease = Object.freeze({ kind: 'company-ready', goalId: goal.id, stamp: companyStamp(goal),
      sourceBinding: sourceLease.sourceBinding, flyAccount: sourceLease.flyAccount,
      ...(verifiedModel ? { verifiedModel } : {}),
      fleetRoute: Object.freeze({ ...route, model: Object.freeze({ ...route.model }) }) });
    this.companyAdmissions.set(goal.id, lease);
    return lease;
  }

  tasks(goalId) {
    return Object.values(this.registry.state.runs).filter((run) => run.goalId === goalId).map((run) => ({
      id: run.id, role: run.role ?? this.registry.worker(run.workerId).role, status: run.state,
      text: run.task, ...(run.prompt ? { prompt: run.prompt } : {}), ...(run.output ? { result: run.output } : {}),
      ...(run.artifacts ? { artifacts: run.artifacts } : {}), ...(run.workspace ? { workspace: run.workspace } : {}),
      ...(run.sandbox ? { sandbox: run.sandbox } : {}),
      ...(run.error ? { error: run.error } : {}),
    }));
  }

  summary(goalId, text) {
    const calls = Object.values(this.registry.state.runs).filter((run) => run.goalId === goalId && run.usage).map((run) => run.usage);
    const kinds = new Set(calls.map((usage) => usage.costKind));
    return { text, completed: this.registry.goal(goalId).completed !== false, usage: {
      inputTokens: calls.reduce((sum, usage) => sum + usage.inputTokens, 0),
      outputTokens: calls.reduce((sum, usage) => sum + usage.outputTokens, 0),
      costUsd: calls.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0),
      costKind: kinds.size === 1 ? [...kinds][0] : 'unknown',
    }, tasks: this.tasks(goalId) };
  }

  /** Terminal company history requires the completed original Worker hierarchy receipt. */
  companyProof(goalId, record) {
    return Object.values(this.registry.state.runs).some((run) => {
      const sandbox = run.sandbox;
      const workers = sandbox?.workerCount;
      const strict = record.workerTopologyVersion === 3;
      return run.goalId === goalId && run.role === 'developer' && run.state === 'completed'
        && sandbox?.kind === 'fly' && sandbox.verification === (strict ? 'original-worker-hierarchy-v2' : 'original-worker-hierarchy-v1')
        && (!strict || sandbox.childCompletionVerified === true)
        && sandbox.retired === true && sandbox.cleanupConfirmed === true
        && sandbox.bootCleanupConfirmed === true && sandbox.relayCleanupConfirmed === true
        && sandbox.relayUsed === (record.requestedWorkers > 1)
        && Number.isInteger(workers) && workers >= record.requestedWorkers
        && workers <= (strict ? record.requestedWorkers : sandbox.relayUsed ? Math.min(12, 2 * record.requestedWorkers) : record.requestedWorkers)
        && sandbox.initialWorkerCount === record.requestedWorkers
        && sandbox.localConversationCount === workers * record.requestedAgentsPerWorker
        && sandbox.conversationCountVerified === workers * record.requestedConversationsPerWorker
        && Array.isArray(sandbox.teamLeadRuns) && sandbox.teamLeadRuns.length === record.requestedWorkers
        && sandbox.teamLeadRuns.every((id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id))
        && new Set(sandbox.teamLeadRuns).size === record.requestedWorkers;
    });
  }

  providerAvailable(providerId) {
    const state = this.providers.publicState?.();
    if (!Array.isArray(state)) return;
    const provider = state.find((entry) => entry.id === providerId);
    if (provider && provider.available === false) throw new Error(`${provider.name ?? providerId} is unavailable: ${provider.detail ?? 'connect a supported provider first.'}`);
    if (provider && provider.connected === false) throw new Error(`${provider.name ?? providerId} is not connected.`);
  }

  /** A new execution never replays a previously accepted provider call. */
  async execute({ goal, signal, admission } = {}) {
    if (!goal || typeof goal.id !== 'string' || !/^[\w-]{1,100}$/.test(goal.id) || !trim(goal.text).trim()) throw new Error('A goal id and text are required.');
    if (goal.text.length > 10_000) throw new Error('This goal is too long for the connected provider. Shorten it to 10,000 characters.');
    if (!finite(goal.budgetUsd) || goal.budgetUsd <= 0 || !finite(goal.spentUsd ?? 0)) throw new Error('A positive goal budget and valid spend are required.');
    if (!goal.providerId) throw new Error('Connect a provider before starting this goal.');
    const { maxWorkers, conversationsPerWorker, agentsPerWorker } = goalCapacity(goal);
    const company = goal.executionMode === 'company' && [2, 3].includes(goal.workerTopologyVersion);
    if (this.active.has(goal.id)) throw new Error('This goal is already running.');
    const saved = this.registry.state.goals[goal.id];
    const priorRuns = Object.values(this.registry.state.runs).filter((run) => run.goalId === goal.id);
    if (priorRuns.some((run) => ['running', 'unknown'].includes(run.state))) {
      throw Object.assign(new Error('This goal has an uncertain provider call. Inspect its saved task before starting more work.'), { code: 'UNKNOWN', unknown: true });
    }
    if (company && saved && (saved.executionMode !== 'company' || saved.workerTopologyVersion !== goal.workerTopologyVersion)
      || !company && saved?.executionMode === 'company') throw companyUnavailable('unavailable');
    if (saved?.state === 'done') {
      if (company && (!companyIdentityMatches(saved, goal, { maxWorkers, conversationsPerWorker, agentsPerWorker })
        || !this.companyProof(goal.id, saved))) throw companyUnavailable('unavailable');
      return this.summary(goal.id, saved.result);
    }
    if (goal.executionMode !== undefined && !['company', 'local'].includes(goal.executionMode)
      || goal.executionMode === 'company' && !company
      || [2, 3].includes(goal.workerTopologyVersion) && !['company', 'local'].includes(goal.executionMode)) {
      throw companyUnavailable('unavailable');
    }
    if (company) {
      if (saved && !companyIdentityMatches(saved, goal, { maxWorkers, conversationsPerWorker, agentsPerWorker })
        && priorRuns.some((run) => run.sandbox?.kind === 'fly')) throw companyUnavailable('unavailable');
      if (!admission || admission !== this.companyAdmissions.get(goal.id)
        || admission.kind !== 'company-ready' || admission.goalId !== goal.id
        || admission.stamp !== companyStamp(goal)) throw companyUnavailable('unavailable');
      this.companyAdmissions.delete(goal.id);
      this.companySources.delete(goal.id);
    }
    try { this.providerAvailable(goal.providerId); }
    catch (error) { if (company) throw companyUnavailable('provider'); throw error; }
    aborted(signal);
    if (goal.spentUsd >= goal.budgetUsd) throw new Error('The goal budget is exhausted.');

    const record = saved ?? this.registry.createGoal({ id: goal.id, text: goal.text, limits: {
      maxWorkers, maxChildren: maxWorkers, maxDepth: 1, maxActiveRuns: 1,
    } });
    if (!saved) {
      record.executionMode = company ? 'company' : 'local';
      record.workerTopologyVersion = goal.workerTopologyVersion ?? 1;
      if (company) {
        record.companyProviderId = goal.providerId;
        record.requestedWorkers = maxWorkers;
        record.requestedConversationsPerWorker = conversationsPerWorker;
        record.requestedAgentsPerWorker = agentsPerWorker;
      }
      this.registry.save();
    }
    if (saved && company && !companyIdentityMatches(record, goal, { maxWorkers, conversationsPerWorker, agentsPerWorker })) {
      record.companyProviderId = goal.providerId;
      record.requestedWorkers = maxWorkers;
      record.requestedConversationsPerWorker = conversationsPerWorker;
      record.requestedAgentsPerWorker = agentsPerWorker;
      this.registry.save();
    }
    if (saved && (record.limits.maxWorkers !== maxWorkers || record.limits.maxChildren !== maxWorkers)) {
      record.limits.maxWorkers = maxWorkers; record.limits.maxChildren = maxWorkers; this.registry.save();
    }
    if (saved && saved.text !== goal.text) {
      record.text = goal.text; record.revision = (record.revision ?? 1) + 1;
      record.editedAt = Date.now(); this.registry.save();
    }
    let leader = Object.values(this.registry.state.workers).find((worker) => worker.goalId === goal.id && worker.depth === 0);
    if (!leader) {
      leader = this.registry.reserve({ goalId: record.id, role: 'lead', name: 'Todd' }).worker;
      this.registry.enroll(leader.id, { kind: 'provider', providerId: goal.providerId });
    }
    if (leader.target?.providerId !== goal.providerId) this.registry.enroll(leader.id, { kind: 'provider', providerId: goal.providerId });
    this.active.add(goal.id);
    let spent = Math.max(goal.spentUsd, priorRuns.reduce((sum, run) =>
      sum + (finite(run.usage?.costUsd) && ['reported', 'estimated'].includes(run.usage?.costKind) ? run.usage.costUsd : 0), 0));
    let calls = priorRuns.length;
    let uncertainSpend = priorRuns.some((run) => run.usage?.costKind === 'unknown'
      || run.usage && run.usage.costUsd === null && run.usage.costKind !== 'subscription');
    let fleetUsed = priorRuns.some((run) => run.sandbox?.kind === 'fly');

    const call = async (role, task, prompt) => {
      aborted(signal);
      if (uncertainSpend && !['codex', 'claude'].includes(goal.providerId)) {
        throw Object.assign(new Error('Provider or cloud spend is unknown; additional paid work is held.'), { code: 'UNKNOWN', unknown: true });
      }
      if (calls >= MAX_CALLS) throw new Error('The task limit has been reached.');
      if (prompt.length > 16_000) throw new Error('The provider prompt is too long; shorten the goal or task.');
      const remaining = goal.budgetUsd - spent;
      if (remaining <= 0) throw new Error('The goal budget is exhausted.');
      this.providerAvailable(goal.providerId);
      let worker = leader;
      if (role !== 'lead') {
        worker = this.registry.reserve({ goalId: goal.id, parentId: leader.id, role, name: role }).worker;
        this.registry.enroll(worker.id, { kind: 'provider', providerId: goal.providerId });
      }
      const run = this.registry.startRun({ workerId: worker.id, startedBy: leader.id, task, flowName: 'provider' });
      run.role = role;
      run.prompt = prompt;
      this.registry.save();
      calls++;
      this.emit({ type: 'task', goalId: goal.id, task: { id: run.id, role, status: 'running',
        phase: role === 'reviewer' ? 'reviewing' : 'working', text: task, prompt } });
      let privateRequestReserved = false;
      try {
        // Stream usage is deliberately ignored here. Only the terminal receipt is counted.
        let result;
        if (role === 'developer' && company) {
          if (fleetUsed) throw companyUnavailable('unavailable');
          const route = admission.fleetRoute;
          if (route?.available === true && route.providerId === goal.providerId) {
            const remoteGoal = { ...goal, maxWorkers, agentsPerWorker,
              ...(conversationsPerWorker <= 10 ? { conversationsPerWorker } : {}) };
            const remote = await this.fleetRunner({ goal: remoteGoal, task: `ASSIGNMENT:\n${task}\n\nWork in your isolated sandbox. Report what was actually run and checked, plus paths and limits.`,
              dataDir: this.dataDir, signal, maxUsd: remaining, fleetRoute: route,
              flyAccount: admission.flyAccount,
              assertFlyAccountCurrent: (lease, { signal: currentSignal } = {}) => {
                if (typeof this.providers.assertFlyAccountLeaseCurrent !== 'function') {
                  throw companyUnavailable('account');
                }
                return this.providers.assertFlyAccountLeaseCurrent(
                  { available: true, ...lease }, { signal: currentSignal });
              },
              sourceBinding: admission.sourceBinding,
              reservationId: `${run.id}-fly`,
              reserveCloud: (reservation) => this.emit({ type: 'reservation', goalId: goal.id, reservation }),
              onCompany: ({ verifiedWorkers, verifiedChildConversations }) => this.emit({ type: 'company',
                goalId: goal.id, verifiedWorkers, verifiedChildConversations }),
              onStatus: (text) => this.emit({ type: 'task', goalId: goal.id,
                task: { id: run.id, role, status: 'running', phase: trim(text, 200) } }) });
            if (remote?.available !== true) throw companyUnavailable('unavailable');
            result = remote; fleetUsed = true;
          } else throw companyUnavailable('provider');
        }
        if (!result) {
          if (goal.providerId === 'private-h100') {
            if (remaining < PRIVATE_REQUEST_RESERVE_USD) throw Object.assign(
              new Error('The remaining allowance cannot admit a private H100 request.'), { outcome: 'not_applied' });
            privateRequestReserved = true;
            this.emit({ type: 'reservation', goalId: goal.id,
              reservation: { id: run.id, amountUsd: PRIVATE_REQUEST_RESERVE_USD } });
          }
          result = await this.providers.run({ providerId: goal.providerId, prompt, signal, maxUsd: remaining,
            goalId: goal.id, requestId: goal.providerId === 'private-h100' ? run.id : undefined,
            role, onEvent: () => undefined });
        }
        const usage = usageOf({ ...result?.usage,
          ...(privateRequestReserved ? { reservationId: run.id,
            ...(!finite(result?.usage?.costUsd) ? { reservedUsd: PRIVATE_REQUEST_RESERVE_USD,
              billingPending: true } : {}) } : {}) });
        if (usage.costKind === 'unknown' || usage.costUsd === null && usage.costKind !== 'subscription') uncertainSpend = true;
        if (usage.costUsd !== null) spent += usage.costUsd;
        this.registry.settleRun(run.id, { status: 'completed', output: result?.text, usage });
        if (Array.isArray(result?.artifacts)) run.artifacts = result.artifacts;
        if (typeof result?.workspace === 'string') run.workspace = result.workspace;
        if (result?.sandbox) run.sandbox = result.sandbox;
        this.registry.save();
        this.emit({ type: 'task', goalId: goal.id, task: { id: run.id, role, status: 'completed', text: task,
          result: trim(result?.text, 200_000), ...(run.artifacts ? { artifacts: run.artifacts } : {}),
          ...(run.workspace ? { workspace: run.workspace } : {}), ...(run.sandbox ? { sandbox: run.sandbox } : {}) } });
        this.emit({ type: 'usage', goalId: goal.id, usage: { ...usage, taskId: run.id } });
        const text = trim(result?.text, 200_000);
        if (role === 'lead') {
          const parsed = parseObject(text);
          const leadMessage = task === 'Plan the goal'
            ? parsed?.done === true ? parsed.response || text : parsed?.response || 'I have a bounded task for the team.'
            : parsed?.response || text;
          this.emit({ type: 'message', goalId: goal.id, role: 'todd', text: trim(leadMessage, 10_000) });
        } else this.emit({ type: 'message', goalId: goal.id, role, text: trim(text, 10_000) });
        return text;
      } catch (error) {
        const known = ['not_applied', 'failed'].includes(error?.outcome) || error?.code === 'PROVIDER_UNAVAILABLE';
        const status = known ? 'failed' : 'unknown';
        const pendingReservation = error?.reservation?.kind === 'estimated-upper'
          && finite(error.reservation.amountUsd) ? error.reservation.amountUsd
          : privateRequestReserved ? PRIVATE_REQUEST_RESERVE_USD : null;
        const usage = error?.usage || pendingReservation !== null
          ? usageOf({ ...error.usage, ...(pendingReservation !== null ? {
            costUsd: error?.outcome === 'not_applied' ? 0 : null,
            costKind: error?.outcome === 'not_applied' ? 'estimated' : 'unknown',
            ...(error?.outcome === 'not_applied' ? {} : { reservedUsd: pendingReservation, billingPending: true }),
            reservationId: run.id,
          } : {}) }) : undefined;
        this.registry.settleRun(run.id, { status, output: '', error: trim(error.message, 500), usage });
        this.emit({ type: 'task', goalId: goal.id, task: { id: run.id, role, status, text: task } });
        if (usage) { this.emit({ type: 'usage', goalId: goal.id, usage: { ...usage, taskId: run.id } }); error.usageRecorded = true; }
        if (status === 'unknown') { error.code = 'UNKNOWN'; error.unknown = true; }
        throw error;
      } finally {
        if (role !== 'lead') this.registry.retire(worker.id);
      }
    };

    const finish = (answer, completed = true) => {
      if (company && !this.companyProof(goal.id, this.registry.goal(goal.id))) throw companyUnavailable('unavailable');
      this.registry.finishGoal(goal.id, trim(answer, 200_000));
      if (!completed) { this.registry.goal(goal.id).completed = false; this.registry.save(); }
      return this.summary(goal.id, this.registry.goal(goal.id).result);
    };
    try {
      while (true) {
        aborted(signal);
        const complete = Object.values(this.registry.state.runs).filter((run) => run.goalId === goal.id && run.state === 'completed');
        const last = complete.at(-1);
        if (!last) {
          const context = trim((goal.context ?? []).slice(-4).map((item) => `${item.role}: ${item.text}`).join('\n'), 1500);
          await call('lead', 'Plan the goal', `${TODD_PERSONA}\n\nGOAL:\n${goal.text}\n\nRECENT CONVERSATION:\n${context || 'None.'}\n\nReturn JSON with {"done":boolean,"response":"...","tasks":[{"role":"developer","task":"specific work"}]}. Set done true only if the goal can be answered fully now. Otherwise propose one bounded task. No claims of execution before work has happened.`);
          continue;
        }
        if (last.task === 'Plan the goal') {
          const plan = parseObject(last.output);
          if (plan?.done === true && !company) return finish(plan.response || last.output);
          const assignment = trim(company && plan?.done === true ? goal.text : plan?.tasks?.[0]?.task || goal.text, 2000);
          await call('developer', assignment, `You are a developer delegated by Todd. Work on this bounded assignment and report concrete output, evidence, limits, and remaining work.\n\nGOAL:\n${goal.text}\n\nASSIGNMENT:\n${assignment}`);
          continue;
        }
        if (last.role === 'developer') {
          if (calls >= MAX_CALLS) return finish(`The task limit was reached before review. Developer result:\n${last.output}`, false);
          const priorCritique = complete.find((run) => run.task === 'Critique cycle 1');
          if (priorCritique) {
            await call('lead', 'Final critique', `${TODD_PERSONA}\n\nGOAL:\n${goal.text}\n\nFIRST CRITIQUE:\n${trim(priorCritique.output, 1500)}\n\nCORRECTIVE DEVELOPER OUTPUT:\n${trim(last.output, 2500)}\n\nInspect the correction against the earlier reviewer findings. Return JSON {"done":boolean,"response":"user-facing result with evidence and remaining limits"}. If unverified, set done false. No further task capacity remains.`);
            continue;
          }
          await call('reviewer', `Review: ${last.task}`, `You are Todd's reviewer. Check the developer's actual output against the goal. Inspect files in the shared workspace and compare any artifact hashes, if supplied. Name defects, unsupported claims, and next work. Do not call fixture execution a live run.\n\nGOAL:\n${goal.text}\n\nDEVELOPER OUTPUT:\n${trim(last.output, 2500)}\n\nWORKSPACE:\n${trim(last.workspace, 300)}\n\nARTIFACT RECEIPTS:\n${trim(JSON.stringify(last.artifacts ?? []), 1000)}`);
          continue;
        }
        if (last.role === 'reviewer') {
          if (calls >= MAX_CALLS) return finish(`The bounded team reached its task limit. Final review:\n${last.output}`, false);
          const development = complete.at(-2);
          await call('lead', 'Critique cycle 1', `${TODD_PERSONA}\n\nGOAL:\n${goal.text}\n\nASSIGNMENT:\n${development?.task ?? goal.text}\n\nDEVELOPER OUTPUT:\n${trim(development?.output, 1500)}\n\nREVIEW:\n${trim(last.output, 1500)}\n\nCritique the actual outputs. Return JSON {"done":boolean,"response":"user-facing answer with evidence and limits","nextTask":"specific corrective work if needed"}. Stop if the goal is complete or task capacity is insufficient.`);
          continue;
        }
        if (last.task === 'Critique cycle 1') {
          const critique = parseObject(last.output);
          const answer = critique?.response || last.output;
          if (critique?.done === true) return finish(answer);
          if (calls >= MAX_CALLS - 1) return finish(answer, false);
          const assignment = trim(critique?.nextTask || 'Address the reviewer findings.', 2000);
          await call('developer', assignment, `You are Todd's developer. Address this corrective task. Report concrete output, evidence, limits, and remaining work.\n\nGOAL:\n${goal.text}\n\nTASK:\n${assignment}\n\nLEAD CRITIQUE:\n${trim(last.output, 1200)}`);
          continue;
        }
        if (last.task === 'Final critique') {
          const critique = parseObject(last.output);
          return finish(critique?.response || last.output, critique?.done === true);
        }
        return finish(`The bounded team stopped after this result:\n${last.output}`, false);
      }
    } finally { this.active.delete(goal.id); }
  }
}
