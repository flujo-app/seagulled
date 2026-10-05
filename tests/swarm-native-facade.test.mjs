import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../upstream/swarm-teams/fleet/controller.mjs';
import { createNativeInvocationFacade } from '../upstream/swarm-teams/fleet/native-facade.mjs';

const canonical = (value) => value === null || typeof value !== 'object'
  ? JSON.stringify(value) ?? 'null'
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
const nativeDigest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const hasCode = (code) => (error) => error.code === code;

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swarm-native-facade-'));
  const controller = new Controller({ registryPath: path.join(directory, 'registry.json'),
    operatorToken: 'native-facade-offline-operator-token-32', publicUrl: 'http://127.0.0.1:1' });
  const registry = controller.registry;
  const goal = registry.createGoal({ id: 'goal-facade', text: 'Offline original' });
  const parent = registry.reserve({ goalId: goal.id, name: 'parent' });
  registry.enroll(parent.worker.id, { kind: 'fly', app: 'parent-app', org: 'fixture',
    machineId: 'parent-machine', workspace: 'parent-workspace' });
  const lead = registry.reserve({ goalId: goal.id, parentId: parent.worker.id, name: 'lead' });
  registry.enroll(lead.worker.id, { kind: 'fly', app: 'lead-app', org: 'fixture',
    machineId: 'lead-machine', workspace: 'lead-workspace' });
  const run = registry.startRun({ workerId: lead.worker.id, startedBy: parent.worker.id,
    task: 'Original task', flowName: 'swarm_team' });
  registry.bindRunTarget(run.id, lead.worker.target);
  const request = { headers: { authorization: `Bearer ${lead.token}` } };
  const claim = { runId: run.id, rootConversationId: run.conversationId,
    goalId: goal.id, workspace: lead.worker.target.workspace };
  const saved = new Map();
  const terminals = new Map();
  const handles = new Map();
  let issued = false;
  const source = {
    readOrigin: async (id) => structuredClone(saved.get(id)),
    readPayload: async (ref) => structuredClone(saved.get(ref.invocationId)?.payload),
    retainLive: async (session, owner) => {
      if (!issued || session.phase() !== 'issue-uncertain') return null;
      const handle = { originalId: session.descriptor.receipt.invocationId, alive: true };
      handles.set(handle.originalId, handle);
      return { handle, generation: owner.generation };
    },
    probeLive: (handle, owner) => handle.alive && handle.originalId === owner.invocationId ? handle : null,
    readTerminal: async (id) => structuredClone(terminals.get(id)),
  };
  const facade = createNativeInvocationFacade({ directory: path.join(directory, 'host-ledger'), controller, source });
  const make = (id = 'original-one') => {
    const actor = controller.resolveNativeOriginalRun(request, claim);
    const owner = { conversationId: run.conversationId, runId: 'logical-root', nodeId: 'node-one',
      modelId: 'model-one', leaseEpoch: 'lease-one', inventoryDigest: 'inventory-one',
      inputDigest: 'hydrated-model-input-one', attemptOrdinal: 1 };
    const receipt = { invocationId: id, owner, state: 'begin-may-have-been-sent', createdAt: 1 };
    const payload = { invocationId: id, archive: { sdkRequest: { model: 'fixture', prompt: 'saved' },
      genericWire: [{ role: 'user', content: 'saved' }], media: [] },
      inventory: { tools: [], bindings: {}, syntheticNames: [] } };
    const lineage = { version: 1, invocationId: id, installationId: 'source-installation-one',
      modelId: owner.modelId, attemptOrdinal: owner.attemptOrdinal,
      leaseEpoch: owner.leaseEpoch, inputDigest: owner.inputDigest,
      inventoryDigest: owner.inventoryDigest, workerId: actor.workerId, goalId: actor.goalId,
      fleetRunId: actor.fleetRunId, rootConversationId: actor.rootConversationId,
      workspace: actor.workspace, originConversationId: owner.conversationId,
      originLogicalRunId: owner.runId, originNodeId: owner.nodeId, edges: [] };
    lineage.digest = nativeDigest(lineage);
    const descriptor = { receipt, lineage,
      archive: { dispatchId: id, adapter: 'codex-cli', operation: 'thread.runStreamed',
        sanitizedSdkRequestDigest: nativeDigest(payload.archive.sdkRequest),
        sanitizedGenericWireDigest: nativeDigest(payload.archive.genericWire), mediaCount: 0 },
      inventory: { digest: owner.inventoryDigest, toolCount: 0 },
      payloadRef: { kind: 'private-native-session-payload', invocationId: id,
        sha256: 'a'.repeat(64), byteLength: 100 } };
    saved.set(id, { ...structuredClone(descriptor), payload });
    // The trusted source reader returns the descriptor reconstructed from its
    // saved records; the private payload is read separately by its reference.
    source.readOrigin = async (callId) => {
      const record = saved.get(callId);
      if (!record) return null;
      const { payload: _payload, ...sourceDescriptor } = record;
      return structuredClone(sourceDescriptor);
    };
    let phase = 'prepared';
    let settle;
    const terminal = new Promise((resolve) => { settle = resolve; });
    let cancelled = false;
    const session = { descriptor, phase: () => phase, cancel: () => { cancelled = true; },
      waitTerminal: () => terminal };
    return { id, session, descriptor, payload,
      setPhase: (value) => { phase = value; },
      finish: (value, { holdAbsent = true, effectsResolved = true, cancelResolved = false } = {}) => {
        phase = value.state;
        if (value.state === 'terminal') terminals.set(id, { receipt: { ...receipt,
          state: 'terminal', outcome: value.outcome }, holdAbsent, effectsResolved, cancelResolved });
        settle(value);
      },
      cancelled: () => cancelled };
  };
  const close = async () => {
    facade.close();
    await controller.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { directory, controller, registry, goal, lead, run, request, claim,
    facade, source, saved, terminals, handles, make, setIssued: (value) => { issued = value; }, close };
}

test('publication persists accepted and issue-uncertain before one SDK permit; live needs later source probe', async () => {
  const f = fixture();
  try {
    const original = f.make();
    await f.facade.publish(original.session, { request: f.request, claim: f.claim });
    const file = readdirSync(path.join(f.directory, 'host-ledger')).find((name) => name.endsWith('.json'));
    const saved = JSON.parse(readFileSync(path.join(f.directory, 'host-ledger', file), 'utf8'));
    const entry = saved.records[original.id];
    assert.equal(entry.state, 'uncertain');
    assert.equal(entry.invocationEffect, 'uncertain');
    assert.equal(entry.payload.input.sourceModelInputDigest, 'hydrated-model-input-one');
    assert.equal(entry.payload.input.sanitizedSdkRequestDigest, original.descriptor.archive.sanitizedSdkRequestDigest);
    assert.notEqual(entry.payload.input.sourceModelInputDigest, entry.payload.input.sanitizedSdkRequestDigest);
    await assert.rejects(f.facade.acknowledgeLive(original.session), hasCode('LIVE_PROOF'));
    original.setPhase('issue-uncertain');
    f.setIssued(true);
    await f.facade.acknowledgeLive(original.session);
    assert.equal((await f.facade.status(original.session)).state, 'live');
    original.setPhase('sdk-finished');
    f.handles.get(original.id).alive = false;
    await f.facade.acknowledgeSdkOutcome(original.session, 'completed');
    await f.facade.acknowledgeTerminalReady(original.session);
    assert.equal((await f.facade.status(original.session)).terminalReady, true);
    original.finish({ state: 'terminal', outcome: 'completed' });
    assert.equal((await f.facade.settle(original.session)).state, 'terminal');
  } finally { await f.close(); }
});

test('terminal-only output remains uncertain until exact source terminal readback clears the hold', async () => {
  const f = fixture();
  try {
    const original = f.make('terminal-only');
    await f.facade.publish(original.session, { request: f.request, claim: f.claim });
    f.setIssued(true);
    original.setPhase('sdk-finished');
    await f.facade.acknowledgeSdkOutcome(original.session, 'completed');
    await f.facade.acknowledgeTerminalReady(original.session);
    assert.equal((await f.facade.status(original.session)).state, 'uncertain');
    original.finish({ state: 'terminal', outcome: 'completed' }, { holdAbsent: false });
    await assert.rejects(f.facade.settle(original.session), hasCode('TERMINAL_PROOF'));
    assert.equal((await f.facade.status(original.session)).state, 'uncertain');
    const second = f.make('other-id');
    await assert.rejects(f.facade.publish(second.session, { request: f.request, claim: f.claim }), hasCode('UNCERTAIN_SCOPE'));
  } finally { await f.close(); }
});

test('terminal-only completion needs no fabricated live handle but does need saved source release', async () => {
  const f = fixture();
  try {
    const original = f.make('terminal-without-live');
    await f.facade.publish(original.session, { request: f.request, claim: f.claim });
    f.setIssued(true);
    original.setPhase('sdk-finished');
    await f.facade.acknowledgeSdkOutcome(original.session, 'completed');
    await f.facade.acknowledgeTerminalReady(original.session);
    assert.equal((await f.facade.status(original.session)).state, 'uncertain');
    original.finish({ state: 'terminal', outcome: 'completed' });
    const done = await f.facade.settle(original.session);
    assert.equal(done.state, 'terminal');
    assert.equal(done.handleRetained, false);
    assert.equal(f.handles.size, 0);
  } finally { await f.close(); }
});

test('lost live acknowledgement and same-ID publication never permit a second issue', async () => {
  const f = fixture();
  try {
    const original = f.make();
    await f.facade.publish(original.session, { request: f.request, claim: f.claim });
    f.setIssued(true);
    original.setPhase('issue-uncertain');
    f.source.retainLive = async () => null;
    await assert.rejects(f.facade.acknowledgeLive(original.session), hasCode('LIVE_PROOF'));
    assert.equal((await f.facade.status(original.session)).state, 'uncertain');
    await assert.rejects(f.facade.publish(f.make(original.id).session,
      { request: f.request, claim: f.claim }), hasCode('CHANGED_ORIGINAL'));
    original.finish({ state: 'held' });
    assert.equal((await f.facade.settle(original.session)).state, 'uncertain');
  } finally { await f.close(); }
});

test('source payload drift and retired Worker fail before any SDK permit', async () => {
  const f = fixture();
  try {
    const original = f.make();
    f.saved.get(original.id).payload.archive.sdkRequest.prompt = 'changed';
    await assert.rejects(f.facade.publish(original.session, { request: f.request, claim: f.claim }), hasCode('SOURCE_MISMATCH'));
    assert.equal(readdirSync(path.join(f.directory, 'host-ledger')).filter((name) => name.endsWith('.json')).length, 0);
    const retired = f.make('retired');
    f.registry.retire(f.lead.worker.id);
    await assert.rejects(f.facade.publish(retired.session, { request: f.request, claim: f.claim }));
  } finally { await f.close(); }
});

test('source archive dispatch ID must be the original invocation ID before permit', async () => {
  const f = fixture();
  try {
    const original = f.make();
    original.descriptor.archive.dispatchId = 'different-dispatch';
    f.saved.get(original.id).archive.dispatchId = 'different-dispatch';
    await assert.rejects(f.facade.publish(original.session,
      { request: f.request, claim: f.claim }), hasCode('SOURCE_MISMATCH'));
    assert.equal(readdirSync(path.join(f.directory, 'host-ledger'))
      .filter((name) => name.endsWith('.json')).length, 0);
  } finally { await f.close(); }
});

test('Stop after SDK finish journals the same cancel and a held source cannot release it', async () => {
  const f = fixture();
  try {
    const original = f.make();
    await f.facade.publish(original.session, { request: f.request, claim: f.claim });
    original.setPhase('issue-uncertain');
    f.setIssued(true);
    await f.facade.acknowledgeLive(original.session);
    original.setPhase('sdk-finished');
    f.handles.get(original.id).alive = false;
    await f.facade.acknowledgeSdkOutcome(original.session, 'completed');
    const first = await f.facade.cancel(original.session);
    const second = await f.facade.cancel(original.session);
    assert.equal(first.cancel.id, second.cancel.id);
    assert.equal(original.cancelled(), true);
    original.finish({ state: 'held' });
    const held = await f.facade.settle(original.session);
    assert.equal(held.state, 'uncertain');
    assert.equal(held.terminal, null);
  } finally { await f.close(); }
});
