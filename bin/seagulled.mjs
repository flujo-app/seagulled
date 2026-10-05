#!/usr/bin/env node
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createRuntime, defaultDataDir } from '../src/runtime.mjs';
import { createServer } from '../src/server.mjs';

const HELP = `Seagulled — talk to Todd, supervise the team.

  seagulled                         Talk to Todd interactively
  seagulled goal "your goal"         Run a goal and wait for the result
  seagulled serve                    Open the conversation in your browser
  seagulled status                   See goals and spend
  seagulled providers                Discover providers
  seagulled connect PROVIDER          Use native sign-in, or a saved key
  seagulled connect PROVIDER --key-env ENV_NAME --method key
  seagulled edit GOAL --text "…" --budget 5
  seagulled pause|resume|stop GOAL
  seagulled pause-all|resume-all|stop-all

Options: --budget USD, --provider ID, --home DIRECTORY, --json, --no-open
Saved state lives in your private Seagulled folder. Keys stay out of arguments.
`;
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  budget: { type: 'string' }, provider: { type: 'string' }, home: { type: 'string' }, json: { type: 'boolean' },
  text: { type: 'string' }, method: { type: 'string' }, 'key-env': { type: 'string' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });
const [command = 'chat', ...args] = positionals;
const dataDir = path.resolve(values.home || defaultDataDir());
let runtime, service;
const print = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const open = url => {
  const cmd = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const params = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(cmd, params, { detached: true, stdio: 'ignore', windowsHide: true }); child.on('error', () => {}); child.unref();
};
async function priorSession() {
  const file = path.join(dataDir, 'session.json');
  if (!existsSync(file)) return null;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(config.url) || typeof config.token !== 'string') throw new Error('The saved session needs recovery.');
  try { process.kill(config.pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; throw e; }
  try {
    const response = await fetch(config.url + '/api/state', { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('Session authentication failed.');
    const state = await response.json(); if (state.version !== 1 || !Array.isArray(state.goals)) throw new Error('Unexpected session response.');
    return config;
  } catch (e) {
    if (e.cause?.code === 'ECONNREFUSED' || e.name === 'TimeoutError' || e.cause?.code === 'ERR_INVALID_PORT') {
      // Remove only the observed stale endpoint record; runtime ownership is
      // checked separately, before any state or registry recovery writes.
      if (readFileSync(file, 'utf8') === JSON.stringify(config)) unlinkSync(file);
      return null;
    }
    throw new Error('The saved desktop session could not be verified. Reopen Seagulled to reconcile it.');
  }
}
async function request(session, route, method = 'GET', payload) {
  const response = await fetch(session.url + route, { method, headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Seagulled could not perform that action.'); return result;
}
async function client() {
  const session = await priorSession();
  if (session) return {
    snapshot: () => request(session, '/api/state'), discover: () => request(session, '/api/providers/discover', 'POST'),
    chat: (text, options) => request(session, '/api/chat', 'POST', { text, ...options }),
    connect: payload => request(session, '/api/providers/connect', 'POST', payload),
    updateGoal: (id, patch) => request(session, `/api/goals/${encodeURIComponent(id)}`, 'PATCH', patch),
    controlGoal: (id, action) => request(session, `/api/goals/${encodeURIComponent(id)}/${action}`, 'POST'),
    controlSwarm: action => request(session, `/api/swarm/${action}`, 'POST'),
    async wait(id) {
      while (true) { const state = await request(session, '/api/state'); const goal = state.goals.find(g => g.id === id); if (!goal || !['running', 'pausing', 'stopping'].includes(goal.status)) return goal; await new Promise(r => setTimeout(r, 500)); }
    },
    session,
  };
  runtime = createRuntime({ dataDir }); await runtime.discover();
  return runtime;
}
function showState(state) {
  if (values.json) return print(state);
  print(`Spend: $${state.spend.usd.toFixed(4)} (reported + estimates); ${state.spend.subscriptionCalls} subscription calls; ${state.spend.unknownCalls} unpriced calls.`);
  for (const g of state.goals) print(`${g.id}  ${g.status}  $${g.spentUsd.toFixed(4)} / $${g.budgetUsd.toFixed(2)}\n  ${g.text}${g.error ? `\n  ${g.error}` : ''}`);
  if (!state.goals.length) print('Tell Todd what to build.');
}
async function cleanup() { await service?.close(); await runtime?.close(); }
try {
  if (values.help || command === 'help') { print(HELP); }
  else {
    const app = await client();
    const options = { ...(values.budget ? { budgetUsd: Number(values.budget) } : {}), ...(values.provider ? { providerId: values.provider } : {}) };
    if (command === 'serve') {
      const endpoint = app.session || (service = await createServer({ runtime }));
      if (!values['no-open']) open(`${endpoint.url}/#token=${encodeURIComponent(endpoint.token)}`);
      print('Seagulled is ready. Your conversation opens in the browser. Press Ctrl+C to close this session.');
      if (!runtime) { /* Existing desktop owns its lifetime. */ }
      else await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
    } else if (command === 'status') showState(await app.snapshot());
    else if (command === 'providers') print(await app.discover());
    else if (command === 'connect') {
      const key = values['key-env'] ? process.env[values['key-env']] : undefined;
      if (values['key-env'] && !key) throw new Error('The selected key environment variable is empty.');
      print(await app.connect({ id: args[0], method: values.method || (key ? 'key' : 'subscription'), ...(key ? { key } : {}) }));
    } else if (['pause', 'resume', 'stop'].includes(command)) print(await app.controlGoal(args[0], command));
    else if (['pause-all', 'resume-all', 'stop-all'].includes(command)) showState(await app.controlSwarm(command.split('-')[0]));
    else if (command === 'edit') print(await app.updateGoal(args[0], { ...(values.text ? { text: values.text } : {}), ...(values.budget ? { budgetUsd: Number(values.budget) } : {}) }));
    else if (command === 'goal') {
      const goal = await app.chat(args.join(' '), options); print(`Todd: On it. Goal ${goal.id}.`);
      const stop = async () => { await app.controlGoal(goal.id, 'pause').catch(() => {}); };
      process.once('SIGINT', stop);
      const result = await app.wait(goal.id); process.off('SIGINT', stop);
      if (values.json) print(result); else print(result.result || result.error || `Goal ${result.status}.`);
      if (['failed', 'interrupted'].includes(result.status)) process.exitCode = 1;
    } else if (command === 'chat') {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      print('Todd: What are we building? Type /goals, /pause, /stop or /quit.');
      try {
        while (true) {
          const text = (await rl.question('You: ')).trim();
          if (text === '/quit' || text === '/exit') break;
          if (text === '/goals') { showState(await app.snapshot()); continue; }
          if (text === '/pause' || text === '/stop') { await app.controlSwarm(text.slice(1)); print('Todd: The team got the message.'); continue; }
          if (!text) continue;
          const goal = await app.chat(text, options); print('Todd: I’m putting the team on it.');
          const result = await app.wait(goal.id); print(`Todd: ${result.result || result.error || result.status}`);
        }
      } finally { rl.close(); }
    } else throw new Error(`Unknown command.\n${HELP}`);
  }
} catch (e) { console.error(`Seagulled: ${e.message}`); process.exitCode = 1; }
finally { await cleanup(); }
