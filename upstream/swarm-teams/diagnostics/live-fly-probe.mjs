// Diagnostic: boot one Fly Worker from `swarm-boot`, try ways to start its bundled tool
// servers, print what works, retire it. Costs money.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FlujoClient } from '../lib/flujo-client.mjs';

if (process.env.SWARM_ALLOW_LIVE_FLY !== 'yes') throw new Error('Live Fly diagnostics require SWARM_ALLOW_LIVE_FLY=yes.');

const lib = (name) => import(pathToFileURL(path.join(process.env.FLUJO_CLOUD_PATH, 'lib', name)).href);
const { ManagedCloud } = await lib('managed.mjs');
const { createFlyRunner, unusedLoopbackPort } = await lib('process.mjs');
const { readPrivateJson } = await lib('private-files.mjs');
const managed = new ManagedCloud();
const app = `swarm-probe-${Date.now().toString(36)}`;
const out = (value) => console.log(JSON.stringify(value).slice(0, 1500));
try {
  const up = await managed.up({ workspace: 'swarm-boot', app, memoryMb: 4096, flowIds: ['swarm_boot'] });
  const fly = createFlyRunner({ env: managed.env, binary: managed.env.FLYCTL_PATH || 'flyctl' });
  for (const command of ['ls /app/mcp-servers /app/mcp-servers/filesystem', 'ls /app/node_modules/.bin', 'ls /data/flujo/workspaces/swarm-boot /data/flujo/workspaces/swarm-boot/mcp-servers']) {
    const result = await fly.run(['machine', 'exec', up.machineId, command, '--app', app]).catch((error) => error.message);
    out({ command, result: String(result).split('\n').filter((line) => /mcp|flujo|filesystem|dist|package|No such|db|userdata/i.test(line)).slice(0, 25) });
  }
  const credentials = await readPrivateJson(managed.paths(app).credentials);
  const proxy = await fly.proxy({ app, org: up.org, machineId: up.machineId, localPort: await unusedLoopbackPort() });
  const client = new FlujoClient({ origin: proxy.origin, workspace: 'swarm-boot', token: credentials.token });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const servers = await client.servers();
  const original = servers.find((server) => server.name === 'filesystem');
  out({ restored: { ...original, env: Object.keys(original?.env ?? {}) } });
  const variants = {
    npx: { name: 'filesystem', transport: 'stdio', command: 'npx', args: ['--no-install', 'flujo-mcp-filesystem'], env: {}, disabled: false },
    appRoot: { ...original, disabled: false, env: {}, cwd: '/app/mcp-servers/filesystem', rootPath: '/app/mcp-servers/filesystem' },
  };
  for (const [label, config] of Object.entries(variants)) {
    const put = await client.api('PUT', '/api/mcp/servers/filesystem', config);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const status = await client.api('GET', '/api/mcp/servers/filesystem/status');
    const tools = await client.api('GET', '/api/mcp/servers/filesystem/tools');
    out({ label, put: put.status, status: status.body, tools: Array.isArray(tools.body) ? tools.body.length : tools.body });
  }
  await proxy.stop();
} catch (error) {
  out({ failed: error.message });
} finally {
  out({ down: await managed.down(app).catch((error) => ({ error: error.message })) });
}
