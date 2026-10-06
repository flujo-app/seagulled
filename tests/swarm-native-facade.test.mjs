import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '@flujo-app/swarm-teams/fleet/controller.mjs';
import { createNativeInvocationFacade } from '@flujo-app/swarm-teams/fleet/native-facade.mjs';

const canonical = (value) => value === null || typeof value !== 'object'
  ? JSON.stringify(value) ?? 'null'
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
const nativeDigest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const hasCode = (code) => (error) => error.code === code;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swarm-native-facade-'));
  const controller = new Controller({ registryPath: path.join(directory, 'registry.json'),
    operatorToken: 'native-facade-offline-operator-token-32', publicUrl: 'http://127.0.0.1:1' });
  const registry = controller.registry;
  const goal = registry.createGoal({ id: 'goal-facade', text: 'Offline original',
    limits: { maxWorkers: 100, maxChildren: 100 } });
  const parent = registry.reserve({ goalId: goal.id, name: 'parent' });
  registry.enroll(parent.worker.id, { kind: 'fly', app: 'parent-app', org: 'fixture',
    machineId: 'parent-machine', workspace: 'parent-workspace' });
  const addWorker = (name = 'lead') => {
    const lead = registry.reserve({ goalId: goal.id, parentId: parent.worker.id, name });
    registry.enroll(lead.worker.id, { kind: 'fly', app: `${name}-app`, org: 'fixture',
      machineId: `${name}-machine`, workspace: `${name}-workspace` });
    const run = registry.startRun({ workerId: lead.worker.id, startedBy: parent.worker.id,
      task: 'Original task', flowName: 'swarm_team' });
    registry.bindRunTarget(run.id, lead.worker.target);
    const request = { headers: { authorization: `Bearer ${lead.token}` } };
    const claim = { runId: run.id, rootConversationId: run.conversationId,
      goalId: goal.id, workspace: lead.worker.target.workspace };
    return { lead, run, request, claim };
  };
  const { lead, run, request, claim } = addWorker();
  const saved = new Map();
  const terminals = new Map();
  const terminalReads = [];
  const handles = new Map();
  let issued = false;
  const source = {
    readOrigin: async (id) => structuredClone(saved.get(id)),
    readPayload: async (ref) => structuredClone(saved.get(ref.invocationId)?.payload),
    assertPublishable: async () => true,
    retainLive: async (session, owner) => {
      if (!issued || session.phase() !== 'issue-uncertain') return null;
      const handle = { originalId: session.descriptor.receipt.invocationId, alive: true };
      handles.set(handle.originalId, handle);
      return { handle, generation: owner.generation };
    },
    probeLive: (handle, owner) => handle.alive && handle.originalId === owner.invocationId ? handle : null,
    readTerminal: async (id, expected) => {
      terminalReads.push({ id, expected: structuredClone(expected) });
      const current = saved.get(id);
      if (!current) return null;
      const { payload: _payload, ...descriptor } = current;
      if (nativeDigest(descriptor) !== expected.expectedDescriptorDigest
        || JSON.stringify(descriptor.receipt.owner) !== JSON.stringify(expected.expectedOwner)
        || descriptor.lineage.digest !== expected.expectedLineageDigest
        || descriptor.lineage.workspace !== expected.expectedWorkspace) return null;
      return structuredClone(terminals.get(id));
    },
  };
  const facade = createNativeInvocationFacade({ directory: path.join(directory, 'host-ledger'), controller, source });
  const make = (id = 'original-one', origin = { run, request, claim }) => {
    const actor = controller.resolveNativeOriginalRun(origin.request, origin.claim);
    const owner = { conversationId: origin.run.conversationId, runId: 'logical-root', nodeId: 'node-one',
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
      finish: (value, { holdAbsent = true, effectsResolved = true } = {}) => {
        phase = value.state;
        if (value.state === 'terminal') terminals.set(id, { receipt: { ...receipt,
          state: 'terminal', outcome: value.outcome }, holdAbsent, effectsResolved });
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
    facade, source, saved, terminals, terminalReads, handles, make, addWorker,
    setIssued: (value) => { issued = value; }, close };
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
    assert.equal(entry.payload.invocation.sourceDescriptorDigest, nativeDigest(original.descriptor));
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

for (const count of [5, 25, 60]) {
  test(`${count} distinct Worker originals receive FIFO permits only after prior live proof`, async () => {
    const f = fixture();
    try {
      const originals = Array.from({ length: count }, (_, index) => {
        const origin = index === 0 ? { run: f.run, request: f.request, claim: f.claim }
          : f.addWorker(`worker-${index}`);
        return { ...f.make(`original-${index}`, origin), origin };
      });
      const publications = originals.map(({ session, origin }) =>
        f.facade.publish(session, { request: origin.request, claim: origin.claim }));
      await publications[0];
      assert.equal((await f.facade.status(originals[0].session)).state, 'uncertain');
      for (let index = 1; index < count; index++) {
        assert.equal((await f.facade.status(originals[index].session)).state, 'waiting');
      }
      const goalFile = readdirSync(path.join(f.directory, 'host-ledger'))
        .find((name) => name.endsWith('.json'));
      assert.equal(Object.keys(JSON.parse(readFileSync(path.join(f.directory,
        'host-ledger', goalFile), 'utf8')).records).length, 1,
      'waiting originals have no ledger grant or SDK publication permit');
      f.setIssued(true);
      for (let index = 0; index < count; index++) {
        originals[index].setPhase('issue-uncertain');
        await f.facade.acknowledgeLive(originals[index].session);
        if (index + 1 < count) {
          await publications[index + 1];
          assert.equal((await f.facade.status(originals[index + 1].session)).state, 'uncertain');
        }
      }
      assert.equal(f.handles.size, count);
      assert.equal(Object.keys(JSON.parse(readFileSync(path.join(f.directory,
        'host-ledger', goalFile), 'utf8')).records).length, count);
    } finally { await f.close(); }
  });
}

test('exact durable terminal proof wakes a queued original without fabricated live retention', async () => {
  const f = fixture();
  try {
    const first = f.make('terminal-first');
    const secondOrigin = f.addWorker('terminal-second');
    const second = f.make('terminal-second', secondOrigin);
    await f.facade.publish(first.session, { request: f.request, claim: f.claim });
    const waiting = f.facade.publish(second.session,
      { request: secondOrigin.request, claim: secondOrigin.claim });
    await tick();
    assert.equal((await f.facade.status(second.session)).state, 'waiting');
    first.setPhase('sdk-finished');
    await f.facade.acknowledgeSdkOutcome(first.session, 'completed');
    await f.facade.acknowledgeTerminalReady(first.session);
    first.finish({ state: 'terminal', outcome: 'completed' });
    assert.equal((await f.facade.settle(first.session)).state, 'terminal');
    await waiting;
    assert.equal((await f.facade.status(second.session)).state, 'uncertain');
  } finally { await f.close(); }
});

test('Stop and deadline remove waiting IDs without granting a permit or allowing same-ID replay', async () => {
  const f = fixture();
  try {
    const first = f.make('stop-first');
    await f.facade.publish(first.session, { request: f.request, claim: f.claim });
    const second = f.make('stopped-original');
    const stop = new AbortController();
    const stopped = f.facade.publish(second.session, { request: f.request, claim: f.claim,
      signal: stop.signal });
    const third = f.make('deadline-original');
    const expired = f.facade.publish(third.session, { request: f.request, claim: f.claim,
      deadlineAt: Date.now() + 20 });
    await tick();
    stop.abort();
    await assert.rejects(stopped, hasCode('CANCELLED'));
    await assert.rejects(expired, hasCode('DEADLINE'));
    await assert.rejects(f.facade.publish(f.make(second.id).session,
      { request: f.request, claim: f.claim }), hasCode('CHANGED_ORIGINAL'));
    assert.equal((await f.facade.status(second.session)).state, 'not-issued');
    const file = readdirSync(path.join(f.directory, 'host-ledger')).find((name) => name.endsWith('.json'));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(f.directory,
      'host-ledger', file), 'utf8')).records), [first.id]);
  } finally { await f.close(); }
});

test('queued originals recheck actor and saved source snapshot before a journal grant', async () => {
  for (const drift of ['actor', 'source']) {
    const f = fixture();
    try {
      const first = f.make(`first-${drift}`);
      const origin = f.addWorker(`second-${drift}`);
      const second = f.make(`second-${drift}`, origin);
      await f.facade.publish(first.session, { request: f.request, claim: f.claim });
      const waiting = f.facade.publish(second.session,
        { request: origin.request, claim: origin.claim });
      await tick();
      if (drift === 'actor') {
        f.registry.settleRun(origin.run.id, { status: 'completed', output: 'stale' });
      } else {
        f.saved.get(second.id).payload.archive.sdkRequest.prompt = 'changed after queue';
      }
      first.setPhase('issue-uncertain'); f.setIssued(true);
      await f.facade.acknowledgeLive(first.session);
      await assert.rejects(waiting, drift === 'source' ? hasCode('SOURCE_MISMATCH')
        : (error) => error.code === 'FORBIDDEN' || error.code === 'ACTOR_CHANGED');
      const file = readdirSync(path.join(f.directory, 'host-ledger')).find((name) => name.endsWith('.json'));
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(f.directory,
        'host-ledger', file), 'utf8')).records), [first.id]);
    } finally { await f.close(); }
  }
});

test('lease or budget loss between grant and invoke preserves the accepted exact ID without SDK permit', async () => {
  const f = fixture();
  try {
    const original = f.make('budget-stopped');
    const stages = [];
    f.source.assertPublishable = async ({ invocationId, stage }) => {
      if (invocationId === original.id) stages.push(stage);
      return stage !== 'invoke';
    };
    await assert.rejects(f.facade.publish(original.session,
      { request: f.request, claim: f.claim }), hasCode('ADMISSION_BLOCKED'));
    assert.deepEqual(stages, ['grant', 'grant', 'invoke']);
    const saved = await f.facade.status(original.session);
    assert.equal(saved.state, 'accepted');
    assert.equal(saved.invocationEffect, 'not-started');
    assert.equal(original.session.phase(), 'prepared');
    const sibling = f.make('budget-sibling');
    const stop = new AbortController();
    const waiting = f.facade.publish(sibling.session, { request: f.request, claim: f.claim,
      signal: stop.signal });
    await tick();
    assert.equal((await f.facade.status(sibling.session)).state, 'waiting');
    stop.abort();
    await assert.rejects(waiting, hasCode('CANCELLED'));
  } finally { await f.close(); }
});

test('a current goal-wide admission blocker refuses the queued original before its grant', async () => {
  const f = fixture();
  try {
    const first = f.make('goal-block-first');
    const second = f.make('goal-block-second');
    let blocked = false;
    f.source.assertPublishable = async ({ invocationId }) =>
      invocationId !== second.id || !blocked;
    await f.facade.publish(first.session, { request: f.request, claim: f.claim });
    const waiting = f.facade.publish(second.session, { request: f.request, claim: f.claim });
    await tick();
    blocked = true;
    first.setPhase('issue-uncertain'); f.setIssued(true);
    await f.facade.acknowledgeLive(first.session);
    await assert.rejects(waiting, hasCode('ADMISSION_BLOCKED'));
    const file = readdirSync(path.join(f.directory, 'host-ledger')).find((name) => name.endsWith('.json'));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(f.directory,
      'host-ledger', file), 'utf8')).records), [first.id]);
  } finally { await f.close(); }
});

test('source drift during final admission and Stop before invoke cannot yield a permit', async () => {
  for (const drift of ['source', 'stop']) {
    const f = fixture();
    try {
      const original = f.make(`final-${drift}`);
      const stop = new AbortController();
      let changed = false;
      f.source.assertPublishable = async ({ stage }) => {
        if (drift === 'source' && stage === 'grant' && !changed) {
          f.saved.get(original.id).payload.archive.sdkRequest.prompt = 'changed during grant';
          changed = true;
        }
        if (drift === 'stop' && stage === 'invoke' && !changed) {
          stop.abort(); changed = true;
        }
        return true;
      };
      await assert.rejects(f.facade.publish(original.session,
        { request: f.request, claim: f.claim, signal: stop.signal }),
      hasCode(drift === 'source' ? 'SOURCE_MISMATCH' : 'CANCELLED'));
      assert.equal(original.session.phase(), 'prepared');
      const files = readdirSync(path.join(f.directory, 'host-ledger')).filter((name) => name.endsWith('.json'));
      if (drift === 'stop') {
        const record = JSON.parse(readFileSync(path.join(f.directory, 'host-ledger', files[0]), 'utf8'))
          .records[original.id];
        assert.equal(record.state, 'accepted');
        assert.equal(record.invocationEffect, 'not-started');
      } else assert.equal(files.length, 0);
    } finally { await f.close(); }
  }
});

test('closing during an active grant or invoke rejects promptly without an SDK permit', async () => {
  for (const stageToHold of ['grant', 'invoke']) {
    const f = fixture();
    let resume;
    try {
      const original = f.make(`close-${stageToHold}`);
      let entered;
      const reached = new Promise((resolve) => { entered = resolve; });
      const held = new Promise((resolve) => { resume = resolve; });
      let blocked = false;
      f.source.assertPublishable = async ({ stage }) => {
        if (stage === stageToHold && !blocked) {
          blocked = true; entered(); await held;
        }
        return true;
      };
      const publication = f.facade.publish(original.session,
        { request: f.request, claim: f.claim });
      await reached;
      f.facade.close();
      await assert.rejects(publication, hasCode('CLOSED'));
      assert.equal(original.session.phase(), 'prepared');
      const files = readdirSync(path.join(f.directory, 'host-ledger')).filter((name) => name.endsWith('.json'));
      if (stageToHold === 'invoke') {
        const record = JSON.parse(readFileSync(path.join(f.directory, 'host-ledger', files[0]), 'utf8'))
          .records[original.id];
        assert.equal(record.state, 'accepted');
        assert.equal(record.invocationEffect, 'not-started');
      } else assert.equal(files.length, 0);
      resume();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally { resume?.(); await f.close(); }
  }
});

test('an admitted sibling retains same-ID status and cancellation after another live handle is lost', async () => {
  const f = fixture();
  try {
    const first = f.make('sibling-first');
    const second = f.make('sibling-second');
    await f.facade.publish(first.session, { request: f.request, claim: f.claim });
    const waiting = f.facade.publish(second.session, { request: f.request, claim: f.claim });
    f.setIssued(true);
    first.setPhase('issue-uncertain');
    await f.facade.acknowledgeLive(first.session);
    await waiting;
    second.setPhase('issue-uncertain');
    await f.facade.acknowledgeLive(second.session);
    f.handles.get(first.id).alive = false;
    assert.equal((await f.facade.status(first.session)).state, 'uncertain');
    assert.equal((await f.facade.status(second.session)).state, 'live');
    const firstCancel = await f.facade.cancel(second.session);
    const repeated = await f.facade.cancel(second.session);
    assert.equal(firstCancel.cancel.id, repeated.cancel.id);
    assert.equal(second.cancelled(), true);
  } finally { await f.close(); }
});

test('lost live handle blocks queued scope until exact durable terminal proof', async () => {
  const f = fixture();
  try {
    const first = f.make('lost-first');
    const second = f.make('lost-second');
    let probes = 0;
    f.source.probeLive = (handle) => ++probes === 1 ? handle : null;
    await f.facade.publish(first.session, { request: f.request, claim: f.claim });
    const waiting = f.facade.publish(second.session, { request: f.request, claim: f.claim });
    first.setPhase('issue-uncertain'); f.setIssued(true);
    await f.facade.acknowledgeLive(first.session);
    await tick();
    assert.equal((await f.facade.status(first.session)).state, 'uncertain');
    assert.equal((await f.facade.status(second.session)).state, 'waiting');
    first.setPhase('sdk-finished');
    await f.facade.acknowledgeSdkOutcome(first.session, 'completed');
    await f.facade.acknowledgeTerminalReady(first.session);
    first.finish({ state: 'terminal', outcome: 'completed' });
    assert.equal((await f.facade.settle(first.session)).state, 'terminal');
    await waiting;
    assert.equal((await f.facade.status(second.session)).state, 'uncertain');
  } finally { await f.close(); }
});

test('the in-memory publication queue has a fixed per-goal cap before ledger mutation', async () => {
  const f = fixture();
  const waiting = [];
  try {
    const originals = Array.from({ length: 65 }, (_, index) => f.make(`bounded-${index}`));
    for (let index = 0; index < 64; index++) {
      waiting.push(f.facade.publish(originals[index].session,
        { request: f.request, claim: f.claim }));
    }
    await waiting[0];
    await assert.rejects(f.facade.publish(originals[64].session,
      { request: f.request, claim: f.claim }), hasCode('CAPACITY'));
    assert.equal((await f.facade.status(originals[63].session)).state, 'waiting');
    assert.throws(() => f.facade.status(originals[64].session), hasCode('UNKNOWN_SESSION'));
  } finally {
    f.facade.close();
    await Promise.allSettled(waiting);
    await f.close();
  }
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
    const stop = new AbortController();
    const queued = f.facade.publish(second.session, { request: f.request, claim: f.claim,
      signal: stop.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await f.facade.status(second.session)).state, 'waiting');
    stop.abort();
    await assert.rejects(queued, hasCode('CANCELLED'));
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

test('terminal reader receives the accepted descriptor digest and rejects a coherent replacement', async () => {
  const f = fixture();
  try {
    const original = f.make('terminal-descriptor-replacement');
    const acceptedDigest = nativeDigest(original.descriptor);
    const originalOwner = structuredClone(original.descriptor.receipt.owner);
    const originalWorkspace = f.controller.resolveNativeOriginalRun(f.request, f.claim).workspace;
    await f.facade.publish(original.session, { request: f.request, claim: f.claim });
    original.setPhase('sdk-finished');
    await f.facade.acknowledgeSdkOutcome(original.session, 'completed');
    await f.facade.acknowledgeTerminalReady(original.session);
    // This replacement preserves its owner, lineage, payload and internal digests.
    // Only the original accepted descriptor digest distinguishes it.
    f.saved.get(original.id).archive.adapter = 'claude-subscription';
    original.finish({ state: 'terminal', outcome: 'completed' });
    await assert.rejects(f.facade.settle(original.session), hasCode('TERMINAL_PROOF'));
    assert.deepEqual(f.terminalReads, [{ id: original.id, expected: {
      expectedOwner: originalOwner,
      expectedLineageDigest: original.descriptor.lineage.digest,
      expectedDescriptorDigest: acceptedDigest,
      expectedWorkspace: originalWorkspace,
    } }]);
    assert.equal((await f.facade.status(original.session)).state, 'uncertain');
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
