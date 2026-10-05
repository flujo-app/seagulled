import path from 'node:path';
import { homedir } from 'node:os';
import { Registry } from '../../upstream/swarm-teams/fleet/registry.mjs';
import { fleetStatus, runFleetLeaf } from './fleet.mjs';

export const TODD_PERSONA = `You are Todd, the lead of a bounded team: busy, blunt, dryly funny, and good at checking actual work. Translate the user's goal into concrete assignments, inspect the developer and reviewer results supplied to you, and revise the plan when evidence warrants it. The host application handles delegation. Do not invoke Codex collaboration, spawn agents, or attempt tool calls yourself; answer only with the requested JSON or prose. Never claim that a plan, fixture, estimate, or proposed change is a completed real-world action. State uncertainty and remaining work plainly. In user-facing prose name downloadable files by filename, without host paths, commands, or ports.`;

const MAX_CALLS = 6;
const trim = (value, length = 64_000) => String(value ?? '').slice(0, length);
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
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
  };
};

/** Durable, bounded provider team. The registry is stored in the caller's private dataDir. */
export class SwarmCoordinator {
  constructor({ providers, onEvent = () => undefined, dataDir, fleet = 'off', fleetRunner = runFleetLeaf } = {}) {
    if (!providers || typeof providers.run !== 'function') throw new Error('SwarmCoordinator needs a ProviderManager.');
    this.providers = providers;
    this.onEvent = onEvent;
    this.dataDir = dataDir ?? path.join(homedir(), '.seagulled');
    this.fleet = fleet;
    this.fleetRunner = fleetRunner;
    this.registry = new Registry(path.join(this.dataDir, 'swarm', 'registry.json'));
    this.active = new Set();
  }

  emit(event) { this.onEvent(event); }
  fleetStatus() { return fleetStatus({ dataDir: this.dataDir }); }

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

  providerAvailable(providerId) {
    const state = this.providers.publicState?.();
    if (!Array.isArray(state)) return;
    const provider = state.find((entry) => entry.id === providerId);
    if (provider && provider.available === false) throw new Error(`${provider.name ?? providerId} is unavailable: ${provider.detail ?? 'connect a supported provider first.'}`);
    if (provider && provider.connected === false) throw new Error(`${provider.name ?? providerId} is not connected.`);
  }

  /** A new execution never replays a previously accepted provider call. */
  async execute({ goal, signal } = {}) {
    if (!goal || typeof goal.id !== 'string' || !/^[\w-]{1,100}$/.test(goal.id) || !trim(goal.text).trim()) throw new Error('A goal id and text are required.');
    if (goal.text.length > 10_000) throw new Error('This goal is too long for the connected provider. Shorten it to 10,000 characters.');
    if (!finite(goal.budgetUsd) || goal.budgetUsd <= 0 || !finite(goal.spentUsd ?? 0)) throw new Error('A positive goal budget and valid spend are required.');
    if (!goal.providerId) throw new Error('Connect a provider before starting this goal.');
    const maxWorkers = Math.min(Math.max(Number.isInteger(goal.maxWorkers) ? goal.maxWorkers : 2, 1), 6);
    if (this.active.has(goal.id)) throw new Error('This goal is already running.');
    const saved = this.registry.state.goals[goal.id];
    if (saved?.state === 'done') return this.summary(goal.id, saved.result);
    const priorRuns = Object.values(this.registry.state.runs).filter((run) => run.goalId === goal.id);
    if (priorRuns.some((run) => ['running', 'unknown'].includes(run.state))) {
      throw Object.assign(new Error('This goal has an uncertain provider call. Inspect its saved task before starting more work.'), { code: 'UNKNOWN', unknown: true });
    }
    this.providerAvailable(goal.providerId);
    aborted(signal);
    if (goal.spentUsd >= goal.budgetUsd) throw new Error('The goal budget is exhausted.');

    const record = saved ?? this.registry.createGoal({ id: goal.id, text: goal.text, limits: {
      maxWorkers, maxChildren: maxWorkers, maxDepth: 1, maxActiveRuns: 1,
    } });
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
      this.emit({ type: 'task', goalId: goal.id, task: { id: run.id, role, status: 'running', text: task, prompt } });
      try {
        // Stream usage is deliberately ignored here. Only the terminal receipt is counted.
        let result;
        if (role === 'developer' && this.fleet === 'auto' && !fleetUsed) {
          const remote = await this.fleetRunner({ goal, task: `ASSIGNMENT:\n${task}\n\nWork in your isolated sandbox. Report what was actually run and checked, plus paths and limits.`,
            dataDir: this.dataDir, signal, maxUsd: remaining,
            onStatus: (text) => this.emit({ type: 'task', goalId: goal.id,
              task: { id: run.id, role, status: 'running', phase: trim(text, 200) } }) });
          if (remote.available) { result = remote; fleetUsed = true; }
        }
        if (!result) result = await this.providers.run({ providerId: goal.providerId, prompt, signal, maxUsd: remaining,
          goalId: goal.id, role, onEvent: () => undefined });
        const usage = usageOf(result?.usage);
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
        const usage = error?.usage ? usageOf(error.usage) : undefined;
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
          if (plan?.done === true) return finish(plan.response || last.output);
          const assignment = trim(plan?.tasks?.[0]?.task || goal.text, 2000);
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
          const assignment = trim(critique.nextTask || 'Address the reviewer findings.', 2000);
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
