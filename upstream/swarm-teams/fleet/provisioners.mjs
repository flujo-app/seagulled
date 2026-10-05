// How a child Worker comes to exist. Both provisioners return a `target` the controller
// stores in its registry; credentials that must stay private are looked up at connect time.
import path from 'node:path';
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
export function workspaceProvisioner({ origin, token, model, browser = true, specialists }) {
  return {
    async provision(worker, fleet, context = {}) {
      const target = { kind: 'workspace', origin, workspace: `swarm-${worker.id}`, token };
      await installTemplate(new FlujoClient(target), { model, fleet, browser, specialists: context.specialists ?? specialists });
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
export async function flyProvisioner({ flujoCloudPath, templateWorkspace, source, org, region = 'iad', memoryMb = 4096, fleetReachable = false, concurrency = 8, captureSpacingMs = 8000, teamLimits, specialists }) {
  const lib = (name) => import(pathToFileURL(path.join(flujoCloudPath, 'lib', name)).href);
  const { ManagedCloud } = await lib('managed.mjs');
  const { createFlyRunner, unusedLoopbackPort } = await lib('process.mjs');
  const { readPrivateJson } = await lib('private-files.mjs');
  const managed = new ManagedCloud();
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
  const up = (worker, options) => provisionWithCleanup({ managed, worker, options, turn });

  return {
    async provision(worker, fleet, context = {}) {
      let result;
      await slot();
      try { result = await up(worker, { workspace: templateWorkspace, source, org, region, memoryMb, flowIds: [BOOT_FLOW] }); }
      finally { release(); }
      const app = result.worker;
      const reachable = fleetReachable || Boolean(fleet?.remoteUrl);
      const target = { kind: 'fly', app: result.worker, org: result.org, machineId: result.machineId, workspace: templateWorkspace };
      // The clone is tool-free (see bootSpec). Switch on the Worker's own tool servers and
      // install the swarm flows there. Without a controller URL that Fly can reach the Worker
      // is a leaf: a full team of local agents in its own sandbox, but no delegation or board.
      let connection;
      try {
        connection = await this.connect(target);
        await installTemplate(connection.client, { model: { id: MODEL_ID }, enableBundled: true,
          fleet: reachable ? { url: fleet.remoteUrl ?? fleet.url, token: fleet.token } : undefined, limits: teamLimits,
          specialists: context.specialists ?? specialists });
      } catch (error) {
        throw attemptError(error, await cleanupAttempt(managed, app));
      } finally { await connection?.close(); }
      return target;
    },
    async connect(target) {
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
      const cleanup = await cleanupAttempt(managed, target.app);
      if (!cleanup.confirmed) throw new Error(cleanup.error);
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
