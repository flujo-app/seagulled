// Fleet controller: owns the Worker tree for a goal, provisions Workers, runs their
// teams and hosts the `fleet` MCP tools that agents use to grow and steer the swarm.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { FlujoClient } from '../lib/flujo-client.mjs';
import { installTemplate } from '../install.mjs';
import { FLOW_NAMES } from '../template/flows.mjs';
import { FleetError, Registry } from './registry.mjs';
import { claimController } from './owner.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const TOOLS = [
  { name: 'fleet_info', description: 'Show the goal, the limits, the whole Worker tree and where you are in it.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'fleet_delegate', description: 'Create a child Worker (a separate sandbox with its own team of up to 10 agents) and start its team on a task. Returns a workerId and a runId at once; provisioning continues in the background. Read progress with fleet_wait.',
    inputSchema: { type: 'object', required: ['name', 'task'], properties: {
      name: { type: 'string', description: 'Short name for this branch, e.g. "approach-sqlite".' },
      task: { type: 'string', description: 'Self-contained task for the child team: goal, angle, what done means.' } } } },
  { name: 'fleet_start_task', description: 'Start another task on a child Worker you already created. Returns a runId.',
    inputSchema: { type: 'object', required: ['workerId', 'task'], properties: { workerId: { type: 'string' }, task: { type: 'string' } } } },
  { name: 'fleet_wait', description: 'Wait up to timeoutMs (default 30000, max 50000) for a run to finish. Returns its state and, when finished, its result. state "running" after the timeout is normal: wait again.',
    inputSchema: { type: 'object', required: ['runId'], properties: { runId: { type: 'string' }, timeoutMs: { type: 'integer' } } } },
  { name: 'fleet_message', description: 'Send a steering message into a running child team. It is read at the team\'s next safe point.',
    inputSchema: { type: 'object', required: ['runId', 'message'], properties: { runId: { type: 'string' }, message: { type: 'string' } } } },
  { name: 'fleet_retire_worker', description: 'Retire a child Worker and everything below it. Its sandbox is deleted.',
    inputSchema: { type: 'object', required: ['workerId'], properties: { workerId: { type: 'string' } } } },
  { name: 'board_post', description: 'Post one finding to the shared board that every Worker of this goal can read.',
    inputSchema: { type: 'object', required: ['text'], properties: { topic: { type: 'string', description: 'e.g. "finding", "blocker", "consolidated".' }, text: { type: 'string' } } } },
  { name: 'board_read', description: 'Read the shared board. Pass the last seq you saw as "since" to get only new posts.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, since: { type: 'integer' }, limit: { type: 'integer' } } } },
  { name: 'goal_finish', description: 'Supervisor only: record the final result of the goal and close it.',
    inputSchema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } } },
];

export class Controller {
  /**
   * @param registryPath  private JSON state file
   * @param operatorToken bearer for the human/CLI
   * @param publicUrl     URL under which Workers reach this controller
   * @param provisioner   { provision(worker, fleet) -> target, retire(target), connect?(target) }
   */
  constructor({ registryPath, operatorToken, publicUrl, remoteUrl, provisioner, runTimeoutMs, beforeRetire,
    log = () => undefined }) {
    if (!operatorToken || operatorToken.length < 32) throw new Error('operatorToken must be at least 32 characters.');
    this.releaseOwner = claimController(registryPath);
    try { this.registry = new Registry(registryPath); }
    catch (error) { this.releaseOwner(); throw error; }
    this.onExit = () => this.releaseOwner();
    process.once('exit', this.onExit);
    this.operatorToken = operatorToken;
    this.publicUrl = publicUrl.replace(/\/$/, '');
    // Where machines on Fly's private network reach this controller (the relay), if any.
    this.remoteUrl = remoteUrl?.replace(/\/$/, '');
    this.provisioner = provisioner;
    this.log = log;
    this.runTimeoutMs = runTimeoutMs;
    this.beforeRetire = beforeRetire;
    this.provisioning = new Map(); // workerId -> Promise<target>
    this.settled = new Map();      // runId -> Promise (in-flight runs)
  }

  fleetFor(token, { remote = false } = {}) {
    return { url: `${remote && this.remoteUrl ? this.remoteUrl : this.publicUrl}/mcp`, token,
      ...(this.remoteUrl ? { remoteUrl: `${this.remoteUrl}/mcp` } : {}) };
  }

  async connect(target) {
    if (this.provisioner?.connect && target.kind !== 'external') return this.provisioner.connect(target);
    return { client: new FlujoClient(target), close: async () => undefined };
  }

  /** Create a goal; its supervisor runs on an existing FLUJO (an always-on worker). */
  async createGoal({ text, limits, supervisor, model, start = true }) {
    const goal = this.registry.createGoal({ text, limits });
    const { worker, token } = this.registry.reserve({ goalId: goal.id, role: 'supervisor', name: 'supervisor' });
    // An always-on Fly worker is reached through a private proxy and talks back through the relay.
    const onFly = Boolean(supervisor.app);
    const target = onFly
      ? { kind: 'flyproxy', app: supervisor.app, org: supervisor.org, machineId: supervisor.machineId, workspace: supervisor.workspace, token: supervisor.token }
      : { kind: 'external', origin: supervisor.origin, workspace: supervisor.workspace, token: supervisor.token };
    let connection;
    try {
      connection = await this.connect(target);
      await installTemplate(connection.client, { model, fleet: this.fleetFor(token, { remote: onFly }), browser: supervisor.browser !== false });
    } catch (error) {
      this.registry.markFailed(worker.id, error.message);
      throw error;
    } finally { await connection?.close().catch(() => undefined); }
    this.registry.enroll(worker.id, target);
    const run = start ? this.startRun({ worker, startedBy: 'operator', flowName: FLOW_NAMES.supervisor,
      task: `GOAL ${goal.id}:\n${goal.text}\n\nBuild the swarm for this goal and supervise it until the goal is met.` }) : null;
    return { goal, supervisorId: worker.id, runId: run?.id ?? null };
  }

  /** Start one conversation on a Worker. Returns at once; the run settles in the background. */
  startRun({ worker, startedBy, task, flowName = FLOW_NAMES.team }) {
    const run = this.registry.startRun({ workerId: worker.id, startedBy, task, flowName });
    const job = (async () => {
      let connection;
      let submitted = false;
      try {
        const target = worker.target ?? await this.provisioning.get(worker.id);
        connection = await this.connect(target);
        submitted = true;
        const result = await connection.client.runFlow({ flowName, prompt: task, conversationId: run.conversationId,
          ...(this.runTimeoutMs ? { timeoutMs: this.runTimeoutMs } : {}) });
        this.registry.settleRun(run.id, result);
      } catch (error) {
        this.registry.settleRun(run.id, { status: submitted ? 'unknown' : 'failed', output: '', error: error.message });
      } finally {
        await connection?.close().catch(() => undefined);
        this.settled.delete(run.id);
      }
    })();
    this.settled.set(run.id, job);
    return run;
  }

  delegate(actor, { name, task }) {
    if (typeof task !== 'string' || !task.trim()) throw new FleetError('INVALID', 'A task is required.');
    const { worker, token } = this.registry.reserve({ goalId: actor.goalId, parentId: actor.id, role: 'team', name });
    const provisioning = (async () => {
      try {
        const target = await this.provisioner.provision(worker, this.fleetFor(token),
          { isLeaf: worker.depth >= this.registry.goal(worker.goalId).limits.maxDepth });
        this.registry.enroll(worker.id, target);
        return target;
      } catch (error) {
        this.registry.markFailed(worker.id, error.message, error.cleanup);
        this.log(`provision ${worker.id} failed: ${error.message}`);
        throw error;
      }
    })();
    provisioning.catch(() => undefined);
    this.provisioning.set(worker.id, provisioning);
    const goal = this.registry.goal(actor.goalId);
    const run = this.startRun({ worker, startedBy: actor.id,
      task: `You are Worker "${worker.name}" (${worker.id}) in the swarm for this goal:\n${goal.text}\n\nYOUR BRANCH:\n${task}` });
    return { workerId: worker.id, runId: run.id, state: 'provisioning' };
  }

  owns(actor, workerId) {
    if (actor === 'operator') return true;
    return this.registry.isAncestor(actor.id, workerId);
  }

  async waitRun(actor, { runId, timeoutMs = 30_000 }) {
    const run = this.registry.run(runId);
    if (actor !== 'operator' && run.goalId !== actor.goalId) throw new FleetError('FORBIDDEN', 'That run belongs to another goal.', 403);
    const job = this.settled.get(runId);
    if (job) await Promise.race([job, sleep(Math.min(Math.max(Number(timeoutMs) || 0, 0), 50_000))]);
    const current = this.registry.run(runId);
    const worker = this.registry.worker(current.workerId);
    return { runId, workerId: current.workerId, workerState: worker.state, state: current.state,
      ...(current.state === 'running' ? {} : { result: current.output, error: current.error }) };
  }

  async message(actor, { runId, message }) {
    const run = this.registry.run(runId);
    if (!this.owns(actor, run.workerId)) throw new FleetError('FORBIDDEN', 'You can only message runs on your own descendants.', 403);
    if (run.state !== 'running') throw new FleetError('NOT_RUNNING', `Run is ${run.state}; start a new task instead.`, 409);
    const worker = this.registry.worker(run.workerId);
    if (!worker.target) throw new FleetError('NOT_READY', 'The Worker is still being provisioned; send the message again shortly.', 409);
    const connection = await this.connect(worker.target);
    try { await connection.client.inject(run.conversationId, `Message from your parent (${actor === 'operator' ? 'operator' : actor.name}):\n${message}`); }
    finally { await connection.close().catch(() => undefined); }
    return { status: 'queued' };
  }

  async retire(actor, { workerId }) {
    if (!this.owns(actor, workerId)) throw new FleetError('FORBIDDEN', 'You can only retire your own descendants.', 403);
    const subtree = [this.registry.worker(workerId), ...this.registry.descendants(workerId)].sort((a, b) => b.depth - a.depth);
    const retired = [];
    const cleanupUnconfirmed = [];
    for (const worker of subtree) {
      if (worker.state === 'retired') {
        if (worker.cleanup?.confirmed === false) cleanupUnconfirmed.push(worker.id);
        continue;
      }
      await this.provisioning.get(worker.id)?.catch(() => undefined);
      const current = this.registry.worker(worker.id);
      let cleanupError;
      if (current.target && ['external', 'flyproxy'].includes(current.target.kind)
        && Object.values(this.registry.state.runs).some((run) => run.workerId === worker.id && run.state === 'running')) {
        cleanupError = 'The existing supervisor host is retained; an active conversation has no confirmed cancellation.';
      }
      if (current.target && !['external', 'flyproxy'].includes(current.target.kind)) {
        // The Worker loses its place and its bearer either way; a sandbox that could not be
        // deleted is recorded, never silently forgotten.
        const activeRuns = Object.values(this.registry.state.runs)
          .filter((run) => run.workerId === worker.id && run.state === 'running');
        if (activeRuns.length) {
          let connection;
          try {
            connection = await this.connect(current.target);
            for (const run of activeRuns) {
              try { await connection.client.cancel(run.conversationId); }
              catch { this.log(`cancel request for ${run.id} was unconfirmed`); }
            }
          } catch { this.log(`cancel connection for ${worker.id} was unconfirmed`); }
          finally { await connection?.close().catch(() => undefined); }
        }
        if (this.beforeRetire) {
          try { await this.beforeRetire({ worker: current, target: current.target }); }
          catch (error) {
            // A completed Worker may hold the only copy of its deliverables. Preserve
            // that exact app and block admission until its output is reconciled.
            this.registry.retire(worker.id, `Before-retire output capture failed: ${error.message}`);
            cleanupUnconfirmed.push(worker.id);
            retired.push(worker.id);
            this.log(`before-retire collection of ${worker.id} failed: ${error.message}`);
            continue;
          }
        }
        try { await this.provisioner.retire(current.target); }
        catch (error) { cleanupError = error.message; this.log(`cleanup of ${worker.id} unconfirmed: ${error.message}`); }
      }
      // A failed attempt can have no enrolled target. Retiring that node does
      // not prove destruction; report any retained cleanup hold from the registry.
      const node = this.registry.retire(worker.id, cleanupError);
      if (node.cleanup?.confirmed === false) cleanupUnconfirmed.push(worker.id);
      retired.push(worker.id);
    }
    return { retired, ...(cleanupUnconfirmed.length ? { cleanupUnconfirmed } : {}) };
  }

  info(actor) {
    const goal = this.registry.goal(actor.goalId);
    const tree = this.registry.tree(goal.id);
    const active = tree.filter((node) => ['reserved', 'ready'].includes(node.state));
    return {
      you: { id: actor.id, name: actor.name, role: actor.role, depth: actor.depth, parentId: actor.parentId },
      goal: { id: goal.id, text: goal.text, state: goal.state },
      limits: goal.limits,
      capacity: {
        workersLeft: goal.limits.maxWorkers - active.filter((node) => node.depth > 0).length,
        yourChildrenLeft: goal.limits.maxChildren - active.filter((node) => node.parentId === actor.id).length,
        canDelegate: actor.depth < goal.limits.maxDepth,
      },
      tree,
    };
  }

  async tool(actor, name, args = {}) {
    switch (name) {
      case 'fleet_info': return this.info(actor);
      case 'fleet_delegate': return this.delegate(actor, args);
      case 'fleet_start_task': {
        if (!this.owns(actor, args.workerId)) throw new FleetError('FORBIDDEN', 'You can only start tasks on your own descendants.', 403);
        const run = this.startRun({ worker: this.registry.worker(args.workerId), startedBy: actor.id, task: args.task });
        return { runId: run.id, state: 'running' };
      }
      case 'fleet_wait': return this.waitRun(actor, args);
      case 'fleet_message': return this.message(actor, args);
      case 'fleet_retire_worker': return this.retire(actor, args);
      case 'board_post': return this.registry.post({ goalId: actor.goalId, author: `${actor.name} (${actor.id})`, topic: args.topic, text: args.text });
      case 'board_read': return { posts: this.registry.board({ goalId: actor.goalId, topic: args.topic, since: args.since, limit: args.limit }) };
      case 'goal_finish': {
        if (actor.depth !== 0) throw new FleetError('FORBIDDEN', 'Only the supervisor can finish the goal.', 403);
        const goal = this.registry.finishGoal(actor.goalId, args.result);
        return { goal: goal.id, state: goal.state };
      }
      default: throw new FleetError('UNKNOWN_TOOL', `Unknown tool ${name}.`, 404);
    }
  }

  /** MCP over streamable HTTP, stateless: every request carries the Worker's bearer. */
  async mcp(actor, message) {
    const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'fleet', version: '1.0.0' } });
    }
    if (message.id === undefined) return null; // notification
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools: TOOLS });
    if (message.method === 'tools/call') {
      try {
        const result = await this.tool(actor, message.params?.name, message.params?.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (error) {
        const text = error instanceof FleetError ? `${error.code}: ${error.message}` : `ERROR: ${error.message}`;
        return reply({ content: [{ type: 'text', text }], isError: true });
      }
    }
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  }

  authenticate(request) {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (token && same(token, this.operatorToken)) return 'operator';
    return this.registry.actorFor(token);
  }

  async handle(request, response) {
    const send = (status, body) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(text);
    };
    try {
      const url = new URL(request.url, 'http://fleet');
      if (request.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
      const actor = this.authenticate(request);
      if (!actor) return send(401, { error: 'UNAUTHORIZED' });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) return send(413, { error: 'TOO_LARGE' });
        chunks.push(chunk);
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};

      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') return send(405, { error: 'POST only' });
        if (actor === 'operator') return send(403, { error: 'The MCP endpoint is for Workers.' });
        if (Array.isArray(body)) {
          const replies = (await Promise.all(body.map((message) => this.mcp(actor, message)))).filter(Boolean);
          return replies.length ? send(200, replies) : (response.writeHead(202), response.end());
        }
        const reply = await this.mcp(actor, body);
        return reply ? send(200, reply) : (response.writeHead(202), response.end());
      }

      if (actor !== 'operator') return send(403, { error: 'Operator token required.' });
      if (request.method === 'POST' && url.pathname === '/goals') return send(201, await this.createGoal(body));
      const goalMatch = /^\/goals\/([\w-]+)$/.exec(url.pathname);
      if (request.method === 'GET' && goalMatch) {
        const goal = this.registry.goal(goalMatch[1]);
        return send(200, { goal, tree: this.registry.tree(goal.id), board: this.registry.board({ goalId: goal.id, limit: 200 }) });
      }
      const runMatch = /^\/runs\/([\w-]+)$/.exec(url.pathname);
      if (request.method === 'GET' && runMatch) {
        return send(200, await this.waitRun('operator', { runId: runMatch[1], timeoutMs: Number(url.searchParams.get('waitMs') ?? 0) }));
      }
      if (request.method === 'POST' && runMatch) return send(200, await this.message('operator', { runId: runMatch[1], message: body.message }));
      const workerMatch = /^\/workers\/([\w-]+)$/.exec(url.pathname);
      if (request.method === 'DELETE' && workerMatch) return send(200, await this.retire('operator', { workerId: workerMatch[1] }));
      return send(404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof FleetError) return send(error.status, { error: error.code, message: error.message });
      if (error instanceof SyntaxError) return send(400, { error: 'INVALID_JSON' });
      this.log(`request failed: ${error.stack ?? error.message}`);
      return send(500, { error: 'INTERNAL', message: error.message });
    }
  }

  listen(port, host = '127.0.0.1') {
    this.server = http.createServer((request, response) => this.handle(request, response));
    this.server.requestTimeout = 0;
    return new Promise((resolve) => this.server.listen(port, host, () => resolve(this.server.address())));
  }

  async close() {
    await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve()));
    await Promise.allSettled([...this.settled.values()]);
    process.removeListener('exit', this.onExit);
    this.releaseOwner();
  }
}
