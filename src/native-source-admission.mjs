import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { Controller } from '../upstream/swarm-teams/fleet/controller.mjs';

const fail = () => { throw Object.assign(new Error('Native Source Worker admission is unavailable or no longer current.'), { code: 'NATIVE_SOURCE_ADMISSION' }); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const planKeys = ['flowId', 'flowDigest', 'modelId', 'modelDigest'];
const sourceKeys = ['conversationId', 'runId', 'workspace', ...planKeys];
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ownedAdmissions = new WeakMap();
export function assertNativeSourceAdmissionController(admission, controller) {
  if (ownedAdmissions.get(admission) !== controller) fail();
}
function plan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== planKeys.length || Object.keys(value).some(key => !planKeys.includes(key))
    || !identifier(value.flowId) || !identifier(value.modelId) || !hash(value.flowDigest) || !hash(value.modelDigest)) fail();
  return Object.freeze(Object.fromEntries(planKeys.map(key => [key, value[key]])));
}

/** Parent-owned, in-process admission for the trusted Source execution adapter.
 * The real Controller authenticates every reread. Source binds its logical run
 * once; neither a caller DTO nor an operator bearer can create Worker ownership.
 * readPlan reads the installed immutable plan by authenticated actor, never by
 * Source's proposed expected values. scope is the owning runtime's live OFF,
 * budget, provider/image qualification and mutation fence. This module exposes
 * no HTTP route or fleet gate. */
export function createControllerNativeSourceAdmission({ controller, scope, readPlan, readChildren, maxContexts = 100 } = {}) {
  if (!(controller instanceof Controller) || !scope?.signal
    || typeof scope.signal.throwIfAborted !== 'function' || typeof scope.assertCurrent !== 'function'
    || typeof scope.commit !== 'function' || typeof readPlan !== 'function' || readChildren!==undefined&&typeof readChildren!=='function'
    || !Number.isInteger(maxContexts) || maxContexts < 1 || maxContexts > 100) fail();
  const leaseFile = `${controller.registry.path}.controller.lock`;
  const lease = () => {
    try {
      const stat = lstatSync(leaseFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) fail();
      const bytes = readFileSync(leaseFile, 'utf8');
      const value = JSON.parse(bytes);
      if (value.version !== 1 || value.pid !== process.pid || !identifier(value.nonce)
        || !Number.isFinite(Date.parse(value.startedAt))) fail();
      return bytes;
    } catch { return fail(); }
  };
  const ownerLease = lease();
  const contexts = new WeakMap();
  const roots = new Map();
  const children = async actor => {
    const values=readChildren?await readChildren(actor):[];
    if(!Array.isArray(values)||values.length>1)fail();
    return Object.freeze(values.map(value=>{
      if(!value||Object.keys(value).length!==5||!identifier(value.parentNodeId))fail();
      const {parentNodeId,...selected}=value;
      return Object.freeze({parentNodeId,...plan(selected)});
    }));
  };
  let count = 0;
  let closed = false;
  const entry = context => contexts.get(context) ?? fail();
  const current = async item => {
    if (closed || lease() !== ownerLease) fail();
    scope.signal.throwIfAborted();
    await scope.assertCurrent(item.actor);
    const actor = controller.resolveNativeOriginalRun(item.request, item.claim);
    if (!same(actor, item.actor) || !same(plan(await readPlan(actor)), item.plan)
      || !same(await children(actor), item.children)) fail();
    // Plan inspection can yield while the original target, run or OFF changes.
    if (!same(controller.resolveNativeOriginalRun(item.request, item.claim), item.actor)
      || closed || lease() !== ownerLease) fail();
    await scope.assertCurrent(item.actor);
    scope.signal.throwIfAborted();
    if (closed || lease() !== ownerLease
      || !same(controller.resolveNativeOriginalRun(item.request, item.claim), item.actor)) fail();
  };
  const assertRun = async (context, expected = {}) => {
    const item = entry(context);
    await current(item);
    if (expected.conversationId !== undefined && expected.conversationId !== item.actor.rootConversationId
      || expected.runId !== undefined && expected.runId !== item.binding.logicalRunId
      || expected.graphHash !== undefined && expected.graphHash !== item.plan.flowDigest) fail();
    return item;
  };
  const admission = Object.freeze({
    async admitWorker(request, claim) {
      if (closed || count >= maxContexts) fail();
      scope.signal.throwIfAborted();
      const authorization = request?.headers?.authorization;
      if (typeof authorization !== 'string' || authorization.length > 4096) fail();
      const captured = Object.freeze({ headers: Object.freeze({ authorization }) });
      const claimSnapshot = Object.freeze(structuredClone(claim));
      const actor = controller.resolveNativeOriginalRun(captured, claimSnapshot);
      const item = { request: captured, claim: claimSnapshot, actor,
        plan: plan(await readPlan(actor)), children:await children(actor), binding: undefined };
      await current(item);
      if (count >= maxContexts) fail();
      const rootKey = JSON.stringify(actor);
      const existing = roots.get(rootKey);
      if (existing && (!same(existing.plan, item.plan)||!same(existing.children,item.children))) fail();
      item.binding = existing ?? { plan: item.plan, children:item.children, leaseEpoch: randomUUID(), logicalRunId: undefined };
      roots.set(rootKey, item.binding);
      const context = Object.freeze({});
      contexts.set(context, item); count++;
      return context;
    },
    async bindRun(context, conversationId, logicalRunId) {
      const item = await assertRun(context, { conversationId });
      if (!identifier(logicalRunId) || item.binding.logicalRunId !== undefined && item.binding.logicalRunId !== logicalRunId) fail();
      item.binding.logicalRunId = logicalRunId;
    },
    async readRoot(context, expected) {
      const item = await assertRun(context, { conversationId: expected?.conversationId, runId: expected?.runId });
      if (!item.binding.logicalRunId || !expected || Object.keys(expected).length !== sourceKeys.length
        || Object.keys(expected).some(key => !sourceKeys.includes(key))
        || expected.conversationId !== item.actor.rootConversationId || expected.runId !== item.binding.logicalRunId
        || expected.workspace !== item.actor.workspace
        || planKeys.some(key => expected[key] !== item.plan[key])) fail();
      return Object.freeze({ version: 1, ...item.actor, logicalRunId: item.binding.logicalRunId,
        flowDigest: item.plan.flowDigest, leaseEpoch: item.binding.leaseEpoch,
        modelId: item.plan.modelId, modelDigest: item.plan.modelDigest });
    },
    async assertRun(context, expected) { await assertRun(context, expected); },
    async readPlan(context) {
      const item = await assertRun(context);
      return Object.freeze({ ...item.plan });
    },
    async readChildren(context) {
      const item=await assertRun(context);return Object.freeze(item.children.map(value=>Object.freeze({...value})));
    },
    async withWorker(context, task) {
      if (typeof task !== 'function') fail();
      const item = await assertRun(context);
      if (!item.binding.logicalRunId) fail();
      const worker = structuredClone(controller.registry.worker(item.actor.workerId));
      const result = await task(Object.freeze({ actor: item.actor, worker }));
      await current(item);
      return result;
    },
    signal(context) { entry(context); if (closed) fail(); return scope.signal; },
    async commit(context, task, fence = {}) {
      if (typeof task !== 'function') fail();
      const item = entry(context);
      return scope.commit(async () => {
        await current(item);
        try {
          const result = await task();
          await current(item);
          await fence.afterCheck?.();
          return result;
        } catch (error) {
          // Trusted transport callbacks persist uncertainty inside the owning
          // commit, before its mutation fence can be released.
          await fence.uncertain?.();
          throw error;
        }
      }, item.actor);
    },
    close() { closed = true; roots.clear(); },
  });
  ownedAdmissions.set(admission, controller);
  return admission;
}
