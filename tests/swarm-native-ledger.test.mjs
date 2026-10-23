import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NativeOriginalLedger } from '../upstream/swarm-teams/fleet/native-ledger.mjs';

const hasCode = (code) => (error) => error.code === code;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-original-ledger-'));
  const actors = new Map();
  const lineage = new Map();
  const terminals = new Map();
  const handles = new WeakMap();
  const originals = new Map();
  const submitted = new Map();
  let originGate = async () => undefined;
  let probeGate = async () => undefined;
  let terminalGate = async () => undefined;
  const options = {
    directory,
    resolveActor: (request) => actors.get(request.token) ?? null,
    verifyOrigin: async (envelope, actor, expected) => {
      await originGate();
      const saved = lineage.get(envelope.opaque);
      if (!saved || saved.workerId !== actor.workerId
        || ['invocationId', 'envelopeDigest', 'inputDigest', 'inventoryDigest', 'invocationDigest']
          .some((field) => saved[field] !== expected[field])) return null;
      return saved;
    },
    probeOriginalHandle: async (handle, owner, hostGeneration) => {
      await probeGate(handle, owner);
      const saved = handles.get(handle);
      if (!saved?.active || saved.invocationId !== owner.invocationId
        || saved.goalId !== owner.goalId) return null;
      if (saved.hostGeneration && saved.hostGeneration !== hostGeneration) return null;
      saved.hostGeneration = hostGeneration;
      return handle;
    },
    verifyTerminal: async (proof, owner) => {
      await terminalGate(proof, owner);
      const saved = terminals.get(proof);
      return saved?.owner === owner.conversationId ? saved : null;
    },
  };
  const ledger = new NativeOriginalLedger(options);
  const actor = (name, goalId = 'goal-one') => {
    const trusted = Object.freeze({ workerId: `worker-${name}`, goalId,
      fleetRunId: `run-${name}`, rootConversationId: `root-${name}`,
      workspace: `workspace-${name}`, targetDigest: `digest-${name}` });
    const request = { token: `private-token-${name}` };
    actors.set(request.token, trusted);
    return { trusted, request };
  };
  const origin = (who, conversationId, generation = 'generation-one') =>
    ({ who, conversationId, generation });
  const input = (who, source, callId, body = { prompt: 'bounded input' }) => {
    const args = { request: who.request, claim: { runId: who.trusted.fleetRunId },
      originEnvelope: { opaque: `${source.conversationId}-${callId}` }, callId,
      input: body, inventory: { generation: 'catalog-one', tools: ['private-tool'] },
      invocation: { model: 'fixture', operation: 'original-call' } };
    lineage.set(args.originEnvelope.opaque, Object.freeze({ ...who.trusted,
      conversationId: source.conversationId, generation: source.generation,
      logicalRunId: `logical-${who.trusted.workerId}`, nodeId: `node-${source.conversationId}`,
      invocationId: callId, envelopeDigest: hash(args.originEnvelope),
      inputDigest: hash(args.input), inventoryDigest: hash(args.inventory),
      invocationDigest: hash(args.invocation) }));
    submitted.set(JSON.stringify([who.trusted.goalId, callId]), args);
    return args;
  };
  const live = (owner) => {
    const handle = { id: owner.invocationId };
    handles.set(handle, { active: true, invocationId: owner.invocationId, goalId: owner.goalId });
    originals.set(JSON.stringify([owner.goalId, owner.invocationId]), handle);
    return { handle, generation: owner.generation };
  };
  const invokeOn = (target, callId, goalId, execute) => {
    const args = submitted.get(JSON.stringify([goalId, callId]));
    return target.invoke(callId, goalId, { request: args.request, claim: args.claim, execute });
  };
  const invoke = (callId, goalId, execute) => invokeOn(ledger, callId, goalId, execute);
  const kill = (goalId, callId) => { handles.get(originals.get(JSON.stringify([goalId, callId]))).active = false; };
  const handle = (goalId, callId) => originals.get(JSON.stringify([goalId, callId]));
  const setOriginGate = (gate) => { originGate = gate; };
  const setProbeGate = (gate) => { probeGate = gate; };
  const setTerminalGate = (gate) => { terminalGate = gate; };
  const prove = (callId, owner, extra = {}) => {
    const proof = Object.freeze({ opaque: `terminal-${callId}` });
    terminals.set(proof, { owner: owner.conversationId, callId,
      generation: owner.generation, state: 'completed', proofId: `proof-${callId}`, ...extra });
    return proof;
  };
  const close = () => { ledger.close(); rmSync(directory, { recursive: true, force: true }); };
  return { directory, options, ledger, actors, lineage, terminals, actor, origin, input,
    live, invoke, invokeOn, kill, handle, setOriginGate, setProbeGate, setTerminalGate, prove, close };
};

test('accepted owner, input, inventory and invocation persist before the sole effect', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const envelope = f.origin(who, 'root-lead');
    const args = f.input(who, envelope, 'call-one');
    const accepted = await f.ledger.accept(args);
    assert.equal(accepted.state, 'accepted');
    let effects = 0;
    const live = await f.invoke('call-one', 'goal-one', (payload, owner) => {
      effects++;
      const file = readdirSync(f.directory).find((name) => name.endsWith('.json'));
      const saved = JSON.parse(readFileSync(path.join(f.directory, file), 'utf8'));
      assert.deepEqual(saved.records['call-one'].payload, {
        input: args.input, inventory: args.inventory, invocation: args.invocation });
      assert.deepEqual(saved.records['call-one'].owner, owner);
      assert.equal(saved.records['call-one'].invocationEffect, 'uncertain');
      assert.deepEqual(payload.input, args.input);
      return f.live(owner);
    });
    assert.equal(live.state, 'live');
    assert.equal(live.handleRetained, true);
    // A dropped caller acknowledgement cannot cause a second native effect.
    assert.equal((await f.ledger.accept(args)).state, 'live');
    await assert.rejects(f.invoke('call-one', 'goal-one', () => effects++), hasCode('NO_REISSUE'));
    await assert.rejects(f.ledger.accept({ ...args, input: { prompt: 'changed' } }), hasCode('ORIGIN'));
    assert.equal(effects, 1);
    assert.equal(JSON.stringify(live).includes('private-token'), false);
  } finally { f.close(); }
});

test('terminal-ready cannot be added after an original is already terminal', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const args = f.input(who, f.origin(who, 'root-lead'), 'call-one');
    const accepted = await f.ledger.accept(args);
    await f.invoke('call-one', 'goal-one', (_, owner) => f.live(owner));
    f.ledger.sdkFinished('call-one', 'goal-one', 'completed');
    await f.ledger.terminal('call-one', 'goal-one', f.prove('call-one', accepted.owner));
    assert.throws(() => f.ledger.terminalPrepared('call-one', 'goal-one'), hasCode('TERMINAL_PROOF'));
    assert.equal((await f.ledger.status('call-one', 'goal-one')).terminalReady, false);
  } finally { f.close(); }
});

test('public JSON origins and mismatched actor/root/target envelopes have no authority', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const envelope = f.origin(who, 'root-lead');
    const args = f.input(who, envelope, 'call-one');
    await assert.rejects(f.ledger.accept({ ...args, originEnvelope: {
      ...f.lineage.get(args.originEnvelope.opaque), childConversationId: 'forged' } }), hasCode('ORIGIN'));
    await assert.rejects(f.ledger.accept({ ...args, request: { token: 'claimed-actor' } }), hasCode('ORIGIN'));
    const wrong = Object.freeze({ opaque: 'wrong-root' });
    f.lineage.set(wrong.opaque, { ...f.lineage.get(args.originEnvelope.opaque), rootConversationId: 'other-root',
      envelopeDigest: hash(wrong) });
    await assert.rejects(f.ledger.accept({ ...args, originEnvelope: wrong }), hasCode('ORIGIN'));
    const wrongRun = Object.freeze({ opaque: 'wrong-run' });
    f.lineage.set(wrongRun.opaque, { ...f.lineage.get(args.originEnvelope.opaque), fleetRunId: 'other-run',
      envelopeDigest: hash(wrongRun) });
    await assert.rejects(f.ledger.accept({ ...args, originEnvelope: wrongRun }), hasCode('ORIGIN'));
    assert.equal(readdirSync(f.directory).filter((name) => name.endsWith('.json')).length, 0);
  } finally { f.close(); }
});

test('saved invocation ID and exact input, inventory and invocation digests bind the effect', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const source = f.origin(who, 'root-lead');
    const args = f.input(who, source, 'call-one');
    for (const changed of [
      { callId: 'caller-chosen-id' },
      { input: { prompt: 'changed' } },
      { inventory: { generation: 'other-catalog', tools: [] } },
      { invocation: { model: 'other-model', operation: 'original-call' } },
    ]) await assert.rejects(f.ledger.accept({ ...args, ...changed }), hasCode('ORIGIN'));
    const entered = deferred();
    const release = deferred();
    f.setOriginGate(async () => { entered.resolve(); await release.promise; });
    const admitting = f.ledger.accept(args);
    await entered.promise;
    args.input.prompt = 'mutated during origin verification';
    args.inventory.tools.push('unadvertised');
    args.invocation.model = 'mutated';
    args.originEnvelope.opaque = 'caller-replaced-envelope';
    release.resolve();
    const accepted = await admitting;
    assert.equal(accepted.owner.invocationId, 'call-one');
    assert.equal(accepted.owner.logicalRunId, 'logical-worker-lead');
    assert.equal(accepted.owner.nodeId, 'node-root-lead');
    let effectPayload;
    await f.invoke('call-one', 'goal-one', (payload, owner) => {
      effectPayload = payload;
      return f.live(owner);
    });
    assert.deepEqual(effectPayload, { input: { prompt: 'bounded input' },
      inventory: { generation: 'catalog-one', tools: ['private-tool'] },
      invocation: { model: 'fixture', operation: 'original-call' } });
  } finally { f.close(); }
});

test('the executing actor is rechecked after awaited origin proof and before effect', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const args = f.input(who, f.origin(who, 'root-lead'), 'call-one');
    await f.ledger.accept(args);
    const entered = deferred();
    const release = deferred();
    f.setOriginGate(async () => { entered.resolve(); await release.promise; });
    let effects = 0;
    const starting = f.invoke('call-one', 'goal-one', () => { effects++; return {}; });
    await entered.promise;
    f.actors.delete(who.request.token);
    release.resolve();
    await assert.rejects(starting, hasCode('ACTOR_CHANGED'));
    assert.equal(effects, 0);
    assert.equal((await f.ledger.status('call-one', 'goal-one')).state, 'accepted');
  } finally { f.close(); }
});

test('actor retirement during the awaited source proof cannot accept a new original', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const args = f.input(who, f.origin(who, 'root-lead'), 'call-one');
    const entered = deferred();
    const release = deferred();
    f.setOriginGate(async () => { entered.resolve(); await release.promise; });
    const admitting = f.ledger.accept(args);
    await entered.promise;
    f.actors.delete(who.request.token);
    release.resolve();
    await assert.rejects(admitting, hasCode('ACTOR_CHANGED'));
    assert.equal(readdirSync(f.directory).filter((name) => name.endsWith('.json')).length, 0);
  } finally { f.close(); }
});

test('same invocation ID in two goals retains distinct original handles and losses', async () => {
  const f = fixture();
  try {
    const a = f.actor('a', 'goal-a');
    const b = f.actor('b', 'goal-b');
    const aArgs = f.input(a, f.origin(a, 'root-a'), 'same-invocation');
    const bArgs = f.input(b, f.origin(b, 'root-b'), 'same-invocation');
    await f.ledger.accept(aArgs);
    await f.ledger.accept(bArgs);
    await f.invoke('same-invocation', 'goal-a', (_, owner) => f.live(owner));
    await f.invoke('same-invocation', 'goal-b', (_, owner) => f.live(owner));
    assert.notEqual(f.handle('goal-a', 'same-invocation'), f.handle('goal-b', 'same-invocation'));
    assert.equal((await f.ledger.status('same-invocation', 'goal-a')).handleRetained, true);
    assert.equal((await f.ledger.status('same-invocation', 'goal-b')).handleRetained, true);
    f.ledger.lostOriginal('same-invocation', 'goal-a', f.handle('goal-a', 'same-invocation'));
    assert.equal((await f.ledger.status('same-invocation', 'goal-a')).loss.code, 'HANDLE_LOST');
    assert.equal((await f.ledger.status('same-invocation', 'goal-b')).state, 'live');
    await f.ledger.result('same-invocation', 'goal-b', (handle) => {
      assert.equal(handle, f.handle('goal-b', 'same-invocation'));
      return { resultId: 'result-b', value: 'done' };
    });
    assert.throws(() => f.ledger.lostOriginal('same-invocation', 'goal-b',
      f.handle('goal-a', 'same-invocation')), hasCode('LOST_HANDLE'));
  } finally { f.close(); }
});

test('five parents and twenty verified children can be live in one generation', async () => {
  const f = fixture();
  try {
    let effects = 0;
    for (let parent = 0; parent < 5; parent++) {
      const who = f.actor(`lead${parent}`);
      for (let child = 0; child < 5; child++) {
        const conversationId = child === 0 ? who.trusted.rootConversationId : `child-${parent}-${child}`;
        const envelope = f.origin(who, conversationId);
        const callId = `call-${parent}-${child}`;
        await f.ledger.accept(f.input(who, envelope, callId));
        await f.invoke(callId, 'goal-one', (_, owner) => {
          effects++;
          return f.live(owner);
        });
      }
    }
    assert.equal(effects, 25);
    assert.equal((await f.ledger.status('call-4-4', 'goal-one')).state, 'live');
  } finally { f.close(); }
});

test('dead process handle holds new IDs while admitted sibling keeps its original reconciliation path', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const dead = f.input(who, f.origin(who, 'child-dead'), 'call-dead');
    const sibling = f.input(who, f.origin(who, 'child-sibling'), 'call-sibling');
    await f.ledger.accept(dead);
    await f.invoke('call-dead', 'goal-one', (_, owner) => f.live(owner));
    await f.ledger.accept(sibling);
    await f.invoke('call-sibling', 'goal-one', (_, owner) => f.live(owner));
    f.kill('goal-one', 'call-dead'); // The object remains retained; its process/queue is gone.
    const later = f.input(who, f.origin(who, 'child-later'), 'call-later');
    await assert.rejects(f.ledger.accept(later), hasCode('UNCERTAIN_SCOPE'));
    const lost = await f.ledger.status('call-dead', 'goal-one');
    assert.equal(lost.state, 'uncertain');
    assert.deepEqual(lost.loss, { code: 'HANDLE_LOST', invocationId: 'call-dead' });
    assert.equal(lost.handleRetained, false);
    const siblingRecord = await f.ledger.status('call-sibling', 'goal-one');
    assert.equal(siblingRecord.state, 'live');
    await f.ledger.result('call-sibling', 'goal-one', () => ({ resultId: 'result-sibling', value: 'done' }));
    await f.ledger.terminal('call-sibling', 'goal-one', f.prove('call-sibling', siblingRecord.owner,
      { resultId: 'result-sibling' }));
    await assert.rejects(f.ledger.accept(later), hasCode('UNCERTAIN_SCOPE'));
    await f.ledger.terminal('call-dead', 'goal-one', f.prove('call-dead', lost.owner,
      { invocationResolved: true }));
    assert.equal((await f.ledger.accept(later)).state, 'accepted');
  } finally { f.close(); }
});

test('a JSON alive flag cannot qualify the original opaque handle', async () => {
  const f = fixture();
  const bogus = new NativeOriginalLedger({ ...f.options, directory: `${f.directory}-bogus`,
    probeOriginalHandle: () => ({ alive: true }) });
  try {
    const who = f.actor('lead');
    const args = f.input(who, f.origin(who, 'root-lead'), 'call-one');
    await bogus.accept(args);
    await assert.rejects(f.invokeOn(bogus, 'call-one', 'goal-one', (_, owner) => f.live(owner)), hasCode('LOST_HANDLE'));
    const lost = await bogus.status('call-one', 'goal-one');
    assert.equal(lost.state, 'uncertain');
    assert.equal(lost.loss.code, 'HANDLE_LOST');
    await assert.rejects(bogus.accept(f.input(who, f.origin(who, 'child-two'), 'call-two')),
      hasCode('UNCERTAIN_SCOPE'));
  } finally {
    bogus.close();
    rmSync(`${f.directory}-bogus`, { recursive: true, force: true });
    f.close();
  }
});

test('one uncertain child holds new IDs but admitted siblings retain original cursor, result and terminal paths', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const first = f.origin(who, 'child-one');
    const second = f.origin(who, 'child-two');
    const third = f.origin(who, 'child-three');
    for (const [callId, envelope] of [['call-one', first], ['call-two', second]]) {
      await f.ledger.accept(f.input(who, envelope, callId));
      await f.invoke(callId, 'goal-one', (_, owner) => f.live(owner));
    }
    await assert.rejects(f.ledger.cancel('call-one', 'goal-one', async (handle, cancelId) => {
      assert.equal(handle.id, 'call-one');
      assert.match(cancelId, /^cancel-/);
      throw new Error('cancel acknowledgement dropped');
    }));
    await assert.rejects(f.ledger.accept(f.input(who, third, 'call-three')), hasCode('UNCERTAIN_SCOPE'));
    const event = { eventId: 'event-two', cursor: 'cursor-two', payload: { delta: 'done' } };
    await f.ledger.event('call-two', 'goal-one', (handle) => {
      assert.equal(handle.id, 'call-two');
      return event;
    });
    await f.ledger.event('call-two', 'goal-one', () => event);
    await assert.rejects(f.ledger.event('call-two', 'goal-one', () =>
      ({ ...event, payload: { delta: 'changed' } })), hasCode('CHANGED_ORIGINAL'));
    await f.ledger.result('call-two', 'goal-one', () => ({ resultId: 'result-two', value: { answer: 42 } }));
    const two = await f.ledger.status('call-two', 'goal-one');
    await f.ledger.terminal('call-two', 'goal-one', f.prove('call-two', two.owner,
      { cursor: 'cursor-two', resultId: 'result-two' }));
    assert.equal((await f.ledger.status('call-two', 'goal-one')).terminal.state, 'completed');
    await assert.rejects(f.ledger.accept(f.input(who, third, 'call-three')), hasCode('UNCERTAIN_SCOPE'));
    const one = await f.ledger.status('call-one', 'goal-one');
    assert.match(one.cancel.id, /^cancel-/);
    await f.ledger.terminal('call-one', 'goal-one', f.prove('call-one', one.owner,
      { cancelId: one.cancel.id, cancelResolved: true }));
    assert.equal((await f.ledger.accept(f.input(who, third, 'call-three'))).state, 'accepted');
  } finally { f.close(); }
});

test('a sibling marked uncertain during beforeInvoke blocks the next issue write but keeps both exact-ID lanes', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const first = f.input(who, f.origin(who, 'first-root'), 'call-first');
    const second = f.input(who, f.origin(who, 'second-root'), 'call-second');
    await f.ledger.accept(first);
    await f.invoke('call-first', 'goal-one', (_, owner) => f.live(owner));
    await f.ledger.accept(second);
    let effects = 0;
    await assert.rejects(f.ledger.invoke('call-second', 'goal-one', {
      request: second.request, claim: second.claim,
      beforeInvoke: async () => {
        f.ledger.lostOriginal('call-first', 'goal-one', f.handle('goal-one', 'call-first'));
      },
      execute: () => { effects++; throw new Error('No second effect is permitted.'); },
    }), hasCode('UNCERTAIN_SCOPE'));
    assert.equal(effects, 0);
    assert.equal((await f.ledger.status('call-first', 'goal-one')).state, 'uncertain');
    const admitted = await f.ledger.status('call-second', 'goal-one');
    assert.equal(admitted.state, 'accepted');
    assert.equal(admitted.invocationEffect, 'not-started');
    const cancelled = await f.ledger.cancelPending('call-second', 'goal-one', async () => undefined);
    assert.equal(cancelled.cancel.state, 'resolved');
  } finally { f.close(); }
});

test('the final admission sees Stop after a held sibling probe and issues no effect', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const first = f.input(who, f.origin(who, 'first-root'), 'call-first');
    const second = f.input(who, f.origin(who, 'second-root'), 'call-second');
    await f.ledger.accept(first);
    await f.invoke('call-first', 'goal-one', (_, owner) => f.live(owner));
    await f.ledger.accept(second);
    const probing = deferred();
    const release = deferred();
    f.setProbeGate(async () => { probing.resolve(); await release.promise; });
    let stopped = false;
    let admissionChecks = 0;
    let effects = 0;
    const invocation = f.ledger.invoke('call-second', 'goal-one', {
      request: second.request, claim: second.claim,
      beforeInvoke: () => {
        admissionChecks++;
        if (stopped) throw Object.assign(new Error('Goal stopped.'), { code: 'STOPPED' });
      },
      execute: () => { effects++; throw new Error('No second effect is permitted.'); },
    });
    try {
      await probing.promise;
      stopped = true;
    } finally { release.resolve(); }
    await assert.rejects(invocation, hasCode('STOPPED'));
    assert.equal(admissionChecks, 1);
    assert.equal(effects, 0);
    const admitted = await f.ledger.status('call-second', 'goal-one');
    assert.equal(admitted.state, 'accepted');
    assert.equal(admitted.invocationEffect, 'not-started');
  } finally { f.close(); }
});

test('two cancellations waiting on one original probe journal and execute only one cancellation', { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    await f.ledger.accept(f.input(who, f.origin(who, 'root-lead'), 'call-one'));
    await f.invoke('call-one', 'goal-one', (_, owner) => f.live(owner));
    const bothEntered = deferred();
    const release = deferred();
    let probes = 0;
    f.setProbeGate(async () => {
      probes++;
      if (probes === 2) bothEntered.resolve();
      await release.promise;
    });
    let effects = 0;
    const effect = async (handle, cancelId) => {
      assert.equal(handle, f.handle('goal-one', 'call-one'));
      assert.match(cancelId, /^cancel-/);
      effects++;
    };
    const first = f.ledger.cancel('call-one', 'goal-one', effect);
    const second = f.ledger.cancel('call-one', 'goal-one', effect);
    await bothEntered.promise;
    release.resolve();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.cancel.id, two.cancel.id);
    assert.equal((await f.ledger.status('call-one', 'goal-one')).cancel.state, 'resolved');
    assert.equal(effects, 1);
  } finally { f.close(); }
});

test('terminal proof during a pending cancel probe prevents a later cancel effect', { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const accepted = await f.ledger.accept(f.input(who, f.origin(who, 'root-lead'), 'call-one'));
    await f.invoke('call-one', 'goal-one', (_, owner) => f.live(owner));
    const entered = deferred();
    const release = deferred();
    f.setProbeGate(async () => { entered.resolve(); await release.promise; });
    let effects = 0;
    const cancelling = f.ledger.cancel('call-one', 'goal-one', async () => { effects++; });
    await entered.promise;
    f.setProbeGate(async () => undefined);
    await f.ledger.terminal('call-one', 'goal-one', f.prove('call-one', accepted.owner));
    release.resolve();
    await assert.rejects(cancelling, hasCode('LOST_HANDLE'));
    assert.equal((await f.ledger.status('call-one', 'goal-one')).terminal.state, 'completed');
    assert.equal(effects, 0);
  } finally { f.close(); }
});

test('concurrent terminal verifiers cannot replace the first confirmed receipt', { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const accepted = await f.ledger.accept(f.input(who, f.origin(who, 'root-lead'), 'call-one'));
    await f.invoke('call-one', 'goal-one', (_, owner) => f.live(owner));
    const firstProof = f.prove('call-one', accepted.owner);
    const secondProof = f.prove('call-one', accepted.owner,
      { state: 'failed', proofId: 'proof-conflict' });
    const bothEntered = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    let verifiers = 0;
    f.setTerminalGate(async (proof) => {
      verifiers++;
      if (verifiers === 2) bothEntered.resolve();
      await (proof === firstProof ? releaseFirst.promise : releaseSecond.promise);
    });
    const first = f.ledger.terminal('call-one', 'goal-one', firstProof);
    const second = f.ledger.terminal('call-one', 'goal-one', secondProof);
    await bothEntered.promise;
    releaseFirst.resolve();
    assert.equal((await first).terminal.proofId, 'proof-call-one');
    releaseSecond.resolve();
    await assert.rejects(second, hasCode('TERMINAL_CONFLICT'));
    assert.deepEqual((await f.ledger.status('call-one', 'goal-one')).terminal,
      { state: 'completed', proofId: 'proof-call-one' });
  } finally { f.close(); }
});

test('lost invocation acknowledgement and host restart never reissue an effect', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const envelope = f.origin(who, 'root-lead');
    const args = f.input(who, envelope, 'call-one');
    await f.ledger.accept(args);
    let effects = 0;
    await assert.rejects(f.invoke('call-one', 'goal-one', () => {
      effects++;
      throw new Error('SDK acknowledgement dropped');
    }));
    assert.equal((await f.ledger.status('call-one', 'goal-one')).state, 'uncertain');
    await assert.rejects(f.invoke('call-one', 'goal-one', () => effects++), hasCode('NO_REISSUE'));
    f.ledger.close();
    const reopened = new NativeOriginalLedger(f.options);
    try {
      assert.equal((await reopened.status('call-one', 'goal-one')).handleRetained, false);
      assert.equal((await reopened.accept(args)).state, 'uncertain');
      await assert.rejects(reopened.accept(f.input(who, envelope, 'call-two')), hasCode('UNCERTAIN_SCOPE'));
      await assert.rejects(f.invokeOn(reopened, 'call-one', 'goal-one', () => effects++), hasCode('NO_REISSUE'));
      await assert.rejects(reopened.terminal('call-one', 'goal-one', { claimed: 'completed' }), hasCode('TERMINAL_PROOF'));
      const one = await reopened.status('call-one', 'goal-one');
      await reopened.terminal('call-one', 'goal-one', f.prove('call-one', one.owner,
        { invocationResolved: true }));
      assert.equal((await reopened.accept(f.input(who, envelope, 'call-two'))).state, 'accepted');
      assert.equal(effects, 1);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('an uncertain child original holds new IDs while earlier siblings finish', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const sibling = f.origin(who, 'child-sibling');
    const uncertain = f.origin(who, 'child-uncertain');
    await f.ledger.accept(f.input(who, sibling, 'call-sibling'));
    await f.invoke('call-sibling', 'goal-one', (_, owner) => f.live(owner));
    await f.ledger.accept(f.input(who, uncertain, 'call-uncertain'));
    await assert.rejects(f.invoke('call-uncertain', 'goal-one', () => {
      throw new Error('original SDK outcome unknown');
    }));
    await assert.rejects(f.ledger.accept(f.input(who, sibling, 'call-new')), hasCode('UNCERTAIN_SCOPE'));
    const siblingRecord = await f.ledger.status('call-sibling', 'goal-one');
    await f.ledger.result('call-sibling', 'goal-one', () => ({ resultId: 'result-sibling', value: 'done' }));
    await f.ledger.terminal('call-sibling', 'goal-one', f.prove('call-sibling', siblingRecord.owner,
      { resultId: 'result-sibling' }));
    assert.equal((await f.ledger.status('call-sibling', 'goal-one')).terminal.state, 'completed');
    await assert.rejects(f.ledger.accept(f.input(who, sibling, 'call-new')), hasCode('UNCERTAIN_SCOPE'));
    const unknownRecord = await f.ledger.status('call-uncertain', 'goal-one');
    await f.ledger.terminal('call-uncertain', 'goal-one', f.prove('call-uncertain', unknownRecord.owner,
      { invocationResolved: true }));
    assert.equal((await f.ledger.accept(f.input(who, sibling, 'call-new'))).state, 'accepted');
  } finally { f.close(); }
});

test('a saved live phase loses its handle on restart and holds new IDs until original proof', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const envelope = f.origin(who, 'root-lead');
    await f.ledger.accept(f.input(who, envelope, 'call-one'));
    await f.invoke('call-one', 'goal-one', (_, owner) => f.live(owner));
    f.ledger.close();
    const reopened = new NativeOriginalLedger(f.options);
    try {
      assert.equal((await reopened.status('call-one', 'goal-one')).handleRetained, false);
      await assert.rejects(reopened.accept(f.input(who, envelope, 'call-two')), hasCode('UNCERTAIN_SCOPE'));
      await assert.rejects(reopened.cancel('call-one', 'goal-one', async () => {}), hasCode('LOST_HANDLE'));
      const one = await reopened.status('call-one', 'goal-one');
      await reopened.terminal('call-one', 'goal-one', f.prove('call-one', one.owner,
        { invocationResolved: true }));
      assert.equal((await reopened.accept(f.input(who, envelope, 'call-two'))).state, 'accepted');
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('closing the host during an original effect leaves its journal uncertain without a late unowned write', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    const args = f.input(who, f.origin(who, 'root-lead'), 'call-one');
    await f.ledger.accept(args);
    const entered = deferred();
    const release = deferred();
    const invoking = f.invoke('call-one', 'goal-one', async (_, owner) => {
      entered.resolve();
      await release.promise;
      return f.live(owner);
    });
    await entered.promise;
    f.ledger.close();
    release.resolve();
    await assert.rejects(invoking, hasCode('JOURNAL_UNCERTAIN'));
    const reopened = new NativeOriginalLedger(f.options);
    try {
      const original = await reopened.status('call-one', 'goal-one');
      assert.equal(original.state, 'uncertain');
      assert.equal(original.handleRetained, false);
      await assert.rejects(reopened.accept(f.input(who, f.origin(who, 'child-two'), 'call-two')),
        hasCode('UNCERTAIN_SCOPE'));
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('bounded private records, events and results reject oversize before mutation', async () => {
  const f = fixture();
  try {
    const limited = new NativeOriginalLedger({ ...f.options, directory: `${f.directory}-limited`,
      limits: { records: 1, input: 16, event: 16, events: 1, result: 16 } });
    try {
      const who = f.actor('lead');
      const envelope = f.origin(who, 'root-lead');
      await assert.rejects(limited.accept(f.input(who, envelope, 'call-big', { text: 'x'.repeat(100) })), hasCode('BOUNDS'));
      await limited.accept(f.input(who, envelope, 'call-one', { x: 1 }));
      await f.invokeOn(limited, 'call-one', 'goal-one', (_, owner) => f.live(owner));
      await assert.rejects(limited.event('call-one', 'goal-one', () => ({ eventId: 'event-one', cursor: 'cursor-one', payload: 'x'.repeat(17) })), hasCode('BOUNDS'));
      await limited.event('call-one', 'goal-one', () => ({ eventId: 'event-one', cursor: 'cursor-one', payload: 1 }));
      await assert.rejects(limited.event('call-one', 'goal-one', () => ({ eventId: 'event-two', cursor: 'cursor-two', payload: 2 })), hasCode('CAPACITY'));
      await assert.rejects(limited.result('call-one', 'goal-one', () => ({ resultId: 'result-one', value: 'x'.repeat(17) })), hasCode('BOUNDS'));
      await assert.rejects(limited.accept(f.input(who, envelope, 'call-two', { x: 2 })), hasCode('CAPACITY'));
    } finally {
      limited.close();
      rmSync(`${f.directory}-limited`, { recursive: true, force: true });
    }
  } finally { f.close(); }
});

test('private payload journal refuses a directory inside a Git checkout', () => {
  const f = fixture();
  const checkout = path.join(f.directory, 'checkout');
  mkdirSync(path.join(checkout, '.git'), { recursive: true });
  try {
    assert.throws(() => new NativeOriginalLedger({ ...f.options,
      directory: path.join(checkout, 'private-data') }), hasCode('PUBLIC_PATH'));
  } finally { f.close(); }
});

test('one goal has one writer and a journal capacity refusal rolls back the in-memory admission', async () => {
  const f = fixture();
  const limited = new NativeOriginalLedger({ ...f.options, directory: `${f.directory}-bounded`,
    limits: { journal: 100 } });
  try {
    const who = f.actor('lead');
    const envelope = f.origin(who, 'root-lead');
    await assert.rejects(limited.accept(f.input(who, envelope, 'call-one')), hasCode('CAPACITY'));
    await assert.rejects(limited.status('call-one', 'goal-one'), hasCode('NOT_FOUND'));
    const competing = new NativeOriginalLedger({ ...f.options, directory: `${f.directory}-bounded` });
    try { await assert.rejects(competing.status('call-one', 'goal-one'), /lease already exists/); }
    finally { competing.close(); }
  } finally {
    limited.close();
    rmSync(`${f.directory}-bounded`, { recursive: true, force: true });
    f.close();
  }
});

test('a malformed saved phase refuses reopening instead of clearing an uncertainty hold', async () => {
  const f = fixture();
  try {
    const who = f.actor('lead');
    await f.ledger.accept(f.input(who, f.origin(who, 'root-lead'), 'call-one'));
    f.ledger.close();
    const file = path.join(f.directory, readdirSync(f.directory).find((name) => name.endsWith('.json')));
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.records['call-one'].state = 'live';
    writeFileSync(file, JSON.stringify(saved));
    const reopened = new NativeOriginalLedger(f.options);
    try { await assert.rejects(reopened.status('call-one', 'goal-one'), hasCode('CORRUPT')); }
    finally { reopened.close(); }
  } finally { f.close(); }
});
