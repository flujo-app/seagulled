// Read a managed Fly Worker's bootstrap status, then optionally retire it.
//   SWARM_ALLOW_LIVE_FLY=yes FLUJO_CLOUD_PATH=<flujo-cloud checkout> node diagnostics/live-fly-inspect.mjs <worker app> [--down]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flyProvisioner } from '../fleet/provisioners.mjs';

if (process.env.SWARM_ALLOW_LIVE_FLY !== 'yes') throw new Error('Live Fly diagnostics require SWARM_ALLOW_LIVE_FLY=yes.');

const [app, flag] = process.argv.slice(2);
const lib = (name) => import(pathToFileURL(path.join(process.env.FLUJO_CLOUD_PATH, 'lib', name)).href);
const { ManagedCloud } = await lib('managed.mjs');
const { Journal } = await lib('journal.mjs');
const managed = new ManagedCloud();
const journal = await new Journal(managed.paths(app).journal).read();
console.log(JSON.stringify({ journal: { state: journal.state, stage: journal.stage, machineId: journal.machineId, image: journal.image.slice(-20) } }));
const provisioner = await flyProvisioner({ flujoCloudPath: process.env.FLUJO_CLOUD_PATH, templateWorkspace: journal.workspace });
const target = { kind: 'fly', app, org: journal.org, machineId: journal.machineId, workspace: journal.workspace };
if (journal.machineId) {
  const connection = await provisioner.connect(target).catch((error) => ({ error }));
  if (connection.error) console.log(JSON.stringify({ connect: connection.error.message }));
  else {
    const status = await connection.client.api('GET', '/api/worker/status', undefined, { timeoutMs: 10_000 }).catch((error) => ({ error: error.message }));
    console.log(JSON.stringify({ status }).slice(0, 3000));
    await connection.close();
  }
}
if (flag === '--down') console.log(JSON.stringify({ down: await provisioner.retire(target).catch((error) => ({ error: error.message })) }));
