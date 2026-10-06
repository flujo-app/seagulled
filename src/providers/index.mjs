import { mkdir, mkdtemp, rm, readdir, lstat, readFile, writeFile, realpath } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, relative, dirname, delimiter, isAbsolute } from 'node:path';
import { runProcess } from './process.mjs';
import { ptyAvailable, runPty } from './pty.mjs';
import { resolveAccountHelpers } from './helpers.mjs';
import { PrivateH100Manager } from './private-h100.mjs';

const NAMES = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity', openai: 'OpenAI API', anthropic: 'Anthropic API', modal: 'Modal inference', 'private-h100': 'Private H100 + Qwen' };
const MAX_PROMPT = 16_000;
const MAX_TEXT = 80_000;
const DEFAULT_MODEL = { openai: 'gpt-6.1-sol', anthropic: 'claude-sonnet-5-5' };
const PRICES_PER_MILLION = { 'gpt-6-luna': [0.1, 0.5], 'gpt-6.1-sol': [2, 10], 'gpt-6-astra': [10, 50], 'claude-sonnet-5-5': [2, 10] };
const METHOD = { codex: ['subscription'], claude: ['subscription'], antigravity: [], openai: ['key'], anthropic: ['key'], modal: ['key'], 'private-h100': [] };
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
  constructor({ dataDir, commandRunner = runProcess, ptyRunner = runPty, ptyCheck = ptyAvailable,
    fetchImpl = fetch, env = process.env, commands = {}, helperRoot, credentialStore } = {}) {
    this.dataDir = dataDir;
    this.commandRunner = commandRunner;
    this.fetch = fetchImpl;
    this.env = env;
    this.authHelpers = resolveAccountHelpers({ helperRoot, env, commands });
    this.commands = { codex: commands.codex ?? 'codex', claude: commands.claude ?? 'claude', antigravity: commands.antigravity ?? 'antigravity',
      fly: this.authHelpers.fly.command, modal: this.authHelpers.modal.command };
    this.modalCommandArgs = this.authHelpers.modal.args;
    this.ptyRunner = ptyRunner;
    this.ptyCheck = ptyCheck;
    this.authBusy = false;
    this.authScope = new Map();
    this.credentialStore = credentialStore;
    this.privateH100 = new PrivateH100Manager({ dataDir, commandRunner, fetchImpl, credentialStore,
      modalCommand: this.commands.modal, modalArgs: this.modalCommandArgs,
      modalEnv: () => this.#authEnv({ id: 'modal', scope: this.authScope.get('modal') ?? 'shared' }) });
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

  #privateAuthPath(id) {
    const root = this.dataDir ?? join(homedir(), '.seagulled');
    return id === 'fly' ? join(root, 'auth', 'fly') : join(root, 'auth', 'modal.toml');
  }

  #sharedFlyConfigDir() {
    const home = process.platform === 'win32' ? this.env.USERPROFILE : this.env.HOME;
    return join(typeof home === 'string' && isAbsolute(home) ? home : homedir(), '.fly');
  }

  #authEnv({ id, scope = 'shared', status = false } = {}) {
    const env = { ...this.env };
    for (const key of Object.keys(env)) if (/^(?:FLY_|MODAL_|BROWSER$)/i.test(key)) delete env[key];
    if (id === 'modal' && this.authHelpers.modal.bundled) {
      let inheritedPath = '';
      for (const key of Object.keys(env)) {
        if (/^PATH$/i.test(key)) { inheritedPath ||= env[key]; delete env[key]; }
        if (/^PYTHON(?:PATH|HOME|STARTUP|INSPECT|USERBASE)$/i.test(key)) delete env[key];
      }
      env.PATH = [this.authHelpers.modal.runtimeDir, inheritedPath].filter(Boolean).join(delimiter);
      env.PYTHONNOUSERSITE = '1';
    }
    if (id === 'fly') env.FLY_CONFIG_DIR = scope === 'private'
      ? this.#privateAuthPath('fly') : this.#sharedFlyConfigDir();
    if (scope === 'private' && id === 'modal') env.MODAL_CONFIG_PATH = this.#privateAuthPath('modal');
    if (status) env.CI = '1';
    else delete env.CI;
    return env;
  }

  async #authProbe(id, args, { signal, timeoutMs = 5000, scope = 'shared' } = {}) {
    if (!this.authHelpers[id].usable) return false;
    try {
      const result = await this.commandRunner(this.commands[id], id === 'modal' ? [...this.modalCommandArgs, ...args] : args,
        { signal, timeoutMs, maxBytes: 16_000,
        env: this.#authEnv({ id, scope, status: true }) });
      return result?.code === 0;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return false;
    }
  }

  async #flyIdentity(scope, signal) {
    try {
      const result = await this.commandRunner(this.commands.fly, ['auth', 'whoami', '--json'],
        { signal, timeoutMs: 7000, maxBytes: 16_000, env: this.#authEnv({ id: 'fly', scope, status: true }) });
      if (result?.code !== 0) return null;
      const email = json(result.stdout)?.email;
      return typeof email === 'string' && email.trim() && !/@tokens\.fly\.io$/i.test(email.trim())
        ? email.trim().toLowerCase() : null;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return null;
    }
  }

  #flyAccountRef(email, scope, flyConfigDir, orgSlug) {
    return `fly-account-sha256:${createHash('sha256').update(JSON.stringify([
      email, scope, resolve(flyConfigDir), orgSlug,
    ])).digest('hex')}`;
  }

  async #authIdentity(id, scope, signal) {
    if (id === 'fly') return Boolean(await this.#flyIdentity(scope, signal));
    try {
      const result = await this.commandRunner(this.commands[id], [...this.modalCommandArgs, 'token', 'info'],
        { signal, timeoutMs: 7000, maxBytes: 16_000, env: this.#authEnv({ id, scope, status: true }) });
      if (result?.code !== 0) return false;
      return !/Service User:/i.test(result.stdout ?? '') && /(?:^|\s)User:/i.test(result.stdout ?? '');
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return false;
    }
  }

  async #accountStatus(id, signal) {
    const installed = await this.#authProbe(id, ['--version'], { signal });
    let privateTerminalAvailable = false;
    if (installed && id === 'fly') {
      try { privateTerminalAvailable = Boolean(await this.ptyCheck()); } catch { /* Leave Fly login unavailable. */ }
    }
    const available = installed && (id === 'modal' || privateTerminalAvailable);
    const privatePath = this.#privateAuthPath(id);
    const hasPrivate = existsSync(id === 'fly' ? join(privatePath, 'config.yml') : privatePath);
    let scope;
    if (installed && hasPrivate && await this.#authIdentity(id, 'private', signal)) scope = 'private';
    else if (installed && await this.#authIdentity(id, 'shared', signal)) scope = 'shared';
    if (scope) this.authScope.set(id, scope);
    else this.authScope.delete(id);
    const connected = Boolean(scope);
    const detail = !installed ? `${id === 'fly' ? 'Fly' : 'Modal'} sign-in helper is unavailable.`
      : connected ? id === 'fly'
        ? 'Fly account sign-in verified. Source, billing, and cloud capacity remain unchecked.'
        : 'Modal account sign-in verified. Inference still needs a separate Proxy Token, endpoint, and usable credits.'
      : !available && id === 'fly' ? 'Fly browser sign-in needs the packaged private terminal helper.'
        : `${id === 'fly' ? 'Fly' : 'Modal'} account sign-in has not been verified.`;
    return { id, installed, connected, available, detail,
      ...(id === 'modal' ? { inferenceConfigured: Boolean(this.connected.get('modal')), inferenceVerified: false } : {}) };
  }

  /** Read-only CLI status, without account names, tokens, or private login links. */
  async authState() {
    const [fly, modal] = await Promise.all([this.#accountStatus('fly'), this.#accountStatus('modal')]);
    return { fly, modal };
  }

  async privateComputeState() {
    const modal = await this.#accountStatus('modal');
    await this.privateH100.restore();
    return this.privateH100.safeState({ accountConnected: modal.connected,
      helperUsable: this.authHelpers.modal.usable && modal.installed && this.authHelpers.modal.bundled });
  }

  async privateComputeEnable({ budgetUsd, signal, workerAllowed = false, admissionId } = {}) {
    const state = await this.privateComputeState();
    return this.privateH100.enable({ budgetUsd, signal, workerAllowed, admissionId, accountConnected: state.available,
      helperUsable: this.authHelpers.modal.bundled && this.authHelpers.modal.usable });
  }

  async privateComputeDisable({ signal, goalId } = {}) {
    const state = await this.privateComputeState();
    return this.privateH100.disable({ signal, goalId, accountConnected: state.available,
      helperUsable: this.authHelpers.modal.bundled && this.authHelpers.modal.usable });
  }

  privateComputeLeaseGoal(goalId) { return this.privateH100.leaseGoal(goalId); }
  privateComputeReleaseGoal(goalId) { return this.privateH100.releaseGoal(goalId); }

  /** Explicit browser sign-in; CLI credentials remain in their own private stores. */
  async authConnect({ id, signal } = {}) {
    if (id !== 'fly' && id !== 'modal') throw new Error('Unknown account sign-in.');
    if (this.authBusy) throw new Error('Another account sign-in is already in progress.');
    if (signal?.aborted) throw cancelled('not_applied');
    this.authBusy = true;
    try {
      const before = await this.#accountStatus(id, signal);
      if (before.connected) return { ...before, reused: true };
      if (!before.available) throw Object.assign(new Error(`${id === 'fly' ? 'Fly' : 'Modal'} browser sign-in is unavailable in this installation.`), { code: 'AUTH_HELPER_UNAVAILABLE' });
      const privatePath = this.#privateAuthPath(id);
      mkdirSync(id === 'fly' ? privatePath : dirname(privatePath), { recursive: true, mode: 0o700 });
      let result;
      try {
        result = await (id === 'fly' ? this.ptyRunner : this.commandRunner)(this.commands[id],
          id === 'fly' ? ['auth', 'login'] : [...this.modalCommandArgs, 'setup'],
          { signal, timeoutMs: 300_000, maxBytes: 64_000, env: this.#authEnv({ id, scope: 'private' }) });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw Object.assign(new Error(`${id === 'fly' ? 'Fly' : 'Modal'} browser sign-in did not complete.`), { code: 'AUTH_INCOMPLETE' });
      }
      if (result?.code !== 0) throw Object.assign(new Error(`${id === 'fly' ? 'Fly' : 'Modal'} browser sign-in did not complete.`), { code: 'AUTH_INCOMPLETE' });
      const after = await this.#accountStatus(id, signal);
      if (!after.connected || this.authScope.get(id) !== 'private') throw Object.assign(new Error(`${id === 'fly' ? 'Fly' : 'Modal'} sign-in could not be verified.`), { code: 'AUTH_UNVERIFIED' });
      return { ...after, reused: false };
    } finally { this.authBusy = false; }
  }

  /** Backend-only account CLI environment; never include this path in public state. */
  authEnvironment(id) {
    if (id !== 'fly' && id !== 'modal') throw new Error('Unknown account sign-in.');
    return this.authScope.get(id) === 'private'
      ? (id === 'fly' ? { FLY_CONFIG_DIR: this.#privateAuthPath(id) } : { MODAL_CONFIG_PATH: this.#privateAuthPath(id) }) : {};
  }

  /** Backend-only verified personal Fly identity and bundled command; no token or public path. */
  async flyAccountLease({ signal } = {}) {
    const unavailable = (detail) => ({ available: false, detail });
    if (signal?.aborted) throw cancelled('not_applied');
    const helper = this.authHelpers.fly;
    if (!helper.bundled || !helper.usable || !isAbsolute(helper.command))
      return unavailable('The packaged Fly helper is unavailable.');
    try { if (!statSync(helper.command).isFile()) return unavailable('The packaged Fly helper is unavailable.'); }
    catch { return unavailable('The packaged Fly helper is unavailable.'); }
    let status;
    try { status = await this.#accountStatus('fly', signal); }
    catch (error) { if (error?.name === 'AbortError') throw error;
      return unavailable('Fly account sign-in could not be verified.'); }
    if (!status.connected) return unavailable('Sign in to a personal Fly account before starting isolated Workers.');
    const scope = this.authScope.get('fly');
    const flyConfigDir = scope === 'private' ? this.#privateAuthPath('fly')
      : scope === 'shared' ? this.#sharedFlyConfigDir() : null;
    if (!flyConfigDir) return unavailable('Fly account sign-in could not be verified.');
    try { if (!statSync(join(flyConfigDir, 'config.yml')).isFile())
      return unavailable('Fly account sign-in could not be verified.'); }
    catch { return unavailable('Fly account sign-in could not be verified.'); }
    const env = this.#authEnv({ id: 'fly', scope, status: true });
    const accountEmail = await this.#flyIdentity(scope, signal);
    if (!accountEmail) return unavailable('Fly account sign-in could not be verified.');
    const organizationUnavailable = () => unavailable('No single personal Fly organization could be verified for isolated Workers.');
    const read = async (args) => {
      if (signal?.aborted) throw cancelled('not_applied');
      const result = await this.commandRunner(helper.command, args,
        { signal, timeoutMs: 10_000, maxBytes: 64_000, env });
      return result?.code === 0 ? json(result.stdout) : null;
    };
    try {
      // This bundled Flyctl version lists slug-to-name JSON; type is available only from show.
      const listed = await read(['orgs', 'list', '--json']);
      if (!listed || Array.isArray(listed) || typeof listed !== 'object') return organizationUnavailable();
      const entries = Object.entries(listed);
      if (entries.length < 1 || entries.length > 12 || entries.some(([slug, name]) =>
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || typeof name !== 'string')) return organizationUnavailable();
      const personal = [];
      for (const [slug] of entries) {
        const details = await read(['orgs', 'show', slug, '--json']);
        if (!details || Array.isArray(details) || details.Slug !== slug
          || !['PERSONAL', 'SHARED'].includes(details.Type)) return organizationUnavailable();
        if (details.Type === 'PERSONAL') personal.push(details);
      }
      if (personal.length !== 1 || !Array.isArray(personal[0].Apps?.Nodes)) return organizationUnavailable();
      if (await this.#flyIdentity(scope, signal) !== accountEmail) {
        return unavailable('Fly account changed while verifying its organization.');
      }
      const accountRef = this.#flyAccountRef(accountEmail, scope, flyConfigDir, personal[0].Slug);
      return { available: true, flyctlPath: helper.command, flyConfigDir, scope,
        orgSlug: personal[0].Slug, accountRef };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return organizationUnavailable();
    }
  }

  /** Backend-only continuation fence. Existing goal apps may now occupy this org. */
  async assertFlyAccountLeaseCurrent(lease, { signal } = {}) {
    if (signal?.aborted) throw cancelled('not_applied');
    const changed = () => unavailable('The selected Fly account or personal organization changed.');
    const helper = this.authHelpers.fly;
    if (!lease || lease.available !== true || !helper.bundled || !helper.usable
      || !isAbsolute(helper.command) || lease.flyctlPath !== helper.command
      || !['private', 'shared'].includes(lease.scope)
      || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(lease.orgSlug ?? '')
      || !/^fly-account-sha256:[a-f0-9]{64}$/.test(lease.accountRef ?? '')) throw changed();
    try { if (!statSync(helper.command).isFile()) throw changed(); }
    catch { throw changed(); }
    const status = await this.#accountStatus('fly', signal);
    if (!status.connected || this.authScope.get('fly') !== lease.scope) throw changed();
    const flyConfigDir = lease.scope === 'private' ? this.#privateAuthPath('fly') : this.#sharedFlyConfigDir();
    if (lease.flyConfigDir !== flyConfigDir) throw changed();
    try { if (!statSync(join(flyConfigDir, 'config.yml')).isFile()) throw changed(); }
    catch { throw changed(); }
    const email = await this.#flyIdentity(lease.scope, signal);
    if (!email || this.#flyAccountRef(email, lease.scope, flyConfigDir, lease.orgSlug) !== lease.accountRef) {
      throw changed();
    }
    const env = this.#authEnv({ id: 'fly', scope: lease.scope, status: true });
    const read = async (args) => {
      if (signal?.aborted) throw cancelled('not_applied');
      const result = await this.commandRunner(helper.command, args,
        { signal, timeoutMs: 10_000, maxBytes: 64_000, env });
      return result?.code === 0 ? json(result.stdout) : null;
    };
    try {
      const listed = await read(['orgs', 'list', '--json']);
      if (!listed || Array.isArray(listed) || typeof listed !== 'object') throw changed();
      const entries = Object.entries(listed);
      if (entries.length < 1 || entries.length > 12 || entries.some(([slug, name]) =>
        !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || typeof name !== 'string')) throw changed();
      const personal = [];
      for (const [slug] of entries) {
        const details = await read(['orgs', 'show', slug, '--json']);
        if (!details || Array.isArray(details) || details.Slug !== slug
          || !['PERSONAL', 'SHARED'].includes(details.Type)) throw changed();
        if (details.Type === 'PERSONAL') personal.push(details);
      }
      if (personal.length !== 1 || personal[0].Slug !== lease.orgSlug
        || !Array.isArray(personal[0].Apps?.Nodes)) throw changed();
      if (await this.#flyIdentity(lease.scope, signal) !== email) throw changed();
      if (signal?.aborted) throw cancelled('not_applied');
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw changed();
    }
  }

  async flyFleetLease(options) { return this.flyAccountLease(options); }

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
    await this.privateH100.restore();
    return this.publicState();
  }

  publicState() {
    return Object.entries(NAMES).map(([id, name]) => {
      if (id === 'private-h100') {
        const state = this.privateH100.safeState({ accountConnected: this.authScope.has('modal'),
          helperUsable: this.authHelpers.modal.usable && this.authHelpers.modal.bundled });
        const route = this.privateH100.fleetRoute();
        return { ...state, name, methods: [], fleetSupported: true, fleetEligible: route.available,
          fleetDetail: route.available ? 'Owned vLLM bearer can be used by isolated workers after disclosure.' : route.detail,
          ...(state.connected ? { models: ['qwen3.8-27b'] } : {}) };
      }
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

  fleetRoute(providerId, goalId) {
    if (providerId === 'private-h100') return this.privateH100.fleetRoute(goalId);
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
    if (id === 'private-h100') throw new Error('Use the private H100 switch and its bounded account flow.');
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
    if (id === 'private-h100') throw new Error('Stop and verify the owned private H100 resources before disconnecting.');
    await this.credentialStore?.delete?.(id);
    this.connected.delete(id);
    this.apiBlocked.delete(id);
    this.explicitlyDisconnected.add(id);
    this.saved[id] = { disabled: true }; this.#save();
    return this.publicState().find((item) => item.id === id);
  }

  async run({ providerId, prompt, signal, onEvent, maxUsd, role, goalId, requestId } = {}) {
    if (!positiveBudget(maxUsd)) throw notApplied('Remaining budget must be positive.');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) throw notApplied('Prompt is empty or too long.');
    if (this.apiBlocked.has(providerId)) throw unavailable(this.apiBlocked.get(providerId));
    const connection = this.connected.get(providerId);
    if (!connection && providerId !== 'private-h100') throw notApplied('Connect this provider first.');
    if (signal?.aborted) throw cancelled('not_applied');
    const fullPrompt = role ? `Role: ${String(role).slice(0, 80)}\n\n${prompt}${role === 'developer' && providerId === 'codex' ? '\n\nFor concrete files, reply as one JSON object: {"response":"brief report","files":[{"path":"relative/name.ext","content":"complete file text"}]}. The host writes those files only inside your owned workspace. Do not claim a file was written until the host receipt confirms it. Do not access credentials or other projects.' : role === 'reviewer' && providerId === 'codex' ? '\n\nInspect the files in the current owned workspace when reviewing artifact claims.' : ''}` : prompt;
    onEvent?.({ type: 'status', text: `Running ${NAMES[providerId]}` });
    const result = providerId === 'private-h100'
      ? await this.privateH100.run({ prompt: fullPrompt, signal, maxUsd, goalId, requestId })
      : connection.method === 'subscription'
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
        const result = await this.commandRunner(this.commands.codex, args, { cwd, input: prompt, signal,
          timeoutMs: 120_000, maxBytes: 256_000, env, killTree: true });
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
      const result = await this.commandRunner(this.commands.claude, args, { cwd, input: prompt, signal,
        timeoutMs: 120_000, maxBytes: 256_000, env: this.env, killTree: true });
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
