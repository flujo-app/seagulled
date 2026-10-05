// The Worker tree: who exists, who owns whom, and the caps that bound growth.
// One controller process owns this file; every change is written atomically.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const DEFAULT_LIMITS = Object.freeze({
  maxWorkers: 100,        // Workers per goal, excluding the supervisor
  maxDepth: 3,            // supervisor is depth 0
  maxChildren: 10,        // direct children per node
  maxActiveRuns: 10,      // parallel conversations per Worker
  maxBoardBytes: 16_000,  // one board post
});

export class FleetError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new FleetError(code, message, status); };
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const ACTIVE = ['reserved', 'ready'];
// Target secrets and private origins stay in the existing private Worker record.
// A run pins only a digest of its exact enrolled target before submission.
const targetDigest = (target) => createHash('sha256').update(JSON.stringify(target)).digest('hex');

export class Registry {
  constructor(path, { clock = Date.now } = {}) {
    this.path = path;
    this.clock = clock;
    mkdirSync(dirname(path), { recursive: true });
    try { this.state = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read the saved registry. Preserve it and reconcile before starting the controller.', { cause: error });
      this.state = { version: 1, goals: {}, workers: {}, runs: {}, board: [] };
    }
    if (this.state?.version !== 1 || !Array.isArray(this.state.board)
      || ['goals', 'workers', 'runs'].some((key) => !this.state[key] || typeof this.state[key] !== 'object' || Array.isArray(this.state[key]))) {
      throw new Error('Invalid saved registry. Preserve it and reconcile before starting the controller.');
    }
    // A run that was in flight when the controller stopped has an unknown outcome.
    for (const run of Object.values(this.state.runs)) {
      if (run.state === 'running') { run.state = 'unknown'; run.error = 'controller restarted during the run'; }
    }
    this.save();
  }

  save() {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  createGoal({ id = `g-${randomUUID().slice(0, 8)}`, text, limits = {} }) {
    if (typeof text !== 'string' || !text.trim()) fail('INVALID', 'A goal needs text.');
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) fail('INVALID', 'Goal id must be a short identifier.');
    if (this.state.goals[id]) fail('CONFLICT', 'Goal id already exists.', 409);
    const merged = { ...DEFAULT_LIMITS };
    for (const [key, value] of Object.entries(limits)) {
      if (!(key in DEFAULT_LIMITS)) fail('INVALID', `Unknown limit ${key}.`);
      if (!Number.isInteger(value) || value < 1 || value > 1000) fail('INVALID', `Limit ${key} must be an integer from 1 to 1000.`);
      merged[key] = value;
    }
    this.state.goals[id] = { id, text: text.trim(), limits: merged, state: 'active', createdAt: this.clock(), result: null };
    this.save();
    return this.state.goals[id];
  }

  goal(id) { return this.state.goals[id] ?? fail('NOT_FOUND', 'Goal not found.', 404); }

  admission(goalId) {
    const goal = this.goal(goalId);
    if (goal.state !== 'active') fail('GOAL_CLOSED', 'This goal is no longer active.', 409);
    if (Object.values(this.state.runs).some((run) => run.goalId === goalId && run.state === 'unknown')
      || Object.values(this.state.workers).some((worker) => worker.goalId === goalId && worker.cleanup?.confirmed === false)) {
      fail('HOLD', 'Unknown runs or unconfirmed cleanup block new work. Read and reconcile the original records first.', 409);
    }
    return goal;
  }

  finishGoal(id, result) {
    const goal = this.goal(id);
    if (goal.state === 'done') {
      if (goal.result === String(result ?? '').slice(0, 200_000)) return goal;
      fail('GOAL_CLOSED', 'The recorded result is final. Preserve it and record corrections separately.', 409);
    }
    goal.state = 'done';
    goal.result = String(result ?? '').slice(0, 200_000);
    goal.finishedAt = this.clock();
    this.save();
    return goal;
  }

  /** Register a node and return its one-time bearer. Depth 0 is the supervisor. */
  reserve({ goalId, parentId = null, role = 'team', name }) {
    const goal = this.admission(goalId);
    const workers = Object.values(this.state.workers).filter((worker) => worker.goalId === goalId && ACTIVE.includes(worker.state));
    let depth = 0;
    if (parentId) {
      const parent = this.worker(parentId);
      if (parent.goalId !== goalId || !ACTIVE.includes(parent.state)) fail('PARENT', 'Parent is not an active node of this goal.', 409);
      depth = parent.depth + 1;
      if (depth > goal.limits.maxDepth) fail('CAPACITY', `Tree depth ${goal.limits.maxDepth} reached; do the work in this Worker instead.`, 409);
      if (workers.filter((worker) => worker.parentId === parentId).length >= goal.limits.maxChildren) {
        fail('CAPACITY', `This node already has ${goal.limits.maxChildren} children.`, 409);
      }
      if (workers.filter((worker) => worker.depth > 0).length >= goal.limits.maxWorkers) {
        fail('CAPACITY', `The goal already uses all ${goal.limits.maxWorkers} Workers.`, 409);
      }
    } else if (workers.some((worker) => worker.depth === 0)) {
      fail('CONFLICT', 'This goal already has a supervisor.', 409);
    }
    const id = `w-${randomUUID().slice(0, 8)}`;
    const token = randomBytes(32).toString('base64url');
    this.state.workers[id] = {
      id, goalId, parentId, depth, role: String(role).slice(0, 40), name: String(name ?? id).slice(0, 80),
      state: 'reserved', tokenHash: tokenHash(token), createdAt: this.clock(), target: null,
    };
    this.save();
    return { worker: this.state.workers[id], token };
  }

  worker(id) { return this.state.workers[id] ?? fail('NOT_FOUND', 'Worker not found.', 404); }

  enroll(id, target) {
    const worker = this.worker(id);
    worker.state = 'ready';
    worker.target = target;
    worker.readyAt = this.clock();
    this.save();
    return worker;
  }

  markFailed(id, error, cleanup) {
    const worker = this.worker(id);
    worker.state = 'failed';
    worker.error = String(error).slice(0, 500);
    if (cleanup) worker.cleanup = cleanup;
    this.save();
  }

  retire(id, cleanupError) {
    const worker = this.worker(id);
    worker.state = 'retired';
    worker.retiredAt = this.clock();
    if (cleanupError) worker.cleanup = { ...worker.cleanup, confirmed: false, error: String(cleanupError).slice(0, 300) };
    // No new cleanup error is not a destruction receipt. Preserve previous
    // provisioning evidence, including its attempted app and admission hold.
    const cleanupUnconfirmed = worker.cleanup?.confirmed === false;
    // A failed deletion is not proof that the model stopped. Keep that uncertainty.
    for (const run of Object.values(this.state.runs)) {
      if (run.workerId === id && run.state === 'running') {
        Object.assign(run, { state: cleanupUnconfirmed ? 'unknown' : 'cancelled',
          error: cleanupUnconfirmed ? 'Worker cleanup is unconfirmed; the run may still be active.' : 'Worker was retired while this run was in progress.', finishedAt: this.clock() });
      }
    }
    this.save();
    return worker;
  }

  actorFor(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const hash = tokenHash(token);
    return Object.values(this.state.workers).find((worker) => worker.tokenHash === hash && ACTIVE.includes(worker.state)) ?? null;
  }

  isAncestor(ancestorId, id) {
    for (let current = this.state.workers[id]; current; current = this.state.workers[current.parentId]) {
      if (current.parentId === ancestorId) return true;
    }
    return false;
  }

  descendants(id) {
    return Object.values(this.state.workers).filter((worker) => this.isAncestor(id, worker.id));
  }

  tree(goalId) {
    return Object.values(this.state.workers).filter((worker) => worker.goalId === goalId).map((worker) => ({
      id: worker.id, parentId: worker.parentId, depth: worker.depth, role: worker.role, name: worker.name, state: worker.state,
      ...(worker.cleanup ? { cleanupConfirmed: worker.cleanup.confirmed } : {}),
      runs: Object.values(this.state.runs).filter((run) => run.workerId === worker.id).map((run) => ({ id: run.id, state: run.state })),
    }));
  }

  startRun({ workerId, startedBy, task, flowName }) {
    const worker = this.worker(workerId);
    if (!ACTIVE.includes(worker.state)) fail('NOT_READY', `Worker is ${worker.state}.`, 409);
    const goal = this.admission(worker.goalId);
    const active = Object.values(this.state.runs).filter((run) => run.workerId === workerId && run.state === 'running').length;
    if (active >= goal.limits.maxActiveRuns) fail('CAPACITY', `Worker already has ${goal.limits.maxActiveRuns} conversations running.`, 409);
    const id = `r-${randomUUID().slice(0, 8)}`;
    this.state.runs[id] = {
      id, workerId, goalId: worker.goalId, startedBy, flowName, task: String(task).slice(0, 64_000),
      conversationId: randomUUID(), state: 'running', startedAt: this.clock(), output: null, error: null,
    };
    this.save();
    return this.state.runs[id];
  }

  run(id) { return this.state.runs[id] ?? fail('NOT_FOUND', 'Run not found.', 404); }

  /** Pin the enrolled Worker target before this original root is submitted. */
  bindRunTarget(runId, target) {
    const run = this.run(runId);
    const worker = this.worker(run.workerId);
    if (run.state !== 'running' || worker.state !== 'ready' || !worker.target
      || typeof target?.workspace !== 'string' || !target.workspace.trim()
      || targetDigest(worker.target) !== targetDigest(target)) {
      fail('NATIVE_TARGET', 'The original run has no matching ready Worker target.', 409);
    }
    this.admission(run.goalId);
    const binding = { workspace: target.workspace, digest: targetDigest(target) };
    if (run.targetBinding) {
      if (run.targetBinding.workspace !== binding.workspace || run.targetBinding.digest !== binding.digest) {
        fail('NATIVE_TARGET', 'The original run target changed after binding.', 409);
      }
      return run;
    }
    run.targetBinding = binding;
    this.save();
    return run;
  }

  /** New native admission gate only. Existing original-ID reconciliation is separate. */
  resolveNativeOriginalRun(actor, claim) {
    if (!actor || typeof actor !== 'object' || this.state.workers[actor.id] !== actor
      || actor.state !== 'ready' || !actor.target) {
      fail('FORBIDDEN', 'A ready executing Worker bearer is required.', 403);
    }
    const keys = ['runId', 'rootConversationId', 'goalId', 'workspace'];
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)
      || Object.keys(claim).some((key) => !keys.includes(key))
      || keys.some((key) => !Object.hasOwn(claim, key)
        || typeof claim[key] !== 'string' || !claim[key].trim())) {
      fail('INVALID', 'An exact original run identity is required.');
    }
    const run = this.run(claim.runId);
    if (run.workerId !== actor.id || run.goalId !== actor.goalId || run.goalId !== claim.goalId
      || run.conversationId !== claim.rootConversationId || run.state !== 'running') {
      fail('FORBIDDEN', 'The original run is not current for this executing Worker.', 403);
    }
    if (Object.values(this.state.runs).filter((item) =>
      item.workerId === actor.id && item.conversationId === run.conversationId).length !== 1) {
      fail('NATIVE_ORIGIN', 'The Worker root conversation is not unique.', 409);
    }
    this.admission(run.goalId);
    const binding = run.targetBinding;
    if (!binding || binding.workspace !== claim.workspace || actor.target.workspace !== binding.workspace
      || targetDigest(actor.target) !== binding.digest) {
      fail('NATIVE_TARGET', 'The original Worker target or workspace changed.', 409);
    }
    return Object.freeze({ workerId: actor.id, goalId: run.goalId, fleetRunId: run.id,
      rootConversationId: run.conversationId, workspace: binding.workspace, targetDigest: binding.digest });
  }

  settleRun(id, { status, output, error, usage }) {
    const run = this.run(id);
    if (run.state === 'cancelled') return run;
    run.state = status;
    run.output = String(output ?? '').slice(0, 400_000);
    run.error = error ?? null;
    if (usage) run.usage = usage;
    run.finishedAt = this.clock();
    this.save();
    return run;
  }

  post({ goalId, author, topic, text }) {
    const goal = this.goal(goalId);
    if (typeof text !== 'string' || !text.trim()) fail('INVALID', 'A board post needs text.');
    if (Buffer.byteLength(text) > goal.limits.maxBoardBytes) fail('TOO_LARGE', `Board posts are limited to ${goal.limits.maxBoardBytes} bytes; write a file and post its path and a summary.`);
    const entry = { seq: this.state.board.length + 1, goalId, author, topic: String(topic ?? 'general').slice(0, 60), text, at: this.clock() };
    this.state.board.push(entry);
    this.save();
    return entry;
  }

  board({ goalId, topic, since = 0, limit = 50 }) {
    return this.state.board
      .filter((entry) => entry.goalId === goalId && entry.seq > since && (!topic || entry.topic === topic))
      .slice(-Math.min(Math.max(limit, 1), 200));
  }
}
