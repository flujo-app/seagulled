// How a child Worker comes to exist. Both provisioners return a `target` the controller
// stores in its registry; credentials that must stay private are looked up at connect time.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FlujoClient } from '../lib/flujo-client.mjs';
import { installTemplate } from '../install.mjs';
import { BOOT_FLOW } from '../template/flows.mjs';
import { MODEL_ID } from '../install.mjs';
import { attemptError, cleanupAttempt, provisionWithCleanup } from './attempt.mjs';

/**
 * A Worker is a fresh workspace on one FLUJO instance. Workspaces have their own flows,
 * conversations and MCP servers but share that machine's filesystem, so this is for
 * development and for teams that do not need separate sandboxes.
 */
export function workspaceProvisioner({ origin, token, model, browser = true, teamLimits, specialists }) {
  return {
    async provision(worker, fleet, context = {}) {
      const target = { kind: 'workspace', origin, workspace: `swarm-${worker.id}`, token };
      await installTemplate(new FlujoClient(target), { model, fleet, browser,
        limits: context.teamLimits ?? teamLimits, specialists: context.specialists ?? specialists });
      return target;
    },
    async retire(target) {
      await new FlujoClient(target).deleteWorkspace(target.workspace);
    },
  };
}

/**
 * A Worker is its own Fly Machine and volume: a real separate sandbox. flujo-cloud clones
 * the prepared template workspace from the local FLUJO into the Machine. The controller
 * must run where flujo-cloud can run (Fly CLI signed in, native FLUJO as snapshot source).
 * Child Workers can use the fleet tools only if `fleet.url` is reachable from Fly.
 */
export async function flyProvisioner({ flujoCloudPath, templateWorkspace, source, org, network, accountRef,
  region = 'iad', memoryMb = 4096, fleetReachable = false, concurrency = 8, initialWorkers = 0,
  captureSpacingMs = 8000, teamLimits, specialists, flyEnv, cloudDirectory,
  onPlannedApp, onConfirmedApp, onRetiredApp, verifyNetwork,
  installTemplateImpl = installTemplate }) {
  const lib = (name) => import(pathToFileURL(path.join(flujoCloudPath, 'lib', name)).href);
  const { ManagedCloud } = await lib('managed.mjs');
  const { createFlyRunner, unusedLoopbackPort } = await lib('process.mjs');
  const { readPrivateJson } = await lib('private-files.mjs');
  const managed = new ManagedCloud({ ...(flyEnv ? { env: flyEnv } : {}),
    ...(cloudDirectory ? { directory: cloudDirectory } : {}) });
  if (network && (ManagedCloud.privateNetworkContractVersion !== 1
    || typeof accountRef !== 'string' || !/^fly-account-sha256:[a-f0-9]{64}$/.test(accountRef)
    || typeof onPlannedApp !== 'function' || typeof onConfirmedApp !== 'function'
    || typeof onRetiredApp !== 'function' || typeof verifyNetwork !== 'function')) {
    throw new Error('The pinned cloud SDK and goal network journal are not ready for private Worker creation.');
  }
  if (network && (!Number.isSafeInteger(initialWorkers) || initialWorkers < 0
    || initialWorkers > concurrency)) {
    throw new Error('The initial Worker network barrier does not match the bounded fleet.');
  }
  let initialOutstanding = initialWorkers;
  let releaseInitial;
  let rejectInitial;
  const initialReady = new Promise((resolve, reject) => {
    releaseInitial = resolve; rejectInitial = reject;
  });
  initialReady.catch(() => undefined);
  if (!initialOutstanding) releaseInitial();
  const waitNetworkReady = async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await verifyNetwork({ allowPending: false }); return; }
      catch (error) {
        if (error.code !== 'NETWORK_PENDING' || attempt === 39) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
  const verifyDeployment = async (app, appId) => {
    const { metadata, journal } = await managed.deployment(app);
    if (!journal || metadata.network !== network || journal.network !== network
      || journal.app !== app || journal.appId !== appId || journal.ownershipConfirmed !== true
      || journal.org !== org || metadata.org !== org || journal.state !== 'ready') {
      throw new Error('The owned Worker network receipt does not match its private SDK journal.');
    }
    return journal;
  };
  // Bounded parallel provisioning. Snapshot capture of the one template workspace is
  // exclusive, so a busy source is retried instead of failing the Worker.
  let active = 0;
  const waiting = [];
  const slot = async () => { if (active >= concurrency) await new Promise((resolve) => waiting.push(resolve)); active++; };
  const release = () => { active--; waiting.shift()?.(); };
  // Captures of the one template workspace must not overlap: space the starts, and if two
  // still collide, clear the failed attempt and try again under a fresh app name.
  let gate = Promise.resolve();
  const turn = () => { const mine = gate; gate = gate.then(() => new Promise((resolve) => setTimeout(resolve, captureSpacingMs))); return mine; };
  const appName = () => {
    const app = `seagulled-worker-${randomBytes(8).toString('hex')}`;
    const written = onPlannedApp({ app, kind: 'worker', org, network, accountRef });
    if (written && typeof written.then === 'function') {
      throw new Error('The goal Worker app plan must be durable before creation.');
    }
    return app;
  };
  const up = (worker, options) => provisionWithCleanup({ managed, worker, options, turn,
    ...(network ? { appName,
      beforeUp: () => verifyNetwork({ allowPending: true }),
      beforeCleanup: () => verifyNetwork({ allowPending: true }),
      onCleanup: onRetiredApp } : {}) });

  return {
    async provision(worker, fleet, context = {}) {
      let result;
      await slot();
      try { result = await up(worker, { workspace: templateWorkspace, source, org, network,
        region, memoryMb, flowIds: [BOOT_FLOW] }); }
      catch (error) { if (initialOutstanding) rejectInitial(error); throw error; }
      finally { release(); }
      const app = result.worker;
      if (network) {
        try {
          const journal = await managed.deployment(app).then((value) => value.journal);
          if (!journal?.appId || !journal.owner || journal.network !== network
            || journal.ownershipConfirmed !== true) {
            throw new Error('The owned Worker app has no confirmed private network receipt.');
          }
          await verifyDeployment(app, journal.appId);
          await onConfirmedApp({ app, appId: journal.appId,
            ownerMarker: `FLUJO_CLOUD_OWNER_${journal.owner.replaceAll('-', '').toUpperCase()}`,
            kind: 'worker' });
          await verifyNetwork({ allowPending: true });
          if (initialOutstanding) {
            initialOutstanding--;
            if (!initialOutstanding) { await waitNetworkReady(); releaseInitial(); }
            else await initialReady;
          }
        } catch (error) { rejectInitial(error); throw error; }
      }
      const reachable = fleetReachable || Boolean(fleet?.remoteUrl);
      const target = { kind: 'fly', app: result.worker, org: result.org,
        ...(network ? { network, accountRef, appId: (await managed.deployment(app)).journal.appId } : {}),
        machineId: result.machineId, workspace: templateWorkspace };
      // The clone is tool-free (see bootSpec). Switch on the Worker's own tool servers and
      // install the swarm flows there. Without a controller URL that Fly can reach the Worker
      // is a leaf: a full team of local agents in its own sandbox, but no delegation or board.
      let connection;
      try {
        connection = await this.connect(target);
        await installTemplateImpl(connection.client, { model: { id: MODEL_ID }, enableBundled: true,
          fleet: reachable ? { url: fleet.remoteUrl ?? fleet.url, token: fleet.token } : undefined,
          limits: context.teamLimits ?? teamLimits,
          specialists: context.specialists ?? specialists });
      } catch (error) {
        if (error.code === 'NETWORK_MEMBERSHIP') throw error;
        if (network) await verifyNetwork({ allowPending: true });
        const cleanup = await cleanupAttempt(managed, app);
        if (cleanup.confirmed && network) await onRetiredApp(app);
        throw attemptError(error, cleanup);
      } finally { await connection?.close(); }
      return target;
    },
    async connect(target) {
      if (network) {
        if (target.network !== network || target.accountRef !== accountRef
          || target.org !== org || !target.appId) {
          throw new Error('The Worker target is not pinned to the goal network.');
        }
        await verifyDeployment(target.app, target.appId);
        await waitNetworkReady();
      }
      await managed.runtime();
      // A Worker this provisioner created keeps its bearer in flujo-cloud's private store;
      // an existing always-on worker brings its own.
      const credentials = target.token ? { token: target.token } : await readPrivateJson(managed.paths(target.app).credentials);
      const fly = createFlyRunner({ env: managed.env, binary: managed.env.FLYCTL_PATH || 'flyctl' });
      const proxy = await fly.proxy({ app: target.app, org: target.org, machineId: target.machineId, localPort: await unusedLoopbackPort() });
      // The proxy needs a moment before it accepts connections.
      const client = new FlujoClient({ origin: proxy.origin, workspace: target.workspace, token: credentials.token });
      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          proxy.check();
          if ((await client.api('GET', '/api/worker/status', undefined, { timeoutMs: 3000 }).catch(() => null))?.status === 200) {
            return { client, close: () => proxy.stop() };
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error('The Fly Worker did not become reachable; no flow was submitted.');
      } catch (error) { await proxy.stop(); throw error; }
    },
    async retire(target) {
      if (network) {
        if (target.network !== network || target.accountRef !== accountRef
          || target.org !== org || !target.appId) {
          throw new Error('The Worker target is not pinned to the goal network.');
        }
        await verifyDeployment(target.app, target.appId);
        await verifyNetwork({ allowPending: true });
      }
      const cleanup = await cleanupAttempt(managed, target.app);
      if (!cleanup.confirmed) throw new Error(cleanup.error);
      if (network) { await onRetiredApp(target.app); await verifyNetwork({ allowPending: true }); }
    },
  };
}

/**
 * Branch nodes are workspaces next to the controller, so they can use the fleet tools;
 * nodes at the deepest level are separate Fly sandboxes.
 */
export function mixedProvisioner({ branch, leaf }) {
  const of = (target) => (['fly', 'flyproxy'].includes(target.kind) ? leaf : branch);
  return {
    provision: (worker, fleet, context) => (context?.isLeaf ? leaf : branch).provision(worker, fleet, context),
    retire: (target) => of(target).retire(target),
    connect: (target) => (of(target).connect ? of(target).connect(target) : { client: new FlujoClient(target), close: async () => undefined }),
  };
}
