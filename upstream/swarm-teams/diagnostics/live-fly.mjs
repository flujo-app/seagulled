// Live check, not part of `node --test`: provisions ONE real Fly Worker from the local
// `swarm-boot` workspace (node swarm.mjs install --workspace swarm-boot --boot), runs one team task on it and retires it. Costs money.
//   SWARM_ALLOW_LIVE_FLY=yes FLUJO_CLOUD_PATH=<flujo-cloud checkout> node diagnostics/live-fly.mjs
import { flyProvisioner } from '../fleet/provisioners.mjs';

if (process.env.SWARM_ALLOW_LIVE_FLY !== 'yes') throw new Error('Live Fly diagnostics require SWARM_ALLOW_LIVE_FLY=yes.');

const provisioner = await flyProvisioner({ flujoCloudPath: process.env.FLUJO_CLOUD_PATH, templateWorkspace: 'swarm-boot' });
const worker = { id: `w-live${Date.now().toString(36).slice(-4)}` };
const started = Date.now();
let target;
try {
  target = await provisioner.provision(worker, null);
  console.log(JSON.stringify({ step: 'provisioned', app: target.app, seconds: Math.round((Date.now() - started) / 1000) }));
  const connection = await provisioner.connect(target);
  try {
    const result = await connection.client.runFlow({ flowName: 'swarm_team', timeoutMs: 20 * 60_000,
      prompt: 'In this sandbox, find out with two agents working in parallel (a) the Linux kernel version and CPU count, and (b) the Python and Node versions installed. Each agent must run real commands. Then write the combined facts to a file facts.txt and give me its exact contents and absolute path.' });
    console.log(JSON.stringify({ step: 'ran', status: result.status, error: result.error, output: result.output }));
    if (result.status !== 'completed') {
      const { body } = await connection.client.conversation(result.conversationId);
      const { messages = [], ...rest } = body ?? {};
      console.log(JSON.stringify({ step: 'diagnosis', conversation: rest, tail: messages.slice(-3) }).slice(0, 4000));
    }
  } finally { await connection.close(); }
} catch (error) {
  console.log(JSON.stringify({ step: 'failed', error: error.message }));
  process.exitCode = 1;
} finally {
  if (target) console.log(JSON.stringify({ step: 'retired', result: await provisioner.retire(target).catch((error) => ({ error: error.message })) }));
}
