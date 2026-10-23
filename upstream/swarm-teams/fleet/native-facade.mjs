// Internal bridge for the frozen FLUJO native invocation session hook. This is
// deliberately not a route, SDK host, or native fleet eligibility switch.
import { createHash } from 'node:crypto';
import { NativeOriginalLedger } from './native-ledger.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
};
const nativeDigest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code) => { throw Object.assign(new Error(`Native facade ${code}.`), { code }); };
const keyOf = (goalId, invocationId) => JSON.stringify([goalId, invocationId]);
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_GOAL_QUEUE = 64;
const MAX_TOTAL_QUEUE = 256;
const MAX_WAIT_MS = 30 * 60_000;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function inspectDescriptor(descriptor, payload, actor) {
  const { receipt, lineage, archive, inventory, payloadRef } = descriptor ?? {};
  if (!receipt?.invocationId || !receipt.owner || !lineage || !archive || !inventory || !payloadRef
    || Buffer.byteLength(JSON.stringify(descriptor)) > 16 * 1024
    || receipt.invocationId !== lineage.invocationId || lineage.version !== 1
    || receipt.state !== 'begin-may-have-been-sent'
    || typeof lineage.installationId !== 'string' || !lineage.installationId
    || lineage.digest !== nativeDigest(Object.fromEntries(Object.entries(lineage)
      .filter(([key]) => key !== 'digest')))
    || receipt.owner.conversationId !== lineage.originConversationId
    || receipt.owner.runId !== lineage.originLogicalRunId
    || receipt.owner.nodeId !== lineage.originNodeId
    || receipt.owner.modelId !== lineage.modelId
    || receipt.owner.leaseEpoch !== lineage.leaseEpoch
    || receipt.owner.attemptOrdinal !== lineage.attemptOrdinal
    || receipt.owner.inputDigest !== lineage.inputDigest
    || receipt.owner.inventoryDigest !== lineage.inventoryDigest
    || inventory.digest !== lineage.inventoryDigest
    || archive.dispatchId !== receipt.invocationId
    || ['workerId', 'goalId', 'fleetRunId', 'rootConversationId', 'workspace']
      .some((field) => lineage[field] !== actor[field])
    || payloadRef.kind !== 'private-native-session-payload'
    || payloadRef.invocationId !== receipt.invocationId
    || !/^[a-f0-9]{64}$/.test(payloadRef.sha256 ?? '')
    || !Number.isSafeInteger(payloadRef.byteLength) || payloadRef.byteLength < 1
    || payloadRef.byteLength > 4 * 1024 * 1024
    || payload?.invocationId !== receipt.invocationId
    || !Array.isArray(payload.archive?.media) || !Array.isArray(payload.archive?.genericWire)
    || !Array.isArray(payload.inventory?.tools)
    || !Number.isSafeInteger(archive.mediaCount) || archive.mediaCount < 0
    || !Number.isSafeInteger(inventory.toolCount) || inventory.toolCount < 0
    || payload.archive?.media?.length !== archive.mediaCount
    || payload.inventory?.tools?.length !== inventory.toolCount
    || nativeDigest(payload.archive?.sdkRequest) !== archive.sanitizedSdkRequestDigest
    || nativeDigest(payload.archive?.genericWire) !== archive.sanitizedGenericWireDigest) fail('SOURCE_MISMATCH');
  const generation = `source-${digest([lineage.installationId, receipt.owner.leaseEpoch])}`;
  return { generation, conversationId: lineage.originConversationId,
    logicalRunId: lineage.originLogicalRunId, nodeId: lineage.originNodeId };
}

/**
 * source.readOrigin/readPayload/readTerminal must reread trusted Worker-private
 * records, not echo JSON supplied by a caller. source.retainLive and probeLive
 * must inspect an actual original SDK/process lifecycle; a session phase is not
 * a live probe. Without those capabilities, acknowledgement fails closed.
 */
export function createNativeInvocationFacade({ directory, controller, source }) {
  if (!directory || typeof controller?.resolveNativeOriginalRun !== 'function'
    || ['readOrigin', 'readPayload', 'assertPublishable', 'retainLive', 'probeLive', 'readTerminal']
      .some((method) => typeof source?.[method] !== 'function')) fail('CONFIG');
  const entries = new Map();
  const sessions = new WeakMap();
  const queues = new Map();
  let queued = 0;
  let closed = false;
  const sourceRecord = async (invocationId) => {
    const saved = await source.readOrigin(invocationId);
    if (!saved || saved.receipt?.invocationId !== invocationId) fail('SOURCE_MISMATCH');
    return saved;
  };
  const ledger = new NativeOriginalLedger({
    directory,
    resolveActor: (request, claim) => controller.resolveNativeOriginalRun(request, claim),
    verifyOrigin: async (envelope, actor, expected) => {
      const entry = entries.get(keyOf(actor.goalId, envelope.invocationId));
      if (!entry || !same(envelope, entry.envelope)) fail('SOURCE_MISMATCH');
      const saved = await sourceRecord(envelope.invocationId);
      if (!same(saved, entry.session.descriptor)) fail('SOURCE_MISMATCH');
      const payload = await source.readPayload(saved.payloadRef);
      const origin = inspectDescriptor(saved, payload, actor);
      if (!same(entry.payload, expected.payload)) fail('SOURCE_MISMATCH');
      return { ...actor, ...origin, ...expected };
    },
    probeOriginalHandle: (handle, owner, hostGeneration) =>
      source.probeLive(handle, owner, hostGeneration),
    verifyTerminal: async (proof, owner, _handle, view) => {
      const entry = entries.get(keyOf(owner.goalId, owner.invocationId));
      if (!entry || proof?.invocationId !== owner.invocationId) fail('TERMINAL_PROOF');
      const saved = await source.readTerminal(owner.invocationId,
        structuredClone(entry.expectedTerminal));
      if (saved?.receipt?.invocationId !== owner.invocationId
        || !same(saved.receipt.owner, entry.expectedTerminal.expectedOwner)
        || saved.receipt.state !== 'terminal' || saved.holdAbsent !== true
        || saved.receipt.outcome !== 'completed' || view.sdkOutcome !== 'completed'
        || view.terminalReady !== true
        || saved.effectsResolved !== true
        || view.cancel && saved.cancelResolved !== true) fail('TERMINAL_PROOF');
      return { callId: owner.invocationId, generation: owner.generation,
        state: 'completed',
        proofId: `source-${digest(saved.receipt)}`,
        invocationResolved: true, cancelResolved: saved.cancelResolved === true,
        ...(view.cancel ? { cancelId: view.cancel.id } : {}),
        ...(view.result ? { resultId: view.result.id } : {}),
        ...(view.events.length ? { cursor: view.events.at(-1).cursor } : {}),
      };
    },
  });
  const entryFor = (session) => sessions.get(session) ?? fail('UNKNOWN_SESSION');
  const project = (descriptor) => ({
    input: { sourceModelInputDigest: descriptor.receipt.owner.inputDigest,
      sanitizedSdkRequestDigest: descriptor.archive.sanitizedSdkRequestDigest,
      sanitizedGenericWireDigest: descriptor.archive.sanitizedGenericWireDigest,
      payloadRef: descriptor.payloadRef },
    inventory: { sourceInventoryDigest: descriptor.inventory.digest,
      toolCount: descriptor.inventory.toolCount },
    invocation: { sourceReceiptOwner: descriptor.receipt.owner,
      lineageDigest: descriptor.lineage.digest, archiveDispatchId: descriptor.archive.dispatchId,
      archiveAdapter: descriptor.archive.adapter, archiveOperation: descriptor.archive.operation,
      sourceDescriptorDigest: nativeDigest(descriptor) },
  });
  const queueFor = (goalId) => {
    if (!queues.has(goalId)) queues.set(goalId, { goalId, waiting: [], active: null });
    return queues.get(goalId);
  };
  const complete = (entry, result) => {
    if (entry.publicationDone) return;
    entry.publicationDone = true;
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.publication.resolve(result);
  };
  const schedule = (queue) => {
    if (closed || queue.active) return;
    const entry = queue.waiting[0];
    if (!entry || entry.state === 'validating' || entry.state === 'blocked') return;
    queue.waiting.shift();
    queue.active = entry;
    entry.state = 'granting';
    void grant(entry);
  };
  const release = (entry) => {
    const queue = entry.queue;
    if (queue.active !== entry) return;
    queue.active = null;
    queued--;
    schedule(queue);
  };
  const wake = (goalId) => {
    const queue = queues.get(goalId);
    if (!queue) return;
    if (queue.waiting[0]?.state === 'blocked') queue.waiting[0].state = 'waiting';
    schedule(queue);
  };
  const abandon = (entry, error) => {
    if (!['validating', 'waiting', 'blocked'].includes(entry.state)) {
      entry.cancelRequested = true;
      if (entry.state === 'granting') complete(entry, { allowed: false, error });
      return;
    }
    const index = entry.queue.waiting.indexOf(entry);
    if (index >= 0) { entry.queue.waiting.splice(index, 1); queued--; }
    entry.state = 'abandoned';
    entry.cancelRequested = true;
    complete(entry, { allowed: false, error });
    schedule(entry.queue);
  };
  const checkWait = (entry) => {
    if (closed) fail('CLOSED');
    if (entry.cancelRequested || entry.signal?.aborted) fail('CANCELLED');
    if (entry.deadlineAt !== undefined && Date.now() >= entry.deadlineAt) fail('DEADLINE');
    if (entry.session.phase() !== 'prepared') fail('SESSION');
    if (!same(entry.session.descriptor, entry.descriptor)) fail('SOURCE_MISMATCH');
  };
  const fresh = async (entry, stage) => {
    checkWait(entry);
    const snapshot = async () => {
      const saved = await sourceRecord(entry.callId);
      if (!same(saved, entry.descriptor)) fail('SOURCE_MISMATCH');
      const payload = await source.readPayload(saved.payloadRef);
      inspectDescriptor(saved, payload, entry.actor);
      if (nativeDigest(payload) !== entry.sourcePayloadDigest) fail('SOURCE_MISMATCH');
    };
    const admission = async () => {
      const allowed = await source.assertPublishable({ session: entry.session,
        actor: Object.freeze({ ...entry.actor }), descriptor: structuredClone(entry.descriptor),
        invocationId: entry.callId, stage, signal: entry.signal, deadlineAt: entry.deadlineAt });
      if (allowed !== true) fail('ADMISSION_BLOCKED');
    };
    await snapshot();
    await admission();
    await snapshot(); // A source snapshot changed during the admission check cannot be granted.
    await admission(); // The current lease, budget and goal blockers are checked last.
    const actor = controller.resolveNativeOriginalRun(entry.request, entry.claim);
    if (!same(actor, entry.actor)) fail('ACTOR_CHANGED');
    checkWait(entry);
  };
  const grant = async (entry) => {
    let admitted = false;
    try {
      await ledger.accept({ request: entry.request, claim: entry.claim,
        originEnvelope: entry.envelope, callId: entry.callId, ...entry.payload,
        beforeGrant: () => fresh(entry, 'grant') });
      admitted = true;
      entry.admitted = true;
      entry.invocation = ledger.invoke(entry.callId, entry.actor.goalId, {
        request: entry.request, claim: entry.claim,
        beforeInvoke: () => fresh(entry, 'invoke'),
        execute: async () => {
          checkWait(entry);
          entry.permit.resolve({ allowed: true });
          return entry.live.promise;
        },
      });
      entry.invocation.catch((error) => {
        entry.invocationError = error;
        entry.permit.resolve({ allowed: false, error });
      });
      const permit = await entry.permit.promise;
      if (!permit.allowed) throw permit.error;
      entry.state = 'issued';
      complete(entry, { allowed: true });
    } catch (error) {
      if (!admitted && error?.code === 'UNCERTAIN_SCOPE' && !entry.cancelRequested) {
        entry.state = 'blocked';
        entry.queue.active = null;
        entry.queue.waiting.unshift(entry);
        return;
      }
      entry.state = admitted ? 'held' : 'rejected';
      complete(entry, { allowed: false, error });
      if (!admitted) release(entry);
    }
  };
  const facade = {
    ledger,
    async publish(session, { request, claim, signal, deadlineAt } = {}) {
      if (!session || sessions.has(session) || typeof session.phase !== 'function'
        || typeof session.cancel !== 'function' || session.phase() !== 'prepared'
        || signal !== undefined && (typeof signal.addEventListener !== 'function'
          || typeof signal.removeEventListener !== 'function')
        || deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0)) fail('SESSION');
      if (closed) fail('CLOSED');
      const now = Date.now();
      if (deadlineAt !== undefined && deadlineAt > now + MAX_WAIT_MS) fail('SESSION');
      const publicationDeadlineAt = deadlineAt ?? now + MAX_WAIT_MS;
      const descriptor = structuredClone(session.descriptor);
      const actor = controller.resolveNativeOriginalRun(request, claim);
      const callId = descriptor?.receipt?.invocationId;
      if (typeof callId !== 'string' || !CALL_ID.test(callId)) fail('SESSION');
      const key = keyOf(actor.goalId, callId);
      if (entries.has(key)) fail('CHANGED_ORIGINAL');
      const queue = queueFor(actor.goalId);
      if (queue.waiting.length + (queue.active ? 1 : 0) >= MAX_GOAL_QUEUE
        || queued >= MAX_TOTAL_QUEUE) fail('CAPACITY');
      const entry = { session, request, claim, actor, descriptor, callId, queue,
        signal, deadlineAt: publicationDeadlineAt, state: 'validating', publication: deferred(),
        publicationDone: false, cancelRequested: false, admitted: false,
        permit: deferred(), live: deferred(), invocation: null, invocationError: null };
      entries.set(key, entry);
      sessions.set(session, { entry, goalId: actor.goalId, callId });
      queue.waiting.push(entry);
      queued++;
      entry.onAbort = () => abandon(entry, Object.assign(new Error('Native publication was stopped.'), { code: 'CANCELLED' }));
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      entry.timeout = setTimeout(() =>
        abandon(entry, Object.assign(new Error('Native publication deadline passed.'), { code: 'DEADLINE' })),
      Math.max(0, publicationDeadlineAt - Date.now()));
      if (signal?.aborted) entry.onAbort();
      try {
        if (entry.state !== 'abandoned') {
          const saved = await sourceRecord(callId);
          if (!same(saved, descriptor)) fail('SOURCE_MISMATCH');
          const payload = await source.readPayload(descriptor.payloadRef);
          inspectDescriptor(descriptor, payload, actor);
          entry.sourcePayloadDigest = nativeDigest(payload);
          entry.envelope = { invocationId: callId, lineageDigest: descriptor.lineage.digest };
          entry.payload = project(descriptor);
          entry.expectedTerminal = Object.freeze({
            expectedOwner: Object.freeze(structuredClone(descriptor.receipt.owner)),
            expectedLineageDigest: descriptor.lineage.digest,
            expectedDescriptorDigest: entry.payload.invocation.sourceDescriptorDigest,
            expectedWorkspace: actor.workspace,
          });
          if (entry.state === 'validating') { entry.state = 'waiting'; schedule(queue); }
        }
      } catch (error) {
        const alreadyAbandoned = entry.state === 'abandoned';
        abandon(entry, error);
        // Invalid source material never entered the owner ledger. A stopped
        // original stays reserved under its exact ID for local reconciliation.
        if (!alreadyAbandoned && !['CANCELLED', 'DEADLINE'].includes(error?.code)) {
          entries.delete(key); sessions.delete(session);
        }
      }
      const outcome = await entry.publication.promise;
      if (!outcome.allowed) throw outcome.error;
    },
    async acknowledgeLive(session) {
      const { entry, goalId, callId } = entryFor(session);
      if (!entry.invocation || entry.invocationError) fail('NO_ISSUE');
      const view = await ledger.status(callId, goalId);
      if (view.state !== 'uncertain' || view.invocationEffect !== 'uncertain') fail('NO_ISSUE');
      const original = await source.retainLive(session, view.owner, ledger.hostGeneration);
      if (!original || typeof original.handle !== 'object' || !original.handle
        || original.generation !== view.owner.generation) fail('LIVE_PROOF');
      entry.live.resolve(original);
      const confirmed = await entry.invocation;
      if (confirmed.state !== 'live' || !confirmed.handleRetained) fail('LIVE_PROOF');
      release(entry);
    },
    async acknowledgeSdkOutcome(session, outcome) {
      const { goalId, callId } = entryFor(session);
      if (session.phase() !== 'sdk-finished') fail('OUTCOME_ORDER');
      ledger.sdkFinished(callId, goalId, outcome);
    },
    async acknowledgeTerminalReady(session) {
      const { goalId, callId } = entryFor(session);
      ledger.terminalPrepared(callId, goalId);
    },
    async cancel(session) {
      const { entry, goalId, callId } = entryFor(session);
      if (!entry.admitted) {
        abandon(entry, Object.assign(new Error('Native publication was stopped.'), { code: 'CANCELLED' }));
        await session.cancel();
        return Object.freeze({ id: callId, state: 'not-issued', cancelled: true });
      }
      const view = await ledger.status(callId, goalId);
      if (view.state === 'terminal') return view;
      if (view.state === 'live' && session.phase() !== 'sdk-finished') {
        try { return await ledger.cancel(callId, goalId, () => session.cancel()); }
        catch (error) {
          if (error.code !== 'LOST_HANDLE') throw error;
          const after = await ledger.status(callId, goalId);
          if (after.state === 'terminal') return after;
        }
      }
      return ledger.cancelPending(callId, goalId, () => session.cancel());
    },
    async settle(session) {
      const { entry, goalId, callId } = entryFor(session);
      const result = await session.waitTerminal();
      if (!entry.admitted) return this.status(session);
      if (result?.state !== 'terminal' || result.outcome !== 'completed') {
        entry.live.resolve(null);
        return ledger.status(callId, goalId);
      }
      // Terminal-ready was an acknowledgement, not a release. Read the exact
      // source journal and absent hold through the ledger verifier only now.
      const terminal = await ledger.terminal(callId, goalId, { invocationId: callId });
      entry.live.resolve(null);
      release(entry);
      wake(goalId);
      return terminal;
    },
    status(session) {
      const { entry, goalId, callId } = entryFor(session);
      if (!entry.admitted) return Object.freeze({ id: callId,
        state: entry.state === 'abandoned' ? 'not-issued' : 'waiting',
        invocationEffect: 'not-started', handleRetained: false });
      return ledger.status(callId, goalId);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const queue of queues.values()) {
        for (const entry of [...queue.waiting]) abandon(entry,
          Object.assign(new Error('Native facade closed.'), { code: 'CLOSED' }));
        if (queue.active) abandon(queue.active,
          Object.assign(new Error('Native facade closed.'), { code: 'CLOSED' }));
      }
      ledger.close(); entries.clear(); queues.clear();
    },
  };
  return Object.freeze(facade);
}
