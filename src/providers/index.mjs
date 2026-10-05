import { mkdir, mkdtemp, rm, readdir, lstat, readFile, writeFile, realpath } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { runProcess } from './process.mjs';

const NAMES = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity', openai: 'OpenAI API', anthropic: 'Anthropic API', modal: 'Modal inference' };
const MAX_PROMPT = 16_000;
const MAX_TEXT = 80_000;
const DEFAULT_MODEL = { openai: 'gpt-6.1-sol', anthropic: 'claude-sonnet-5-5' };
const PRICES_PER_MILLION = { 'gpt-6-luna': [0.1, 0.5], 'gpt-6.1-sol': [2, 10], 'gpt-6-astra': [10, 50], 'claude-sonnet-5-5': [2, 10] };
const METHOD = { codex: ['subscription'], claude: ['subscription'], antigravity: [], openai: ['key'], anthropic: ['key'], modal: ['key'] };
const FLEET_MODEL = {
  openai: { baseUrl: 'https://api.openai.com/v1', provider: 'openai', adapter: 'openai-responses' },
  anthropic: { baseUrl: 'https://api.anthropic.com', provider: 'anthropic', adapter: 'anthropic' },
};
const json = (text) => { try { return JSON.parse(text); } catch { return null; } };
const safeText = (value) => String(value ?? '').slice(0, MAX_TEXT);
const validModel = (value) => typeof value === 'string' && /^[\w./:-]{1,160}$/.test(value);
const positiveBudget = (value) => value === undefined || (Number.isFinite(value) && value > 0);
const notApplied = (message) => Object.assign(new Error(message), { outcome: 'not_applied' });
const unavailable = (message) => Object.assign(notApplied(message), { code: 'PROVIDER_UNAVAILABLE' });
const quotaDenied = (body) => {
  const error = body?.error;
  if (!error || typeof error !== 'object') return false;
  return error.code === 'insufficient_quota' || error.type === 'insufficient_quota'
    || typeof error.message === 'string' && /\bno credits remaining\b/i.test(error.message);
};
const cancelled = (outcome) => Object.assign(new Error('Cancelled'), { name: 'AbortError', outcome, ...(outcome === 'unknown' ? { code: 'UNKNOWN', unknown: true } : {}) });
const markUnknown = (error) => {
  if (error && typeof error === 'object' && error.outcome !== 'not_applied') {
    error.outcome = 'unknown'; error.code = 'UNKNOWN'; error.unknown = true;
  }
  return error;
};
async function artifactManifest(root) {
  const artifacts = [];
  let directories = 0, totalBytes = 0;
  const visit = async (directory) => {
    if (++directories > 200) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (artifacts.length < 100 && directories < 200 && totalBytes < 20_000_000) await visit(path); continue; }
      if (!entry.isFile() || artifacts.length >= 100 || totalBytes >= 20_000_000) continue;
      const stat = await lstat(path);
      if (!stat.isFile() || totalBytes + stat.size > 20_000_000) continue;
      const data = await readFile(path);
      totalBytes += data.length;
      artifacts.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
  };
  await visit(root);
  return artifacts;
}
async function materializeFiles(root, value) {
  const files = Array.isArray(value?.files) ? value.files : [];
  if (files.length > 20) throw new Error('Provider proposed too many artifact files.');
  let totalBytes = 0;
  for (const file of files) {
    if (typeof file?.path !== 'string' || !/^[a-zA-Z0-9._/-]{1,160}$/.test(file.path)
      || file.path.split('/').some((part) => !part || part === '..' || part === '.')) throw new Error('Provider proposed an unsafe artifact path.');
    if (typeof file.content !== 'string') throw new Error('Provider proposed invalid artifact content.');
    const destination = resolve(root, file.path);
    const rel = relative(root, destination);
    if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('Provider proposed an artifact outside its workspace.');
    totalBytes += Buffer.byteLength(file.content);
    if (totalBytes > 80_000) throw new Error('Provider artifacts exceeded the output limit.');
    const parts = rel.split(/[\\/]/);
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      cursor = join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Artifact path crosses a link.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(cursor, { mode: 0o700 }); }
    }
    try { if ((await lstat(destination)).isSymbolicLink()) throw new Error('Artifact path is a link.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.content, { mode: 0o600 });
  }
  return files.length;
}

export class ProviderManager {
  constructor({ dataDir, commandRunner = runProcess, fetchImpl = fetch, env = process.env, commands = {}, credentialStore } = {}) {
    this.dataDir = dataDir;
    this.commandRunner = commandRunner;
    this.fetch = fetchImpl;
    this.env = env;
    this.commands = { codex: commands.codex ?? 'codex', claude: commands.claude ?? 'claude', antigravity: commands.antigravity ?? 'antigravity' };
    this.credentialStore = credentialStore;
    this.connected = new Map();
    this.detected = new Map();
    this.apiBlocked = new Map();
    this.explicitlyDisconnected = new Set();
    this.saved = {};
    if (dataDir) {
      try { this.saved = JSON.parse(readFileSync(join(dataDir, 'connections.json'), 'utf8')); } catch { this.saved = {}; }
    }
    for (const [id, config] of Object.entries(this.saved)) if (config?.disabled) this.explicitlyDisconnected.add(id);
    for (const [id, config] of Object.entries(this.saved)) if (config?.blocked && ['openai', 'anthropic', 'modal'].includes(id)) this.apiBlocked.set(id, config.blocked);
  }

  #save() {
    if (!this.dataDir) return;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const path = join(this.dataDir, 'connections.json');
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600 });
    renameSync(temp, path);
  }

  async #probe(command, args, timeoutMs = 4000) {
    try { return await this.commandRunner(command, args, { timeoutMs, maxBytes: 8_000, env: this.env }); }
    catch { return null; }
  }

  async discover() {
    const [codex, codexAuth, claude, claudeAuth, antigravity] = await Promise.all([
      this.#probe(this.commands.codex, ['--version']),
      this.#probe(this.commands.codex, ['login', 'status']),
      this.#probe(this.commands.claude, ['--version']),
      this.#probe(this.commands.claude, ['auth', 'status']),
      this.#probe(this.commands.antigravity, ['--version']),
    ]);
    this.detected.set('codex', { installed: codex?.code === 0, loggedIn: codexAuth?.code === 0 });
    const auth = json(claudeAuth?.stdout);
    this.detected.set('claude', { installed: claude?.code === 0, loggedIn: claudeAuth?.code === 0 && auth?.loggedIn === true, blocked: this.detected.get('claude')?.blocked ?? false });
    this.detected.set('antigravity', { installed: antigravity?.code === 0, loggedIn: false });
    for (const id of ['codex', 'claude']) {
      if (this.detected.get(id)?.loggedIn && !this.detected.get(id)?.blocked && !this.explicitlyDisconnected.has(id) && !this.connected.has(id)) {
        this.connected.set(id, { method: 'subscription', model: this.saved[id]?.model });
      }
    }
    for (const [id, envKey] of [['openai', this.env.OPENAI_API_KEY], ['anthropic', this.env.ANTHROPIC_API_KEY], ['modal', this.env.MODAL_PROXY_TOKEN]]) {
      if (envKey && !this.explicitlyDisconnected.has(id) && !this.apiBlocked.has(id) && !this.connected.has(id) && (id !== 'modal' || this.saved[id]?.model)) {
        this.connected.set(id, { method: 'key', key: envKey, model: this.saved[id]?.model ?? DEFAULT_MODEL[id], fleetAllowed: this.saved[id]?.method === 'key' && this.saved[id]?.fleetAllowed === true });
      }
    }
    if (this.credentialStore) {
      for (const id of ['openai', 'anthropic', 'modal']) {
        if (this.saved[id]?.method === 'key' && !this.connected.has(id) && !this.explicitlyDisconnected.has(id) && !this.apiBlocked.has(id)) {
          try {
            const key = await this.credentialStore.get?.(id);
            if (key && (id !== 'modal' || this.saved[id]?.model)) this.connected.set(id, { method: 'key', key, model: this.saved[id].model ?? DEFAULT_MODEL[id], fleetAllowed: this.saved[id]?.fleetAllowed === true });
          } catch { /* Secure storage unavailable: leave disconnected and ask for a fresh key. */ }
        }
      }
    }
    return this.publicState();
  }

  publicState() {
    return Object.entries(NAMES).map(([id, name]) => {
      const detected = this.detected.get(id);
      const connection = this.connected.get(id);
      const apiBlocked = this.apiBlocked.get(id);
      const keyAvailable = id === 'openai' ? Boolean(this.env.OPENAI_API_KEY) : id === 'anthropic' ? Boolean(this.env.ANTHROPIC_API_KEY) : id === 'modal' ? Boolean(this.env.MODAL_PROXY_TOKEN) : false;
      let detail;
      if (id === 'antigravity') detail = detected?.installed ? 'CLI found; unattended execution is unsupported.' : 'CLI not found; unattended execution is unsupported.';
      else if (id === 'codex' || id === 'claude') detail = detected?.blocked ? 'Native sign-in exists, but subscription execution was denied. Use an API key or update native access.' : detected?.loggedIn ? 'Native sign-in found; execution is verified on first run. Subscription usage is separate from API billing.' : detected?.installed ? 'Sign in through the native app or CLI first.' : 'CLI not installed.';
      else if (apiBlocked) detail = apiBlocked;
      else if (id === 'modal') detail = 'Requires a Modal inference Proxy Token and an available endpoint model. Modal account tokens are not inference tokens.';
      else detail = 'Requires an API key; API billing is separate from CLI subscriptions.';
      const fleet = this.fleetRoute(id);
      return { id, name, available: (id === 'codex' || id === 'claude') ? Boolean(detected?.installed && detected?.loggedIn && !detected?.blocked) : id === 'antigravity' ? false : !apiBlocked && Boolean(connection || keyAvailable), connected: Boolean(connection), methods: METHOD[id], detail, fleetSupported: Object.hasOwn(FLEET_MODEL, id), fleetEligible: fleet.available, fleetDetail: fleet.available ? 'Worker credential transfer authorized; FLUJO inference remains unverified.' : fleet.detail, ...(connection?.model ? { models: [connection.model] } : {}) };
    });
  }

  fleetRoute(providerId) {
    if (!Object.hasOwn(NAMES, providerId)) return { available: false, detail: 'Unknown provider.' };
    if (this.apiBlocked.has(providerId)) return { available: false, detail: this.apiBlocked.get(providerId) };
    if (providerId === 'codex' || providerId === 'claude') return { available: false, detail: 'Native subscription credentials are not qualified for isolated FLUJO workers.' };
    if (providerId === 'antigravity') return { available: false, detail: 'Unattended Antigravity execution is unsupported.' };
    if (providerId === 'modal') return { available: false, detail: 'Modal inference is available locally, but its FLUJO worker adapter is unqualified.' };
    const connection = this.connected.get(providerId);
    if (!connection || this.explicitlyDisconnected.has(providerId)) return { available: false, detail: 'Connect this API provider before using isolated workers.' };
    if (connection.method !== 'key' || !connection.key || !validModel(connection.model)) return { available: false, detail: 'This API connection cannot be used by isolated workers.' };
    if (connection.fleetAllowed !== true) return { available: false, detail: 'Connect again and allow this key for isolated FLUJO workers.' };
    return {
      available: true,
      providerId,
      model: { name: connection.model, ...FLEET_MODEL[providerId], apiKey: connection.key },
      verification: 'unverified',
      costPolicy: 'pending',
    };
  }

  async connect({ id, method, key, model, fleetAllowed = false } = {}) {
    if (!Object.hasOwn(NAMES, id)) throw new Error('Unknown provider.');
    if (method === 'oauth' || method === 'login') throw new Error('Use the provider’s native sign-in. This app does not handle OAuth tokens.');
    if (!METHOD[id].includes(method)) throw new Error(`${NAMES[id]} does not support that connection method here.`);
    if (model !== undefined && !validModel(model)) throw new Error('Invalid model name.');
    if (typeof fleetAllowed !== 'boolean') throw new Error('Worker credential consent must be a boolean.');
    if (fleetAllowed && !Object.hasOwn(FLEET_MODEL, id)) throw new Error(`${NAMES[id]} is not qualified for isolated FLUJO workers.`);
    if (method === 'subscription') {
      await this.discover();
      if (!this.detected.get(id)?.installed) throw new Error(`${NAMES[id]} CLI is not installed.`);
      if (!this.detected.get(id)?.loggedIn) {
        const args = id === 'codex' ? ['login'] : ['auth', 'login', '--claudeai'];
        const login = await this.#probe(this.commands[id], args, 90_000);
        await this.discover();
        if (login?.code !== 0 || !this.detected.get(id)?.loggedIn) throw new Error(`${NAMES[id]} sign-in was not completed. Try Connect again after finishing the provider browser sign-in.`);
      }
      this.explicitlyDisconnected.delete(id);
      this.connected.set(id, { method, model });
      this.saved[id] = { method, model }; this.#save();
      return this.publicState().find((item) => item.id === id);
    }
    const supplied = typeof key === 'string' ? key.trim() : '';
    if (this.apiBlocked.has(id) && !supplied) throw new Error(`${NAMES[id]} was blocked. Reconnect with a key after resolving the provider denial.`);
    const existing = this.connected.get(id);
    if (fleetAllowed && !supplied && (!existing || this.explicitlyDisconnected.has(id))) throw new Error('Connect this API provider before allowing its key in isolated workers.');
    const envKey = id === 'openai' ? this.env.OPENAI_API_KEY : id === 'anthropic' ? this.env.ANTHROPIC_API_KEY : this.env.MODAL_PROXY_TOKEN;
    const secret = supplied || existing?.key || envKey;
    if (!secret || secret.length > 500) throw new Error(`${NAMES[id]} needs a valid key.`);
    if (id === 'modal' && !/^wk-[^.\s]+\.ws-[^\s]+$/.test(secret)) throw new Error('Modal inference requires a combined Proxy Token.');
    let selectedModel = model ?? existing?.model ?? this.saved[id]?.model ?? DEFAULT_MODEL[id];
    if (id === 'modal' && !selectedModel) {
      const response = await this.fetch('https://inference.us-west.modal.direct/v1/models', { headers: { authorization: `Bearer ${secret}` }, redirect: 'error' });
      if (!response.ok) throw new Error('Modal could not list inference models. Check the Proxy Token.');
      const catalogue = await response.json();
      selectedModel = catalogue?.data?.find((item) => validModel(item.id))?.id;
      if (!selectedModel) throw new Error('This Modal Proxy Token has no available inference models.');
    }
    if (supplied && this.credentialStore) await this.credentialStore.set(id, secret);
    this.connected.set(id, { method, key: secret, model: selectedModel, fleetAllowed });
    this.apiBlocked.delete(id);
    this.explicitlyDisconnected.delete(id);
    this.saved[id] = { method, model: selectedModel, fleetAllowed }; this.#save();
    return this.publicState().find((item) => item.id === id);
  }

  async disconnect(id) {
    if (!Object.hasOwn(NAMES, id)) throw new Error('Unknown provider.');
    await this.credentialStore?.delete?.(id);
    this.connected.delete(id);
    this.apiBlocked.delete(id);
    this.explicitlyDisconnected.add(id);
    this.saved[id] = { disabled: true }; this.#save();
    return this.publicState().find((item) => item.id === id);
  }

  async run({ providerId, prompt, signal, onEvent, maxUsd, role, goalId } = {}) {
    if (!positiveBudget(maxUsd)) throw notApplied('Remaining budget must be positive.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) throw notApplied('Prompt is empty or too long.');
    if (this.apiBlocked.has(providerId)) throw unavailable(this.apiBlocked.get(providerId));
    const connection = this.connected.get(providerId);
    if (!connection) throw notApplied('Connect this provider first.');
    if (signal?.aborted) throw cancelled('not_applied');
    const fullPrompt = role ? `Role: ${String(role).slice(0, 80)}\n\n${prompt}${role === 'developer' && providerId === 'codex' ? '\n\nFor concrete files, reply as one JSON object: {"response":"brief report","files":[{"path":"relative/name.ext","content":"complete file text"}]}. The host writes those files only inside your owned workspace. Do not claim a file was written until the host receipt confirms it. Do not access credentials or other projects.' : role === 'reviewer' && providerId === 'codex' ? '\n\nInspect the files in the current owned workspace when reviewing artifact claims.' : ''}` : prompt;
    onEvent?.({ type: 'status', text: `Running ${NAMES[providerId]}` });
    const result = connection.method === 'subscription'
      ? await this.#runCli(providerId, connection, fullPrompt, { signal, maxUsd, goalId, role })
      : await this.#runApi(providerId, connection, fullPrompt, { signal, maxUsd });
    onEvent?.({ type: 'message', text: result.text });
    onEvent?.({ type: 'usage', usage: result.usage });
    return { ...result, providerId };
  }

  async #runCli(id, connection, prompt, { signal, maxUsd, goalId, role }) {
    const base = this.dataDir ?? tmpdir();
    await mkdir(base, { recursive: true, mode: 0o700 });
    const ownedWorkspace = id === 'codex' && typeof goalId === 'string' && /^[\w-]{1,100}$/.test(goalId);
    const cwd = ownedWorkspace ? join(base, 'workspaces', goalId) : await mkdtemp(join(base, 'seagulled-provider-'));
    if (ownedWorkspace) {
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const root = await realpath(base), actual = await realpath(cwd);
      const inside = relative(root, actual);
      if (!inside || inside.startsWith('..') || inside.includes(':') || (await lstat(cwd)).isSymbolicLink()) throw notApplied('Owned workspace path is unsafe.');
    }
    try {
      if (id === 'codex') {
        const writable = ownedWorkspace && role === 'developer';
        const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'shell_environment_policy.ignore_default_excludes=false'];
        if (ownedWorkspace) args.push('-C', cwd);
        if (connection.model) args.push('--model', connection.model);
        args.push('-');
        const env = { ...this.env };
        for (const key of Object.keys(env)) {
          if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key) && key !== 'CODEX_HOME') delete env[key];
          if (/^CODEX_(?:PERMISSION_PROFILE|TASK_WORKSPACE_VERIFYING_IDENTITY|THREAD_ID|SESSION_ID|CI|INTERNAL_ORIGINATOR_OVERRIDE)$/i.test(key)) delete env[key];
        }
        const result = await this.commandRunner(this.commands.codex, args, { cwd, input: prompt, signal, timeoutMs: 120_000, maxBytes: 256_000, env });
        if (result.code !== 0) throw new Error('Codex could not complete the request. Check native sign-in and model access.');
        const events = result.stdout.split(/\r?\n/).map(json).filter(Boolean);
        let text = safeText(events.filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message').map((event) => event.item.text).join('\n'));
        if (!text) throw new Error('Codex returned no final response.');
        if (writable) {
          const parsed = json(text) ?? json(text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]);
          if (parsed?.files) {
            const count = await materializeFiles(cwd, parsed);
            text = safeText(`${parsed.response ?? 'Developer artifacts prepared.'}\nHost saved ${count} artifact file${count === 1 ? '' : 's'} in the owned workspace.`);
          }
        }
        const token = events.findLast((event) => event.type === 'turn.completed')?.usage ?? {};
        return { text, usage: { inputTokens: token.input_tokens ?? null, outputTokens: token.output_tokens ?? null, costUsd: 0, costKind: 'subscription' }, ...(ownedWorkspace ? { workspace: cwd, artifacts: await artifactManifest(cwd) } : {}) };
      }
      const args = ['-p', '-', '--output-format', 'json', '--no-session-persistence', '--restricted', '--permission-mode', 'plan', '--max-turns', '1'];
      if (Number.isFinite(maxUsd)) args.push('--max-budget-usd', String(Math.min(maxUsd, 100)));
      if (connection.model) args.push('--model', connection.model);
      const result = await this.commandRunner(this.commands.claude, args, { cwd, input: prompt, signal, timeoutMs: 120_000, maxBytes: 256_000, env: this.env });
      const body = json(result.stdout);
      if (result.code !== 0 || body?.is_error) {
        if (/disabled.*subscription access|subscription access.*disabled/i.test(String(body?.result ?? ''))) this.detected.set('claude', { ...this.detected.get('claude'), blocked: true });
        throw new Error('Claude could not complete the request. Check native subscription access or use an API key.');
      }
      const text = safeText(body?.result);
      if (!text) throw new Error('Claude returned no successful response.');
      this.detected.set('claude', { ...this.detected.get('claude'), blocked: false });
      return { text, usage: { inputTokens: body?.usage?.input_tokens ?? null, outputTokens: body?.usage?.output_tokens ?? null, costUsd: 0, costKind: 'subscription' } };
    } catch (error) {
      throw markUnknown(error);
    } finally { if (!ownedWorkspace) await rm(cwd, { recursive: true, force: true }).catch(() => {}); }
  }

  async #runApi(id, connection, prompt, { signal, maxUsd }) {
    const prices = PRICES_PER_MILLION[connection.model];
    if (!prices && id !== 'modal' && Number.isFinite(maxUsd)) throw notApplied('This model has no verified price for budget enforcement. Choose a supported priced model.');
    // Prompt characters are a conservative token reserve for ordinary text. Provider
    // invoices remain authoritative; this estimate is never presented as billed spend.
    const inputReserve = Buffer.byteLength(prompt, 'utf8') + 200;
    const envelope = prices ?? [20, 100];
    const remaining = Number.isFinite(maxUsd) ? maxUsd - inputReserve * envelope[0] / 1_000_000 : Infinity;
    const outputTokens = Math.min(1024, Number.isFinite(remaining) ? Math.floor(remaining * 1_000_000 / envelope[1]) : 1024);
    if (outputTokens < 64) throw notApplied('Remaining budget is too small for a bounded provider request. Increase it to continue.');
    const headers = { 'content-type': 'application/json' };
    let url, body;
    if (id === 'anthropic') {
      url = 'https://api.anthropic.com/v1/messages';
      headers['x-api-key'] = connection.key;
      headers['anthropic-version'] = '2023-06-01';
      body = { model: connection.model, max_tokens: outputTokens, messages: [{ role: 'user', content: prompt }] };
    } else {
      url = id === 'modal' ? 'https://inference.us-west.modal.direct/v1/chat/completions' : 'https://api.openai.com/v1/responses';
      headers.authorization = `Bearer ${connection.key}`;
      body = id === 'modal' ? { model: connection.model, max_tokens: outputTokens, messages: [{ role: 'user', content: prompt }] } : { model: connection.model, max_output_tokens: outputTokens, input: prompt };
    }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Provider timed out.')), 120_000);
    try {
      const response = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      if (response.status === 401 || response.status === 403) {
        const reason = `${NAMES[id]} rejected authentication. Reconnect with a valid key or choose another provider.`;
        this.#blockApi(id, connection, reason);
        throw unavailable(reason);
      }
      const raw = await response.text();
      if (raw.length > 256_000) throw new Error('Provider response exceeded the safety limit.');
      const result = json(raw);
      if (response.status === 429 && quotaDenied(result)) {
        const reason = `${NAMES[id]} has no remaining inference credits. Add credits or choose another provider, then reconnect.`;
        this.#blockApi(id, connection, reason);
        throw unavailable(reason);
      }
      if (!response.ok) throw new Error(`${NAMES[id]} request failed (HTTP ${response.status}). Check the key and model.`);
      let text;
      if (id === 'anthropic') text = result?.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
      else if (id === 'modal') text = result?.choices?.[0]?.message?.content;
      else text = result?.output_text ?? result?.output?.flatMap((item) => item.content ?? []).filter((item) => item.type === 'output_text').map((item) => item.text).join('\n');
      text = safeText(text);
      if (!text) throw new Error(`${NAMES[id]} returned no text.`);
      const usage = result?.usage ?? {};
      const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? null;
      const outputTokensUsed = usage.output_tokens ?? usage.completion_tokens ?? null;
      const estimatedCost = prices && Number.isFinite(inputTokens) && Number.isFinite(outputTokensUsed)
        ? (inputTokens * prices[0] + outputTokensUsed * prices[1]) / 1_000_000 : null;
      return { text, usage: { inputTokens, outputTokens: outputTokensUsed, costUsd: estimatedCost, costKind: estimatedCost === null ? 'unknown' : 'estimated' } };
    } catch (error) {
      if (error?.outcome === 'not_applied') throw error;
      if (controller.signal.aborted) throw cancelled('unknown');
      throw markUnknown(error);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  #blockApi(id, connection, reason) {
    this.apiBlocked.set(id, reason);
    this.connected.delete(id);
    this.saved[id] = { method: connection.method, model: connection.model, blocked: reason };
    try { this.#save(); } catch { /* In-memory block still prevents an automatic retry this session. */ }
  }
}

export async function discoverProviders(options = {}) { return new ProviderManager(options).discover(); }
