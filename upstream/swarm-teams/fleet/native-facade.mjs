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
    || ['readOrigin', 'readPayload', 'retainLive', 'probeLive', 'readTerminal']
      .some((method) => typeof source?.[method] !== 'function')) fail('CONFIG');
  const entries = new Map();
  const sessions = new WeakMap();
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
      const saved = await source.readTerminal(owner.invocationId);
      if (saved?.receipt?.invocationId !== owner.invocationId
        || !same(saved.receipt.owner, entry.session.descriptor.receipt.owner)
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
      archiveAdapter: descriptor.archive.adapter, archiveOperation: descriptor.archive.operation },
  });
  const facade = {
    ledger,
    async publish(session, { request, claim }) {
      if (!session || sessions.has(session) || typeof session.phase !== 'function'
        || typeof session.cancel !== 'function' || session.phase() !== 'prepared') fail('SESSION');
      const descriptor = session.descriptor;
      const actor = controller.resolveNativeOriginalRun(request, claim);
      const saved = await sourceRecord(descriptor?.receipt?.invocationId);
      if (!same(saved, descriptor)) fail('SOURCE_MISMATCH');
      const payload = await source.readPayload(descriptor.payloadRef);
      inspectDescriptor(descriptor, payload, actor);
      const callId = descriptor.receipt.invocationId;
      const envelope = { invocationId: callId, lineageDigest: descriptor.lineage.digest };
      const projected = project(descriptor);
      const entry = { session, request, claim, envelope, payload: projected,
        permit: deferred(), live: deferred(), invocation: null, invocationError: null };
      const key = keyOf(actor.goalId, callId);
      if (entries.has(key)) fail('CHANGED_ORIGINAL');
      entries.set(key, entry);
      sessions.set(session, { entry, goalId: actor.goalId, callId });
      let admitted = false;
      try {
        await ledger.accept({ request, claim, originEnvelope: envelope, callId, ...projected });
        admitted = true;
        // Do not await ledger.invoke here. Its execute callback releases only the
        // preissue permit, while the promise awaits a later confirmed-live event.
        entry.invocation = ledger.invoke(callId, actor.goalId, { request, claim,
          execute: async () => { entry.permit.resolve({ allowed: true }); return entry.live.promise; } });
        entry.invocation.catch((error) => {
          entry.invocationError = error;
          entry.permit.resolve({ allowed: false, error });
        });
        const permit = await entry.permit.promise;
        if (!permit.allowed) throw permit.error;
      } catch (error) {
        // Once accepted, any uncertain original remains in the ledger. Source
        // publication rejects and its own journal retains the same ID.
        if (!admitted) { entries.delete(key); sessions.delete(session); }
        throw error;
      }
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
      const { goalId, callId } = entryFor(session);
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
      if (result?.state !== 'terminal' || result.outcome !== 'completed') {
        entry.live.resolve(null);
        return ledger.status(callId, goalId);
      }
      // Terminal-ready was an acknowledgement, not a release. Read the exact
      // source journal and absent hold through the ledger verifier only now.
      const terminal = await ledger.terminal(callId, goalId, { invocationId: callId });
      entry.live.resolve(null);
      return terminal;
    },
    status(session) {
      const { goalId, callId } = entryFor(session);
      return ledger.status(callId, goalId);
    },
    close() { ledger.close(); entries.clear(); },
  };
  return Object.freeze(facade);
}
