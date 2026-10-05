// Private host journal for original native calls. This module has no transport
// route and never treats a saved phase as proof that an SDK handle still exists.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claimController } from './owner.mjs';

const MAX = Object.freeze({ records: 128, claim: 4_000, envelope: 16_000,
  input: 16_000, inventory: 16_000,
  invocation: 16_000, event: 4_000, events: 64, result: 32_000,
  journal: 64 * 1024 * 1024 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fail = (code) => { throw Object.assign(new Error(`Native ledger ${code}.`), { code }); };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (value, limit) => {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > limit) fail('BOUNDS');
  return JSON.parse(serialized);
};
const id = (value) => {
  if (typeof value !== 'string' || !ID.test(value)) fail('IDENTITY');
  return value;
};
const copy = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const handleKey = (goalId, callId) => JSON.stringify([goalId, callId]);
const validRecord = (key, record, goalId, limits) => {
  if (!ID.test(key) || !record || typeof record !== 'object' || record.id !== key
    || record.owner?.goalId !== goalId || record.owner?.invocationId !== key || !record.payload
    || ['workerId', 'fleetRunId', 'rootConversationId', 'conversationId', 'logicalRunId',
      'nodeId', 'generation', 'workspace', 'targetDigest'].some((field) =>
      typeof record.owner[field] !== 'string' || !record.owner[field])
    || ['input', 'inventory', 'invocation'].some((field) =>
      digest(JSON.stringify(record.payload[field])) !== record.owner[`${field}Digest`])
    || typeof record.owner.envelopeDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.owner.envelopeDigest)
    || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint)
    || !Array.isArray(record.events) || record.events.length > limits.events
    || !['accepted', 'uncertain', 'live', 'terminal'].includes(record.state)
    || !['not-started', 'uncertain', 'resolved'].includes(record.invocationEffect)
    || record.state === 'accepted' && record.invocationEffect !== 'not-started'
    || record.state === 'uncertain' && record.invocationEffect !== 'uncertain'
    || ['live', 'terminal'].includes(record.state) && record.invocationEffect !== 'resolved'
    || record.state === 'terminal' !== Boolean(record.terminal)
    || record.cancel && !['uncertain', 'resolved'].includes(record.cancel.state)
    || digest(JSON.stringify({ owner: record.owner, payload: record.payload })) !== record.fingerprint) return false;
  return true;
};

export class NativeOriginalLedger {
  // resolveActor must use the Controller's bearer gate. verifyOrigin must read
  // the Worker runtime's saved lineage, never a claim supplied by the caller.
  constructor({ directory, resolveActor, verifyOrigin, probeOriginalHandle, verifyTerminal, limits = {} }) {
    if (typeof directory !== 'string' || !directory.trim()
      || typeof resolveActor !== 'function' || typeof verifyOrigin !== 'function'
      || typeof probeOriginalHandle !== 'function'
      || typeof verifyTerminal !== 'function') fail('CONFIG');
    if (Object.keys(limits).some((key) => !Object.hasOwn(MAX, key))
      || Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > MAX[key])) fail('CONFIG');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory);
    for (let current = this.directory; ; current = dirname(current)) {
      if (existsSync(join(current, '.git'))) fail('PUBLIC_PATH');
      if (dirname(current) === current) break;
    }
    this.resolveActor = resolveActor;
    this.verifyOrigin = verifyOrigin;
    this.probeOriginalHandle = probeOriginalHandle;
    this.verifyTerminal = verifyTerminal;
    this.limits = Object.freeze({ ...MAX, ...limits });
    this.scopes = new Map();
    this.handles = new Map();
    this.pending = new Map();
    this.hostGeneration = Object.freeze({ nonce: randomUUID() });
    this.closed = false;
  }

  scope(goalId) {
    if (this.closed) fail('CLOSED');
    id(goalId);
    if (this.scopes.has(goalId)) {
      const scope = this.scopes.get(goalId);
      if (scope.poisoned) fail('JOURNAL_UNCERTAIN');
      return scope;
    }
    const file = join(this.directory, `native-${digest(goalId)}.json`);
    const release = claimController(file); // A crashed owner leaves an explicit hold.
    try {
      let state;
      try {
        if (statSync(file).size > this.limits.journal) fail('CAPACITY');
        state = JSON.parse(readFileSync(file, 'utf8'));
      }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { version: 1, goalId, records: {} };
      }
      if (state.version !== 1 || state.goalId !== goalId || !state.records
        || typeof state.records !== 'object' || Array.isArray(state.records)
        || Object.keys(state.records).length > this.limits.records
        || Object.entries(state.records).some(([key, record]) =>
          !validRecord(key, record, goalId, this.limits))) fail('CORRUPT');
      const saved = JSON.stringify(state);
      if (Buffer.byteLength(saved) > this.limits.journal) fail('CAPACITY');
      const scope = { file, release, state, saved, poisoned: false };
      this.scopes.set(goalId, scope);
      return scope;
    } catch (error) { release(); throw error; }
  }

  save(scope) {
    if (this.closed || scope.poisoned) fail('JOURNAL_UNCERTAIN');
    const serialized = JSON.stringify(scope.state);
    if (Buffer.byteLength(serialized) > this.limits.journal) {
      scope.state = JSON.parse(scope.saved);
      fail('CAPACITY');
    }
    const temporary = `${scope.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, serialized, { mode: 0o600 });
      renameSync(temporary, scope.file);
      scope.saved = serialized;
    } catch (error) {
      scope.poisoned = true; // A failed rename can have an ambiguous outcome.
      throw error;
    }
  }

  uncertain(record) {
    return record.state === 'accepted' || record.state === 'uncertain'
      || record.state === 'live' && (!this.handles.has(handleKey(record.owner.goalId, record.id))
        || record.cancel?.state === 'uncertain');
  }

  markLost(scope, record, code = 'HANDLE_LOST') {
    if (record.state !== 'live' && record.state !== 'uncertain') return;
    record.state = 'uncertain';
    record.invocationEffect = 'uncertain';
    record.loss = { code, invocationId: record.owner.invocationId };
    this.handles.delete(handleKey(record.owner.goalId, record.id));
    this.save(scope);
  }

  async refreshOne(scope, record) {
    if (record.state !== 'live') return;
    const key = handleKey(record.owner.goalId, record.id);
    const original = this.handles.get(key);
    let verified = false;
    if (original && original.generation === record.owner.generation
      && original.hostGeneration === this.hostGeneration) {
      try {
        // The host callback must inspect its actual SDK/process/queue lifecycle
        // and return the same opaque handle. A JSON alive flag is not evidence.
        verified = await this.probeOriginalHandle(original.handle,
          copy(record.owner), this.hostGeneration) === original.handle;
      } catch { verified = false; }
    }
    if (!verified && record.state === 'live') this.markLost(scope, record);
  }

  async refreshGoal(scope) {
    for (const record of Object.values(scope.state.records)) await this.refreshOne(scope, record);
  }

  async verifiedOrigin(request, claim, envelope, payload, callId) {
    const fields = ['workerId', 'goalId', 'fleetRunId', 'rootConversationId', 'workspace', 'targetDigest'];
    const actor = await this.resolveActor(request, copy(claim));
    if (fields.some((field) => typeof actor?.[field] !== 'string' || !actor[field])) fail('ORIGIN');
    const binding = Object.fromEntries(fields.map((field) => [field, actor[field]]));
    const expected = { invocationId: callId, envelopeDigest: digest(JSON.stringify(envelope)),
      inputDigest: digest(JSON.stringify(payload.input)),
      inventoryDigest: digest(JSON.stringify(payload.inventory)),
      invocationDigest: digest(JSON.stringify(payload.invocation)) };
    const origin = await this.verifyOrigin(copy(envelope), copy(binding),
      { ...expected, payload: copy(payload) });
    if (fields.some((field) => origin?.[field] !== binding[field])
      || Object.entries(expected).some(([field, value]) => origin?.[field] !== value)) fail('ORIGIN');
    for (const field of ['conversationId', 'logicalRunId', 'nodeId', 'generation']) id(origin[field]);
    const after = await this.resolveActor(request, copy(claim));
    if (fields.some((field) => after?.[field] !== binding[field])) fail('ACTOR_CHANGED');
    return { binding, origin, expected };
  }

  // New admission is serialized by this owner's goal-scoped journal. Identity
  // fields come only from the two trusted callbacks and must agree exactly.
  async accept({ request, claim, originEnvelope, callId, input, inventory, invocation }) {
    id(callId);
    const claimSnapshot = json(claim, this.limits.claim);
    const envelope = json(originEnvelope, this.limits.envelope);
    const payload = { input: json(input, this.limits.input),
      inventory: json(inventory, this.limits.inventory),
      invocation: json(invocation, this.limits.invocation) };
    const preliminary = await this.resolveActor(request, copy(claimSnapshot));
    if (typeof preliminary?.goalId !== 'string') fail('ORIGIN');
    const scope = this.scope(preliminary.goalId);
    await this.refreshGoal(scope);
    const { binding, origin, expected } = await this.verifiedOrigin(
      request, claimSnapshot, envelope, payload, callId);
    if (binding.goalId !== preliminary.goalId) fail('ACTOR_CHANGED');
    await this.refreshGoal(scope);
    const lastActor = await this.resolveActor(request, copy(claimSnapshot));
    if (Object.keys(binding).some((field) => lastActor?.[field] !== binding[field])) fail('ACTOR_CHANGED');
    const owner = { ...binding, conversationId: origin.conversationId,
      logicalRunId: origin.logicalRunId, nodeId: origin.nodeId,
      generation: origin.generation, ...expected };
    const fingerprint = digest(JSON.stringify({ owner, payload }));
    const existing = scope.state.records[callId];
    if (existing) {
      if (existing.fingerprint !== fingerprint || !same(existing.owner, owner)
        || !same(existing.payload, payload)) fail('CHANGED_ORIGINAL');
      return this.view(existing);
    }
    if (Object.keys(scope.state.records).length >= this.limits.records) fail('CAPACITY');
    // A genuine uncertain original holds the whole goal, which includes this
    // root and Worker. Already admitted IDs remain queryable and reconcilable.
    if (Object.values(scope.state.records).some((record) => this.uncertain(record))) fail('UNCERTAIN_SCOPE');
    const record = { id: callId, owner, payload, fingerprint, state: 'accepted',
      invocationEffect: 'not-started', cancel: null, events: [], result: null, terminal: null };
    scope.state.records[callId] = record;
    this.save(scope); // Owner, input, inventory and original invocation predate effects.
    this.pending.set(handleKey(owner.goalId, callId), { claim: claimSnapshot, envelope, payload });
    return this.view(record);
  }

  view(record) {
    return Object.freeze({ id: record.id, owner: Object.freeze(copy(record.owner)),
      state: record.state, invocationEffect: record.invocationEffect,
      handleRetained: this.handles.has(handleKey(record.owner.goalId, record.id)),
      loss: record.loss && Object.freeze(copy(record.loss)),
      cancel: record.cancel && Object.freeze(copy(record.cancel)),
      events: Object.freeze(copy(record.events)), result: record.result && Object.freeze(copy(record.result)),
      terminal: record.terminal && Object.freeze(copy(record.terminal)) });
  }

  async status(callId, goalId) {
    const scope = this.scope(goalId);
    await this.refreshGoal(scope);
    const record = scope.state.records[id(callId)] ?? fail('NOT_FOUND');
    return this.view(record);
  }

  // Host lifecycle callbacks use the exact retained object, never a JSON ID or
  // a saved "live" phase, to mark one original uncertain on process/queue loss.
  lostOriginal(callId, goalId, handle) {
    const scope = this.scope(goalId);
    const record = scope.state.records[id(callId)] ?? fail('NOT_FOUND');
    if (this.handles.get(handleKey(goalId, callId))?.handle !== handle
      || record.state !== 'live') fail('LOST_HANDLE');
    this.markLost(scope, record);
    return this.view(record);
  }

  // The original effect is called at most once. Losing its return or throwing
  // leaves the saved invocation uncertain; retrying the ID never calls it again.
  async invoke(callId, goalId, { request, claim, execute }) {
    const scope = this.scope(goalId);
    const record = scope.state.records[id(callId)] ?? fail('NOT_FOUND');
    if (record.state !== 'accepted' || record.invocationEffect !== 'not-started') fail('NO_REISSUE');
    if (typeof execute !== 'function') fail('CONFIG');
    const key = handleKey(goalId, callId);
    const pending = this.pending.get(key);
    if (!pending || !same(json(claim, this.limits.claim), pending.claim)) fail('NO_REISSUE');
    const { binding, origin, expected } = await this.verifiedOrigin(
      request, pending.claim, pending.envelope, pending.payload, callId);
    if (!same(record.owner, { ...binding, conversationId: origin.conversationId,
      logicalRunId: origin.logicalRunId, nodeId: origin.nodeId,
      generation: origin.generation, ...expected })) fail('ORIGIN');
    if (record.state !== 'accepted') fail('NO_REISSUE');
    record.state = 'uncertain';
    record.invocationEffect = 'uncertain';
    this.save(scope);
    this.pending.delete(key);
    let original;
    try { original = await execute(copy(record.payload), copy(record.owner)); }
    catch (error) { this.markLost(scope, record, 'EFFECT_UNKNOWN'); throw error; }
    if (record.state === 'terminal') return this.view(record);
    if (!original || typeof original.handle !== 'object' || !original.handle
      || original.generation !== record.owner.generation) {
      this.markLost(scope, record);
      fail('LOST_HANDLE');
    }
    let verified = false;
    try {
      verified = await this.probeOriginalHandle(original.handle,
        copy(record.owner), this.hostGeneration) === original.handle;
    } catch { verified = false; }
    if (!verified) { this.markLost(scope, record); fail('LOST_HANDLE'); }
    if (record.state === 'terminal') return this.view(record);
    record.state = 'live';
    record.invocationEffect = 'resolved';
    this.save(scope);
    this.handles.set(key, { handle: original.handle, generation: original.generation,
      hostGeneration: this.hostGeneration });
    return this.view(record);
  }

  async live(scope, record) {
    await this.refreshOne(scope, record);
    const original = this.handles.get(handleKey(record.owner.goalId, record.id));
    if (!original || original.generation !== record.owner.generation
      || record.state !== 'live') fail('LOST_HANDLE');
    return original.handle;
  }

  // Cursor and event IDs belong to the original stream, not to a new call.
  async event(callId, goalId, observe) {
    const scope = this.scope(goalId);
    const record = scope.state.records[id(callId)] ?? fail('NOT_FOUND');
    const handle = await this.live(scope, record);
    if (typeof observe !== 'function') fail('CONFIG');
    const { eventId, cursor, payload } = await observe(handle, copy(record.owner));
    await this.live(scope, record);
    id(eventId); id(cursor);
    const value = json(payload, this.limits.event);
    const existing = record.events.find((event) => event.id === eventId);
    if (existing) {
      if (existing.cursor !== cursor || !same(existing.payload, value)) fail('CHANGED_ORIGINAL');
      return this.view(record);
    }
    if (record.events.some((event) => event.cursor === cursor)) fail('CHANGED_ORIGINAL');
    if (record.events.length >= this.limits.events) fail('CAPACITY');
    record.events.push({ id: eventId, cursor, payload: value });
    this.save(scope);
    return this.view(record);
  }

  async result(callId, goalId, observe) {
    const scope = this.scope(goalId);
    const record = scope.state.records[id(callId)] ?? fail('NOT_FOUND');
    const handle = await this.live(scope, record);
    if (typeof observe !== 'function') fail('CONFIG');
    const { resultId, value } = await observe(handle, copy(record.owner));
    await this.live(scope, record);
    id(resultId);
    const result = { id: resultId, value: json(value, this.limits.result) };
    if (record.result) {
      if (!same(record.result, result)) fail('CHANGED_ORIGINAL');
      return this.view(record);
    }
    record.result = result;
    this.save(scope);
    return this.view(record);
  }

  // Cancellation is itself an original effect. Record its identity first and
  // never resend after an unknown callback or a lost handle.
  async cancel(callId, goalId, effect) {
    const scope = this.scope(goalId);
    const record = scope.state.records[id(callId)] ?? fail('NOT_FOUND');
    if (record.cancel) return this.view(record);
    const handle = await this.live(scope, record);
    // Another cancellation or terminal proof may have completed during the
    // asynchronous lifecycle probe. This check and the journal write are one
    // synchronous owner-scoped mutation before any cancellation effect.
    if (record.cancel) return this.view(record);
    if (record.state === 'terminal') return this.view(record);
    if (record.state !== 'live'
      || this.handles.get(handleKey(goalId, callId))?.handle !== handle) fail('LOST_HANDLE');
    if (typeof effect !== 'function') fail('CONFIG');
    const cancelId = `cancel-${randomUUID()}`;
    record.cancel = { id: cancelId, state: 'uncertain' };
    this.save(scope);
    await effect(handle, cancelId);
    if (record.state === 'terminal') return this.view(record);
    record.cancel.state = 'resolved';
    this.save(scope);
    return this.view(record);
  }

  // The verifier must check an authoritative terminal receipt for this exact
  // original, including after restart. A persisted phase or caller string is
  // insufficient. Unknown cancellation must be explicitly resolved in proof.
  async terminal(callId, goalId, proof) {
    const scope = this.scope(goalId);
    await this.refreshGoal(scope);
    const record = scope.state.records[id(callId)] ?? fail('NOT_FOUND');
    if (record.terminal) return this.view(record);
    const terminal = await this.verifyTerminal(proof, copy(record.owner),
      this.handles.get(handleKey(goalId, callId))?.handle ?? null, this.view(record));
    if (record.terminal) {
      if (terminal?.callId === callId && terminal.generation === record.owner.generation
        && terminal.state === record.terminal.state
        && terminal.proofId === record.terminal.proofId) return this.view(record);
      fail('TERMINAL_CONFLICT');
    }
    if (!terminal || terminal.callId !== callId
      || terminal.generation !== record.owner.generation
      || !['completed', 'cancelled', 'failed'].includes(terminal.state)
      || record.invocationEffect === 'uncertain' && terminal.invocationResolved !== true
      || record.cancel?.state === 'uncertain' && terminal.cancelResolved !== true
      || record.cancel && terminal.cancelId !== record.cancel.id
      || record.result && terminal.resultId !== record.result.id
      || record.events.length && terminal.cursor !== record.events.at(-1).cursor) fail('TERMINAL_PROOF');
    record.invocationEffect = 'resolved';
    if (record.cancel) record.cancel.state = 'resolved';
    record.state = 'terminal';
    record.terminal = { state: terminal.state, proofId: id(terminal.proofId) };
    this.handles.delete(handleKey(goalId, callId));
    this.pending.delete(handleKey(goalId, callId));
    this.save(scope);
    return this.view(record);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.handles.clear();
    this.pending.clear();
    for (const scope of this.scopes.values()) scope.release();
    this.scopes.clear();
  }
}
