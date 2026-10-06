// One relay for one Seagulled goal. Its Fly app, Machine and bearer are never shared.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRelayAgent } from '../../upstream/swarm-teams/fleet/relay.mjs';
import { assertAppNetwork, assertFreshAppName, assertProductNetwork, readFlyOrgApps } from './fly-network.mjs';

const RELAY_SOURCE = fileURLToPath(new URL('../../upstream/swarm-teams/fleet/relay.mjs', import.meta.url));
// Ten waiting team leads must leave room for all ninety child conversations.
export const PRODUCT_RELAY_LIMITS = Object.freeze({ maxConcurrentServes: 128 });
const API = 'https://api.machines.dev/v1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownerMarker = (owner) => `SEAGULLED_RELAY_OWNER_${owner.toUpperCase()}`;
const preCreationRefusals = new WeakMap();
export const isRelayPreCreationFailure = (error, journalPath) =>
  typeof journalPath === 'string' && preCreationRefusals.get(error) === path.resolve(journalPath);
export const relayFailureCleanupConfirmed = (error, journal, journalExists, journalPath) =>
  (isRelayPreCreationFailure(error, journalPath) && !journalExists)
  || journal?.state === 'retired' || journal?.state === 'not-applied';
const flyArray = (output, label) => {
  let value;
  try { value = JSON.parse(output); } catch { throw new Error(`Relay ${label} inventory is unconfirmed.`); }
  if (!Array.isArray(value)) throw new Error(`Relay ${label} inventory is unconfirmed.`);
  return value;
};

export async function createOwnedRelay({ journalPath, flujoCloudPath, org, network, accountRef,
  region = 'iad', fetchImpl = fetch,
  spawnImpl = spawn, flyRunner, flyEnv, flyctlPath, portAllocator,
  verifyFreshApp, onPlannedApp, verifyNetwork, agentFactory = startRelayAgent } = {}) {
  if (!journalPath || existsSync(journalPath)) throw new Error('Relay intent already exists; reconcile the original resource before creating another.');
  if (!/^[a-z0-9-]{1,64}$/.test(org ?? '') || !/^[a-z]{3}$/.test(region)) throw new Error('A valid Fly organization and region are required.');
  assertProductNetwork(network);
  if (onPlannedApp && (typeof accountRef !== 'string'
    || !/^fly-account-sha256:[a-f0-9]{64}$/.test(accountRef)
    || typeof verifyFreshApp !== 'function')) {
    throw new Error('A pinned private Fly account reference is required for the product relay.');
  }
  const app = `seagulled-relay-${randomBytes(6).toString('hex')}`;
  try { await verifyFreshApp?.({ app, kind: 'relay', org, network, accountRef }); }
  catch (error) {
    const original = error instanceof Error ? error : new Error('Fresh relay app verification failed.');
    const refusal = new Error(original.message, { cause: error });
    refusal.name = original.name;
    if (typeof original.code === 'string') refusal.code = original.code;
    if (typeof original.outcome === 'string') refusal.outcome = original.outcome;
    preCreationRefusals.set(refusal, path.resolve(journalPath));
    throw refusal;
  }
  let fly = flyRunner;
  let allocate = portAllocator;
  if (!fly || !allocate) {
    const { createFlyRunner, unusedLoopbackPort } = await import(pathToFileURL(path.join(flujoCloudPath, 'lib', 'process.mjs')).href);
    if (!fly && (!flyEnv || !path.isAbsolute(flyctlPath ?? '') || flyEnv.FLYCTL_PATH !== flyctlPath
      || !flyEnv.FLY_CONFIG_DIR || flyEnv.FLY_API_TOKEN)) {
      throw new Error('An isolated personal Fly account and bundled helper are required for the relay.');
    }
    fly ??= createFlyRunner({ env: flyEnv, binary: flyctlPath });
    allocate ??= unusedLoopbackPort;
  }
  const secret = randomBytes(32).toString('base64url');
  const owner = randomBytes(16).toString('hex');
  let state = { version: 1, kind: 'seagulled-owned-relay', app, org, network, accountRef,
    region, secret,
    owner, appCreated: false, appId: null, ownershipConfirmed: false, machineId: null,
    state: 'planned', createdAt: new Date().toISOString() };
  writeFileSync(journalPath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  const record = (patch) => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    const temporary = `${journalPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, journalPath);
  };
  let token;
  let proxy;
  let agent;
  const request = async (method, suffix, body) => fetchImpl(`${API}${suffix}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  const stopTransport = async () => {
    await agent?.stop();
    if (proxy) { proxy.stdin.end(); proxy.kill(); proxy = undefined; }
  };
  const ownedApp = async () => {
    const response = await request('GET', `/apps/${app}`);
    if (response.status === 404) return false;
    if (response.status !== 200 || !state.appId) throw new Error('Relay app identity is unconfirmed.');
    const details = await response.json();
    if (details.id !== state.appId || details.name !== app || details.organization?.slug !== org) {
      throw new Error('Relay app identity changed; preserve the journal without deleting this app.');
    }
    assertAppNetwork(await readFlyOrgApps({ org, token, fetchImpl }), { app, appId: state.appId, network });
    if (!state.ownershipConfirmed) throw new Error('Relay app ownership marker was not confirmed.');
    const secrets = flyArray(await fly.run(['secrets', 'list', '--app', app, '--json']), 'secret');
    if (!secrets.some((entry) => (entry?.Name ?? entry?.name) === ownerMarker(owner))) {
      throw new Error('Relay app ownership marker is missing; preserve the app.');
    }
    return true;
  };
  const ownedMachines = async () => {
    const response = await request('GET', `/apps/${app}/machines`);
    if (response.status !== 200) throw new Error('Relay Machine inventory is unconfirmed.');
    const machines = await response.json();
    if (!Array.isArray(machines) || machines.length > 1
      || (state.machineId && (machines.length !== 1 || machines[0]?.id !== state.machineId))) {
      throw new Error('Relay Machine inventory changed; preserve the app.');
    }
    for (const machine of machines) {
      const metadata = await request('GET', `/apps/${app}/machines/${machine.id}/metadata`);
      const marker = metadata.status === 200 ? await metadata.json() : null;
      if (marker?.seagulled !== 'owned-relay' || marker?.seagulled_owner !== owner) {
        throw new Error('Relay Machine ownership marker is unconfirmed.');
      }
    }
  };
  const noVolumes = async () => {
    const volumes = flyArray(await fly.run(['volumes', 'list', '--app', app, '--json']), 'volume');
    if (volumes.length !== 0) throw new Error('A volume exists in the relay app; preserve the app.');
  };
  const retire = async () => {
    await stopTransport();
    if (!state.appCreated) return false;
    record({ state: 'retiring' });
    try {
      if (!(await ownedApp())) {
        record({ state: 'retired', cleanupConfirmed: true });
        return true;
      }
      await verifyNetwork?.({ allowPending: true, operation: 'cleanup' });
      await ownedMachines();
      await noVolumes();
    } catch (error) {
      record({ state: 'cleanup-unknown', cleanupConfirmed: false, error: String(error.message).slice(0, 200) });
      return false;
    }
    await fly.run(['apps', 'destroy', app, '--yes']).catch(() => undefined);
    const readback = await request('GET', `/apps/${app}`).catch(() => null);
    const confirmed = readback?.status === 404;
    record({ state: confirmed ? 'retired' : 'cleanup-unknown', cleanupConfirmed: confirmed });
    return confirmed;
  };
  try {
    await onPlannedApp?.({ app, org, network, accountRef, kind: 'relay' });
    token = (await fly.run(['auth', 'token'])).trim();
    if (!token) throw new Error('Fly authentication is unavailable.');
    assertFreshAppName(await readFlyOrgApps({ org, token, fetchImpl }), app, network);
    await verifyNetwork?.({ allowPending: true });
    record({ state: 'creating-app' });
    await fly.run(['apps', 'create', app, '--org', org, '--network', network, '--json', '--yes']);
    record({ appCreated: true, state: 'verifying-app' });
    // Capture the new app's stable ID before any Machine mutation.
    const details = await request('GET', `/apps/${app}`);
    if (details.status !== 200) throw new Error('New relay app readback is unavailable.');
    const value = await details.json();
    if (typeof value.id !== 'string' || !value.id || value.name !== app || value.organization?.slug !== org) {
      throw new Error('New relay app identity could not be confirmed.');
    }
    record({ appId: value.id, state: 'marking-app' });
    assertAppNetwork(await readFlyOrgApps({ org, token, fetchImpl }), { app, appId: value.id, network });
    await verifyNetwork?.({ allowPending: true });
    await fly.run(['secrets', 'import', '--app', app, '--stage'], { input: `${ownerMarker(owner)}=1\n` });
    const secrets = flyArray(await fly.run(['secrets', 'list', '--app', app, '--json']), 'secret');
    if (!secrets.some((entry) => (entry?.Name ?? entry?.name) === ownerMarker(owner))) {
      throw new Error('New relay app ownership marker could not be confirmed.');
    }
    record({ ownershipConfirmed: true, state: 'creating-machine' });
    const source = readFileSync(RELAY_SOURCE);
    const response = await request('POST', `/apps/${app}/machines`, { name: 'relay', region, config: {
      image: 'registry-1.docker.io/library/node:22-alpine', init: { cmd: ['node', '/relay/relay.mjs'] },
      files: [{ guest_path: '/relay/relay.mjs', raw_value: source.toString('base64') }],
      env: { RELAY_SECRET: secret, RELAY_PORT: '4300' }, services: [], restart: { policy: 'always' },
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 }, metadata: { seagulled: 'owned-relay', seagulled_owner: owner },
    } });
    if (!response.ok) throw new Error(`Owned relay Machine creation returned HTTP ${response.status}.`);
    const machine = await response.json();
    if (typeof machine.id !== 'string' || !/^[a-zA-Z0-9]+$/.test(machine.id)) throw new Error('Fly returned an invalid relay Machine identity.');
    record({ machineId: machine.id, state: 'ready' });
    return {
      app, appId: value.id, machineId: machine.id, remoteUrl: `http://${app}.internal:4300`,
      async start(controllerOrigin) {
        if (proxy) throw new Error('Relay transport is already running.');
        await verifyNetwork?.({ allowPending: true });
        if (!(await ownedApp())) throw new Error('Owned relay app disappeared before proxy connection.');
        const port = await allocate();
        const binary = flyctlPath ?? flyEnv?.FLYCTL_PATH ?? process.env.FLYCTL_PATH ?? 'flyctl';
        proxy = spawnImpl(binary, ['proxy', `${port}:4300`, `${machine.id}.vm.${app}.internal`,
          '--app', app, '--org', org, '--bind-addr', '127.0.0.1', '--watch-stdin', '--quiet'],
        { windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'], ...(flyEnv ? { env: flyEnv } : {}) });
        let exited = false;
        proxy.on('error', () => { exited = true; });
        proxy.on('exit', () => { exited = true; });
        for (let attempt = 0; attempt < 40; attempt++) {
          if (exited) throw new Error('Owned relay proxy exited before readiness.');
          const healthy = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
            .then((res) => res.status === 200, () => false);
          if (healthy) {
            agent = agentFactory({ relayOrigin: `http://127.0.0.1:${port}`, secret, controllerOrigin, lanes: 2, limits: PRODUCT_RELAY_LIMITS });
            return;
          }
          await sleep(250);
        }
        throw new Error('Owned relay proxy did not become ready.');
      },
      close: stopTransport,
      retire,
    };
  } catch (error) {
    await stopTransport();
    if (state.appCreated) {
      const confirmed = await retire().catch(() => false);
      if (!confirmed) throw Object.assign(new Error(`${error.message} Owned relay cleanup is unconfirmed; preserve its intent.`),
        { code: 'UNKNOWN', unknown: true });
    } else if (state.state === 'creating-app') {
      record({ state: 'creation-unknown', error: String(error.message).slice(0, 200) });
      throw Object.assign(new Error('Owned relay app creation outcome is unknown; reconcile its exact intent before retrying.'),
        { code: 'UNKNOWN', unknown: true });
    } else record({ state: 'not-applied', error: String(error.message).slice(0, 200) });
    throw error;
  }
}
