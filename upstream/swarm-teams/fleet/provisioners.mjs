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
  verifyFreshApp, onPlannedApp, onConfirmedApp, onRetiredApp, verifyNetwork,
  installTemplateImpl = installTemplate }) {
  const lib = (name) => import(pathToFileURL(path.join(flujoCloudPath, 'lib', name)).href);
  const { ManagedCloud } = await lib('managed.mjs');
  const { createFlyRunner, unusedLoopbackPort } = await lib('process.mjs');
  const { readPrivateJson } = await lib('private-files.mjs');
  const { controlToken } = network ? await lib('snapshot.mjs') : {};
  const managed = new ManagedCloud({ ...(flyEnv ? { env: flyEnv } : {}),
    ...(cloudDirectory ? { directory: cloudDirectory } : {}) });
  if (network && (ManagedCloud.privateNetworkContractVersion !== 1
    || typeof managed.openOwnedProxy !== 'function'
    || typeof managed.credential !== 'function' || typeof controlToken !== 'function'
    || typeof accountRef !== 'string' || !/^fly-account-sha256:[a-f0-9]{64}$/.test(accountRef)
    || typeof verifyFreshApp !== 'function' || typeof onPlannedApp !== 'function' || typeof onConfirmedApp !== 'function'
    || typeof onRetiredApp !== 'function' || typeof verifyNetwork !== 'function')) {
    throw new Error('The pinned cloud SDK and goal network journal are not ready for private Worker creation.');
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error('Worker provisioning concurrency must be between 1 and 100.');
  }
  if (network && (!Number.isSafeInteger(initialWorkers) || initialWorkers < 0
    || initialWorkers > 100)) {
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
  const waitNetworkReady = async (operation = 'dispatch') => {
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await verifyNetwork({ allowPending: false, operation }); return; }
      catch (error) {
        if (error.code !== 'NETWORK_PENDING' || attempt === 39) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
  const verifyDeployment = async (app, appId, { machineId, workspace } = {}) => {
    const deployment = await managed.deployment(app);
    const { metadata, journal } = deployment;
    if (!journal || metadata.network !== network || journal.network !== network
      || journal.app !== app || journal.appId !== appId || journal.ownershipConfirmed !== true
      || journal.org !== org || metadata.org !== org || metadata.phase !== 'ready'
      || journal.state !== 'ready' || journal.stage !== 'ready'
      || metadata.profile !== 'private-workspace' || journal.profile !== 'private-workspace'
      || journal.workspace !== templateWorkspace || metadata.workspace !== templateWorkspace
      || typeof journal.machineId !== 'string' || !journal.machineId
      || machineId !== undefined && journal.machineId !== machineId
      || workspace !== undefined && journal.workspace !== workspace) {
      throw new Error('The owned Worker network receipt does not match its private SDK journal.');
    }
    return deployment;
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
  const appName = async () => {
    const app = `swarm-worker-${randomBytes(8).toString('hex')}`;
    await verifyFreshApp({ app, kind: 'worker', org, network, accountRef });
    const written = onPlannedApp({ app, kind: 'worker', org, network, accountRef });
    if (written && typeof written.then === 'function') {
      throw new Error('The goal Worker app plan must be durable before creation.');
    }
    return app;
  };
  const up = (worker, options) => provisionWithCleanup({ managed, worker, options, turn,
    ...(network ? { appName,
      beforeUp: () => verifyNetwork({ allowPending: true }),
      beforeCleanup: () => verifyNetwork({ allowPending: true, operation: 'cleanup' }),
      onCleanup: onRetiredApp } : {}) });
  const cleanupProvisioned = async (app) => {
    if (network) {
      try { await verifyNetwork({ allowPending: true, operation: 'cleanup' }); }
      catch (error) { return { confirmed: false, app, error: error.message }; }
    }
    const cleanup = await cleanupAttempt(managed, app);
    if (cleanup.confirmed && network) {
      try { await onRetiredApp(app); }
      catch (error) { return { confirmed: false, app, error: error.message }; }
    }
    return cleanup;
  };

  return {
    async provision(worker, fleet, context = {}) {
      let result;
      await slot();
      try { result = await up(worker, { workspace: templateWorkspace, source, org, network,
        region, memoryMb, flowIds: [BOOT_FLOW],
        ...(network ? { profile: 'private-workspace' } : {}) }); }
      catch (error) { if (initialOutstanding) rejectInitial(error); throw error; }
      // The provisioning slot is released before the group barrier. More initial
      // Workers than capture slots can therefore finish without deadlocking.
      finally { release(); }
      const app = result.worker;
      let confirmedAppId;
      if (network) {
        try {
          const journal = await managed.deployment(app).then((value) => value.journal);
          if (!journal?.appId || !journal.owner || journal.network !== network
            || journal.ownershipConfirmed !== true || result.machineId !== journal.machineId
            || result.workspace !== templateWorkspace) {
            throw new Error('The owned Worker app has no confirmed private network receipt.');
          }
          await verifyDeployment(app, journal.appId, { machineId: result.machineId,
            workspace: templateWorkspace });
          confirmedAppId = journal.appId;
          await onConfirmedApp({ app, appId: journal.appId,
            ownerMarker: `FLUJO_CLOUD_OWNER_${journal.owner.replaceAll('-', '').toUpperCase()}`,
            kind: 'worker' });
          await verifyNetwork({ allowPending: true });
          if (initialOutstanding) {
            initialOutstanding--;
            if (!initialOutstanding) { await waitNetworkReady(); releaseInitial(); }
            else await initialReady;
          }
        } catch (error) {
          rejectInitial(error);
          throw attemptError(error, await cleanupProvisioned(app));
        }
      }
      const reachable = fleetReachable || Boolean(fleet?.remoteUrl);
      const target = { kind: 'fly', app: result.worker, org: result.org,
        ...(network ? { network, accountRef, appId: confirmedAppId } : {}),
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
        if (error.code === 'NETWORK_MEMBERSHIP' || error.code === 'PROXY_CLEANUP_UNKNOWN') {
          throw attemptError(error, { confirmed: false, app, error: error.message });
        }
        throw attemptError(error, await cleanupProvisioned(app));
      } finally { await connection?.close(); }
      return target;
    },
    async connect(target, { operation = 'dispatch' } = {}) {
      let originalDeployment;
      if (network) {
        if (target.network !== network || target.accountRef !== accountRef
          || target.org !== org || !target.appId
          || target.workspace !== templateWorkspace
          || typeof target.machineId !== 'string' || !target.machineId) {
          throw new Error('The Worker target is not pinned to the goal network.');
        }
        originalDeployment = await verifyDeployment(target.app, target.appId, { machineId: target.machineId,
          workspace: target.workspace });
        await waitNetworkReady(operation);
      }
      let proxy;
      const closeProxy = async () => {
        if (!proxy) return;
        const stopped = await proxy.stop();
        if (network && stopped?.childClosed !== true) {
          throw new Error('The owned Worker proxy supplied no observed child-close result.');
        }
      };
      try {
        if (network) {
          // The SDK must perform fresh owned-app, exact Machine marker/config,
          // and pinned-image checks before it opens its own proxy.
          proxy = await managed.openOwnedProxy({ app: target.app, appId: target.appId,
            org, network, machineId: target.machineId, workspace: target.workspace });
          if (typeof proxy?.origin !== 'string' || typeof proxy.check !== 'function'
            || typeof proxy.stop !== 'function') {
            throw new Error('The pinned cloud SDK returned no owned proxy lifecycle.');
          }
        } else {
          await managed.runtime();
          const fly = createFlyRunner({ env: managed.env, binary: managed.env.FLYCTL_PATH || 'flyctl' });
          proxy = await fly.proxy({ app: target.app, org: target.org,
            machineId: target.machineId, localPort: await unusedLoopbackPort() });
        }
        // The goal-private bearer belongs to the exact managed attempt, never the target.
        let credentials;
        if (network) {
          const current = await verifyDeployment(target.app, target.appId,
            { machineId: target.machineId, workspace: target.workspace });
          if (current.metadata.attemptId !== originalDeployment.metadata.attemptId
            || current.journal.owner !== originalDeployment.journal.owner) {
            throw new Error('The owned Worker attempt changed while opening its proxy.');
          }
          credentials = await managed.credential(current.files, current.metadata, { required: true });
        } else {
          credentials = target.token ? { token: target.token }
            : await readPrivateJson(managed.paths(target.app).credentials);
        }
        const token = network ? controlToken(credentials?.token, 'Saved Worker credential') : credentials.token;
        const client = new FlujoClient({ origin: proxy.origin, workspace: target.workspace, token });
        // The proxy needs a moment before it accepts connections.
        for (let attempt = 0; attempt < 40; attempt++) {
          proxy.check();
          if ((await client.api('GET', '/api/worker/status', undefined, { timeoutMs: 3000 }).catch(() => null))?.status === 200) {
            return { client, close: async () => {
              try { await closeProxy(); }
              catch (cause) { throw Object.assign(new Error('Owned Worker proxy cleanup is unconfirmed.', { cause }),
                { code: 'PROXY_CLEANUP_UNKNOWN' }); }
            } };
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error('The Fly Worker did not become reachable; no flow was submitted.');
      } catch (error) {
        try { await closeProxy(); }
        catch (cause) { throw Object.assign(new Error('Owned Worker proxy cleanup is unconfirmed.', { cause }),
          { code: 'PROXY_CLEANUP_UNKNOWN' }); }
        throw error;
      }
    },
    async retire(target) {
      if (network) {
        if (target.network !== network || target.accountRef !== accountRef
          || target.org !== org || !target.appId || target.workspace !== templateWorkspace
          || typeof target.machineId !== 'string' || !target.machineId) {
          throw new Error('The Worker target is not pinned to the goal network.');
        }
        await verifyDeployment(target.app, target.appId, { machineId: target.machineId,
          workspace: target.workspace });
        await verifyNetwork({ allowPending: true, operation: 'cleanup' });
      }
      const cleanup = await cleanupAttempt(managed, target.app);
      if (!cleanup.confirmed) throw new Error(cleanup.error);
      if (network) { await onRetiredApp(target.app); await verifyNetwork({ allowPending: true, operation: 'cleanup' }); }
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
    connect: (target, context) => (of(target).connect ? of(target).connect(target, context) : { client: new FlujoClient(target), close: async () => undefined }),
  };
}
