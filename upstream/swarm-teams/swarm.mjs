#!/usr/bin/env node
// Operator CLI for swarm teams. Private state lives in ~/.swarm-teams, never in Git.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRelayAgent } from './fleet/relay.mjs';
import { Controller } from './fleet/controller.mjs';
import { flyProvisioner, mixedProvisioner, workspaceProvisioner } from './fleet/provisioners.mjs';
import { FlujoClient, rawRequest } from './lib/flujo-client.mjs';
import { installTemplate } from './install.mjs';

const HOME = process.env.SWARM_TEAMS_HOME || path.join(homedir(), '.swarm-teams');
const CONFIG = path.join(HOME, 'config.json');

const USAGE = `swarm.mjs <command>

  init [--model-config FILE] [--flujo URL] [--port N]   write ~/.swarm-teams/config.json
  controller                                            run the fleet controller (keep it running)
  install --workspace NAME [--boot] [--flujo URL]       install the flows; --boot installs only the clone template for Fly
  goal "TEXT" [--workspace NAME] [--supervisor URL] [--supervisor-token T]
       [--max-workers N] [--max-depth N] [--max-children N]
       [--goal-file FILE]                               read multiline goal text from a UTF-8 file
  status GOAL_ID                                        goal, tree and board
  wait RUN_ID [--ms N]                                  wait for a run and print its result
  message RUN_ID "TEXT"                                 steer a running team
  retire WORKER_ID                                      retire a Worker and its subtree
  relay-up [--org SLUG] [--region iad]                  create the relay Machine on Fly (lets Fly machines reach the controller)
  relay-down                                            destroy the relay app

  goal ... --always-on N --gateway-config FILE          run the supervisor on always-on Fly worker N (1 or 2)`;

function loadConfig() {
  if (!existsSync(CONFIG)) throw new Error(`No config. Run: node swarm.mjs init`);
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}

async function operator(config, method, route, body) {
  const response = await rawRequest(`http://127.0.0.1:${config.port}${route}`, { method, body,
    headers: { Authorization: `Bearer ${config.operatorToken}` } });
  const parsed = JSON.parse(response.text || '{}');
  if (response.status > 299) throw new Error(`${parsed.error ?? response.status}: ${parsed.message ?? ''}`);
  return parsed;
}

async function provisionerFor(config) {
  const settings = config.provisioner;
  if (settings.kind === 'workspace') return workspaceProvisioner({ origin: settings.origin, token: settings.token, model: config.model });
  if (settings.kind === 'fly') return flyProvisioner(settings);
  if (settings.kind === 'mixed') {
    return mixedProvisioner({ leaf: await flyProvisioner(settings.leaf),
      branch: workspaceProvisioner({ origin: settings.branch.origin, token: settings.branch.token, model: config.model }) });
  }
  throw new Error(`Unknown provisioner ${settings.kind}.`);
}

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  'model-config': { type: 'string' }, flujo: { type: 'string' }, port: { type: 'string' }, workspace: { type: 'string' },
  token: { type: 'string' }, supervisor: { type: 'string' }, 'supervisor-token': { type: 'string' },
  boot: { type: 'boolean' }, 'goal-file': { type: 'string' }, org: { type: 'string' }, region: { type: 'string' },
  'always-on': { type: 'string' }, 'gateway-config': { type: 'string' },
  'max-workers': { type: 'string' }, 'max-depth': { type: 'string' }, 'max-children': { type: 'string' }, ms: { type: 'string' },
} });
const [command, ...rest] = positionals;
const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

try {
  const flyctl = process.env.FLYCTL_PATH || path.join(homedir(), '.fly', 'bin', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
  const fly = (args) => execFileSync(flyctl, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const saveConfig = (config) => writeFileSync(CONFIG, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (command === 'relay-up') {
    const config = loadConfig();
    if (config.relay) throw new Error(`A relay already exists: ${config.relay.app}`);
    const app = `swarm-relay-${randomBytes(4).toString('hex')}`;
    const org = values.org || 'personal';
    const secret = randomBytes(32).toString('base64url');
    fly(['apps', 'create', app, '--org', org, '--json', '--yes']);
    const source = readFileSync(fileURLToPath(new URL('./fleet/relay.mjs', import.meta.url)));
    const response = await fetch(`https://api.machines.dev/v1/apps/${app}/machines`, { method: 'POST',
      headers: { Authorization: `Bearer ${fly(['auth', 'token']).trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'relay', region: values.region || 'iad', config: {
        image: 'registry-1.docker.io/library/node:22-alpine', init: { cmd: ['node', '/relay/relay.mjs'] },
        files: [{ guest_path: '/relay/relay.mjs', raw_value: source.toString('base64') }],
        env: { RELAY_SECRET: secret, RELAY_PORT: '4300' }, services: [], restart: { policy: 'always' },
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 }, metadata: { swarm_teams: 'relay' } } }) });
    if (!response.ok) throw new Error(`Relay Machine creation failed (HTTP ${response.status}). The app ${app} exists; remove it with: flyctl apps destroy ${app}`);
    const machine = await response.json();
    saveConfig({ ...config, relay: { app, org, machineId: machine.id, secret } });
    print({ relay: app, machineId: machine.id, url: `http://${app}.internal:4300` });
  } else if (command === 'relay-down') {
    const config = loadConfig();
    if (!config.relay) throw new Error('No relay is configured.');
    fly(['apps', 'destroy', config.relay.app, '--yes']);
    const { relay, ...rest } = config;
    saveConfig(rest);
    print({ destroyed: relay.app });
  } else if (command === 'init') {
    if (existsSync(CONFIG)) throw new Error('A config already exists. Preserve its token, registry and provider identities; edit it explicitly instead of reinitializing.');
    // Default model: the private vLLM endpoint written by o-private-inference/scripts/deploy.py.
    const modelFile = values['model-config'] || path.join(homedir(), '.o-private-inference', 'o-private-qwen27-vllm.private.json');
    const source = JSON.parse(readFileSync(modelFile, 'utf8'));
    const port = Number(values.port ?? 4300);
    const flujo = values.flujo || 'http://localhost:4200';
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG, JSON.stringify({
      port, host: '127.0.0.1', publicUrl: `http://127.0.0.1:${port}`,
      operatorToken: randomBytes(32).toString('base64url'),
      registryPath: path.join(HOME, 'registry.json'),
      model: { name: source.model, baseUrl: source.baseUrl, apiKey: source.token, contextWindow: source.maxModelLen },
      supervisor: { origin: flujo, workspace: 'swarm-supervisor' },
      provisioner: { kind: 'workspace', origin: flujo },
    }, null, 2), { mode: 0o600 });
    print(`Wrote ${CONFIG}. Next: node swarm.mjs controller`);
  } else if (command === 'controller') {
    const config = loadConfig();
    let remoteUrl;
    if (config.relay) {
      // Outbound private proxy to the relay; the agent pulls Worker requests through it.
      const relayPort = config.port + 1;
      const proxy = spawn(flyctl, ['proxy', `${relayPort}:4300`, `${config.relay.machineId}.vm.${config.relay.app}.internal`,
        '--app', config.relay.app, '--org', config.relay.org, '--bind-addr', '127.0.0.1', '--quiet'], { stdio: 'ignore', windowsHide: true });
      proxy.on('exit', () => console.error('[fleet] relay proxy exited; Fly machines can no longer reach the controller.'));
      process.on('exit', () => proxy.kill());
      startRelayAgent({ relayOrigin: `http://127.0.0.1:${relayPort}`, secret: config.relay.secret,
        controllerOrigin: `http://127.0.0.1:${config.port}`, log: (line) => console.error(`[fleet] ${line}`) });
      remoteUrl = `http://${config.relay.app}.internal:4300`;
    }
    const controller = new Controller({ registryPath: config.registryPath, operatorToken: config.operatorToken,
      remoteUrl, publicUrl: config.publicUrl, provisioner: await provisionerFor(config), log: (line) => console.error(`[fleet] ${line}`) });
    const address = await controller.listen(config.port, config.host);
    print(`Fleet controller on ${address.address}:${address.port} (${config.provisioner.kind} provisioner).`);
  } else if (command === 'install') {
    const config = loadConfig();
    if (!values.workspace) throw new Error('--workspace is required.');
    const client = new FlujoClient({ origin: values.flujo || config.supervisor.origin, workspace: values.workspace, token: values.token });
    print(await installTemplate(client, { model: config.model, bootOnly: values.boot === true }));
  } else if (command === 'goal') {
    const config = loadConfig();
    if (values['goal-file']) rest[0] = readFileSync(values['goal-file'], 'utf8').trim();
    if (!rest[0]) throw new Error('Give the goal text or --goal-file FILE.');
    const limits = {};
    for (const [flag, key] of [['max-workers', 'maxWorkers'], ['max-depth', 'maxDepth'], ['max-children', 'maxChildren']]) {
      if (values[flag]) limits[key] = Number(values[flag]);
    }
    let supervisor = { origin: values.supervisor || config.supervisor.origin, workspace: values.workspace || config.supervisor.workspace,
      token: values['supervisor-token'] || config.supervisor.token };
    if (values['always-on']) {
      // Take address, workspace and bearer of an always-on worker from the private gateway config.
      const entry = JSON.parse(readFileSync(values['gateway-config'], 'utf8')).workers[Number(values['always-on']) - 1];
      const app = new URL(entry.origin).hostname.replace(/\.internal$/, '');
      const machine = JSON.parse(fly(['machine', 'list', '--app', app, '--json'])).find((item) => item.state === 'started');
      if (!machine) throw new Error(`No started Machine in ${app}.`);
      supervisor = { app, org: values.org || 'personal', machineId: machine.id, workspace: entry.workspace, token: entry.token,
        browser: false }; // additive only: never switch on a tool server the worker's owner left off
    }
    print(await operator(config, 'POST', '/goals', { text: rest[0], limits, model: config.model, supervisor }));
  } else if (command === 'status') {
    print(await operator(loadConfig(), 'GET', `/goals/${rest[0]}`));
  } else if (command === 'wait') {
    print(await operator(loadConfig(), 'GET', `/runs/${rest[0]}?waitMs=${Number(values.ms ?? 45_000)}`));
  } else if (command === 'message') {
    print(await operator(loadConfig(), 'POST', `/runs/${rest[0]}`, { message: rest[1] }));
  } else if (command === 'retire') {
    print(await operator(loadConfig(), 'DELETE', `/workers/${rest[0]}`));
  } else {
    print(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
