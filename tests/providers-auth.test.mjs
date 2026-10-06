import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderManager } from '../src/providers/index.mjs';
import { resolveAccountHelpers } from '../src/providers/helpers.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = ({ fly = false, modal = false, calls = [] } = {}) => async (command, args, options) => {
  calls.push({ command, args, env: options.env });
  const joined = args.join(' ');
  if (joined === '--version') return { code: 0, stdout: 'fixture-version' };
  if (command === 'flyctl' && joined === 'auth whoami --json') return { code: fly ? 0 : 1, stdout: '{"email":"private@example.com","token":"hidden"}' };
  if (command === 'modal' && joined === 'token info') return { code: modal ? 0 : 1, stdout: 'Token: secret\nWorkspace: private\nUser: person' };
  if (command === 'modal' && joined === 'setup') return { code: 0, stdout: 'https://modal.com/private-session?token=secret' };
  throw new Error('Unexpected fixture command');
};

test('account state is read-only, bounded, and separate from inference', async () => {
  const calls = [];
  const manager = new ProviderManager({ commandRunner: fixture({ fly: true, modal: true, calls }),
    ptyCheck: async () => true, env: { PATH: 'fixture', FLY_API_TOKEN: 'fly-service-secret', FLY_ACCESS_TOKEN: 'fly-other-secret',
      MODAL_TOKEN_ID: 'modal-service-id', MODAL_TOKEN_SECRET: 'modal-service-secret', MODAL_SERVER_URL: 'https://alternate.invalid',
      BROWSER: 'untrusted-browser' } });
  const state = await manager.authState();
  assert.equal(state.fly.connected, true);
  assert.equal(state.modal.connected, true);
  assert.equal(state.modal.inferenceConfigured, false);
  assert.equal(state.modal.inferenceVerified, false);
  assert.doesNotMatch(JSON.stringify(state), /secret|private@example|alternate.invalid|private-session/);
  assert.equal(calls.some((call) => call.args.includes('login') || call.args.includes('setup')), false);
  assert.ok(calls.every((call) => call.env.CI === '1' && call.env.FLY_API_TOKEN === undefined
    && call.env.FLY_ACCESS_TOKEN === undefined && call.env.MODAL_TOKEN_ID === undefined
    && call.env.MODAL_TOKEN_SECRET === undefined && call.env.MODAL_SERVER_URL === undefined
    && call.env.BROWSER === undefined));
});

test('guided Fly sign-in reuses verified local auth without opening a second browser', async () => {
  const calls = [];
  const manager = new ProviderManager({ commandRunner: fixture({ fly: true, calls }), ptyCheck: async () => false, env: {} });
  const result = await manager.authConnect({ id: 'fly' });
  assert.equal(result.connected, true);
  assert.equal(result.reused, true);
  assert.equal(calls.some((call) => call.args.includes('login')), false);
});

test('guided Fly login uses a private PTY and verifies sign-in after the browser flow', async () => {
  const calls = [];
  let signedIn = false;
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-auth-test-'));
  const manager = new ProviderManager({ dataDir, env: { FLY_API_TOKEN: 'service-secret', BROWSER: 'bad-browser' },
    ptyCheck: async () => true,
    ptyRunner: async (command, args, options) => {
      calls.push({ command, args, env: options.env, kind: 'pty' });
      writeFileSync(join(options.env.FLY_CONFIG_DIR, 'config.yml'), 'fixture-private-config');
      signedIn = true;
      return { code: 0, stdout: 'https://fly.io/app/auth/cli/private-session' };
    },
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, env: options.env, kind: 'status' });
      return { code: args.join(' ') === 'auth whoami --json' && !signedIn ? 1 : 0,
        stdout: '{"email":"private@example.com"}' };
    } });
  try {
    const result = await manager.authConnect({ id: 'fly' });
    assert.equal(result.connected, true);
    assert.equal(result.reused, false);
    assert.deepEqual(calls.filter((call) => call.kind === 'pty').map((call) => call.args), [['auth', 'login']]);
    assert.equal(calls.find((call) => call.kind === 'pty').env.FLY_API_TOKEN, undefined);
    assert.equal(calls.find((call) => call.kind === 'pty').env.BROWSER, undefined);
    assert.equal(manager.authEnvironment('fly').FLY_CONFIG_DIR, join(dataDir, 'auth', 'fly'));
    assert.doesNotMatch(JSON.stringify(result), /private-session|private@example|service-secret/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('Modal browser setup proves account auth only, with no inferred endpoint or credits', async () => {
  const calls = [];
  let signedIn = false;
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-auth-test-'));
  const manager = new ProviderManager({ dataDir, env: { MODAL_TOKEN_ID: 'service-id', MODAL_TOKEN_SECRET: 'service-secret' },
    commandRunner: async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (args.join(' ') === 'token info') return { code: signedIn ? 0 : 1, stdout: 'Token: secret\nUser: person' };
      if (args.join(' ') === 'setup') {
        writeFileSync(options.env.MODAL_CONFIG_PATH, 'fixture-private-config');
        signedIn = true;
        return { code: 0, stdout: 'https://modal.com/private-flow' };
      }
      return { code: 0, stdout: 'fixture-version' };
    } });
  try {
    const result = await manager.authConnect({ id: 'modal' });
    assert.equal(result.connected, true);
    assert.equal(result.inferenceConfigured, false);
    assert.equal(result.inferenceVerified, false);
    assert.deepEqual(calls.filter((call) => call.args[0] === 'setup').map((call) => call.args), [['setup']]);
    assert.equal(calls.find((call) => call.args[0] === 'setup').env.MODAL_TOKEN_ID, undefined);
    assert.equal(calls.find((call) => call.args[0] === 'setup').env.MODAL_TOKEN_SECRET, undefined);
    assert.equal(manager.authEnvironment('modal').MODAL_CONFIG_PATH, join(dataDir, 'auth', 'modal.toml'));
    assert.doesNotMatch(JSON.stringify(result), /private-flow|service-secret/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('Fly cannot claim browser login without a PTY; cancellation is preserved', async () => {
  const calls = [];
  const manager = new ProviderManager({ commandRunner: fixture({ calls }), ptyCheck: async () => false, env: {} });
  await assert.rejects(manager.authConnect({ id: 'fly' }), (error) => error.code === 'AUTH_HELPER_UNAVAILABLE');
  assert.equal(calls.some((call) => call.args.includes('login')), false);
  await assert.rejects(manager.authConnect({ id: 'other' }), /Unknown account/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(manager.authConnect({ id: 'modal', signal: controller.signal }),
    (error) => error.name === 'AbortError' && error.outcome === 'not_applied');
});

test('service identities cannot satisfy guided personal sign-in', async () => {
  const manager = new ProviderManager({ ptyCheck: async () => true, env: {}, commandRunner: async (command, args) => {
    if (args.join(' ') === '--version') return { code: 0, stdout: 'fixture-version' };
    if (command === 'flyctl') return { code: 0, stdout: '{"email":"worker@tokens.fly.io"}' };
    return { code: 0, stdout: 'Service User: worker' };
  } });
  const state = await manager.authState();
  assert.equal(state.fly.connected, false);
  assert.equal(state.modal.connected, false);
  assert.deepEqual(manager.authEnvironment('fly'), {});
  assert.deepEqual(manager.authEnvironment('modal'), {});
});

test('packaged Modal Python can be invoked as a module with a fixed command prefix', async () => {
  const calls = [];
  const manager = new ProviderManager({ commands: { modal: 'bundled-python.exe', modalArgs: ['-m', 'modal'] },
    env: {}, ptyCheck: async () => true, commandRunner: async (command, args) => {
      calls.push({ command, args });
      return { code: args.slice(-2).join(' ') === 'token info' ? 1 : 0, stdout: '' };
    } });
  const state = await manager.authState();
  assert.equal(state.modal.available, true);
  assert.deepEqual(calls.filter((call) => call.command === 'bundled-python.exe').map((call) => call.args),
    [['-m', 'modal', '--version'], ['-m', 'modal', 'token', 'info']]);
});

test('a browser flow must verify the product-private account store', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seagulled-auth-test-'));
  let sharedConnected = false;
  const manager = new ProviderManager({ dataDir, env: {}, commandRunner: async (command, args, options) => {
    if (args.join(' ') === '--version') return { code: 0, stdout: 'fixture-version' };
    if (args.join(' ') === 'token info') return { code: options.env.MODAL_CONFIG_PATH || !sharedConnected ? 1 : 0,
      stdout: 'User: person' };
    if (args.join(' ') === 'setup') { sharedConnected = true; return { code: 0, stdout: '' }; }
    throw new Error('Unexpected fixture command');
  } });
  try {
    await assert.rejects(manager.authConnect({ id: 'modal' }), (error) => error.code === 'AUTH_UNVERIFIED');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('complete packaged helpers use fixed absolute commands and isolated Modal Python', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seagulled-helpers-test-'));
  const fly = join(root, 'fly', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
  const python = join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'python');
  const module = join(root, 'python', 'Lib', 'site-packages', 'modal', '__main__.py');
  for (const file of [fly, python, module]) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, 'fixture');
  }
  const calls = [];
  try {
    const helpers = resolveAccountHelpers({ helperRoot: root, env: { PATH: 'host-path' } });
    assert.equal(helpers.fly.usable, true);
    assert.equal(helpers.modal.usable, true);
    assert.deepEqual(helpers.modal.args, ['-B', '-m', 'modal']);
    const manager = new ProviderManager({ helperRoot: root, env: { PATH: 'host-path', PYTHONPATH: 'untrusted-path',
      MODAL_TOKEN_ID: 'service-token' }, ptyCheck: async () => true, commandRunner: async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return { code: args.at(-1) === '--version' ? 0 : 1, stdout: '' };
    } });
    const state = await manager.authState();
    assert.equal(state.fly.available, true);
    assert.equal(state.modal.available, true);
    assert.deepEqual(calls.map(call => [call.command, call.args]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      [[fly, ['--version']], [python, ['-B', '-m', 'modal', '--version']],
        [fly, ['auth', 'whoami', '--json']], [python, ['-B', '-m', 'modal', 'token', 'info']]]
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    const modalEnv = calls.find(call => call.command === python).env;
    assert.equal(modalEnv.PYTHONPATH, undefined);
    assert.equal(modalEnv.MODAL_TOKEN_ID, undefined);
    assert.equal(modalEnv.PYTHONNOUSERSITE, '1');
    assert.ok(modalEnv.PATH.startsWith(join(root, 'python')));
    assert.doesNotMatch(JSON.stringify(state), /seagulled-helpers-test|host-path|service-token/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('incomplete packaged helpers never fall back to host commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seagulled-helpers-test-'));
  const calls = [];
  try {
    const manager = new ProviderManager({ env: { PATH: 'host-path', SEAGULLED_HELPERS_DIR: root },
      ptyCheck: async () => true, commandRunner: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stdout: '' };
      } });
    const state = await manager.authState();
    assert.equal(state.fly.available, false);
    assert.equal(state.modal.available, false);
    assert.deepEqual(calls, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Fly account lease rechecks a private personal config with the bundled helper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seagulled-fly-lease-'));
  const dataDir = join(root, 'providers');
  const helperRoot = join(root, 'helpers');
  const flyctlPath = join(helperRoot, 'fly', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
  const flyConfigDir = join(dataDir, 'auth', 'fly');
  const home = join(root, 'home');
  mkdirSync(join(flyctlPath, '..'), { recursive: true });
  mkdirSync(flyConfigDir, { recursive: true });
  writeFileSync(flyctlPath, 'fixture');
  writeFileSync(join(flyConfigDir, 'config.yml'), 'fixture-private-config');
  const calls = [];
  let email = 'human@example.com';
  let changeDuringOrgList = false;
  let personalType = 'PERSONAL';
  let personalSlug = 'personal';
  let personalApps = [];
  try {
    const manager = new ProviderManager({ dataDir, helperRoot,
      env: { [process.platform === 'win32' ? 'USERPROFILE' : 'HOME']: home,
        FLY_API_TOKEN: 'service-token', FLY_CONFIG_DIR: join(root, 'service'), BROWSER: 'bad-browser' },
      ptyCheck: async () => false,
      commandRunner: async (command, args, options) => {
        calls.push({ command, args, env: options.env });
        if (args.join(' ') === 'orgs list --json') {
          if (changeDuringOrgList) email = 'changed@example.com';
          return { code: 0, stdout: '{"production":"Existing team","personal":"Personal"}' };
        }
        if (args.join(' ') === 'orgs show production --json') return { code: 0,
          stdout: '{"Slug":"production","Type":"SHARED","Apps":{"Nodes":[{"Name":"important"}]}}' };
        if (args.join(' ') === 'orgs show personal --json') return { code: 0,
          stdout: JSON.stringify({ Slug: personalSlug, Type: personalType, Apps: { Nodes: personalApps } }) };
        return { code: 0, stdout: args.join(' ') === 'auth whoami --json'
          ? JSON.stringify({ email }) : 'fixture-version' };
      } });
    const lease = await manager.flyAccountLease();
    assert.match(lease.accountRef, /^fly-account-sha256:[a-f0-9]{64}$/);
    assert.deepEqual(lease, { available: true, flyctlPath, flyConfigDir, scope: 'private',
      orgSlug: 'personal', accountRef: lease.accountRef });
    assert.equal((await manager.flyFleetLease()).accountRef, lease.accountRef);
    email = 'another-person@example.com';
    assert.notEqual((await manager.flyAccountLease()).accountRef, lease.accountRef);
    email = 'human@example.com';
    changeDuringOrgList = true;
    assert.equal((await manager.flyAccountLease()).available, false);
    changeDuringOrgList = false;
    email = 'human@example.com';
    personalApps = [{ Name: 'unrelated-existing-app' }];
    assert.deepEqual(await manager.flyAccountLease(), lease);
    assert.equal(await manager.assertFlyAccountLeaseCurrent(lease), true);
    assert.ok(calls.every(call => ['--version', 'auth whoami --json', 'orgs list --json',
      'orgs show production --json', 'orgs show personal --json'].includes(call.args.join(' '))));
    email = 'different@example.com';
    await assert.rejects(manager.assertFlyAccountLeaseCurrent(lease), /account or personal organization changed/);
    email = 'human@example.com';
    personalType = 'SHARED';
    await assert.rejects(manager.assertFlyAccountLeaseCurrent(lease), /account or personal organization changed/);
    personalType = 'PERSONAL';
    personalSlug = 'other-personal';
    await assert.rejects(manager.assertFlyAccountLeaseCurrent(lease), /account or personal organization changed/);
    personalSlug = 'personal';
    const sharedConfigDir = join(home, '.fly');
    mkdirSync(sharedConfigDir, { recursive: true });
    writeFileSync(join(sharedConfigDir, 'config.yml'), 'fixture-shared-config');
    rmSync(join(flyConfigDir, 'config.yml'));
    await assert.rejects(manager.assertFlyAccountLeaseCurrent(lease), /account or personal organization changed/);
    writeFileSync(join(flyConfigDir, 'config.yml'), 'fixture-private-config');
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(manager.assertFlyAccountLeaseCurrent(lease, { signal: stop.signal }),
      { name: 'AbortError' });
    await assert.rejects(manager.assertFlyAccountLeaseCurrent({ ...lease, accountRef: 'forged' }),
      /account or personal organization changed/);
    assert.ok(calls.every(call => call.command === flyctlPath && call.env.FLY_API_TOKEN === undefined
      && call.env.BROWSER === undefined));
    assert.ok(calls.filter(call => call.args.join(' ') === 'auth whoami --json')
      .every(call => [flyConfigDir, sharedConfigDir].includes(call.env.FLY_CONFIG_DIR)));
    const publicState = JSON.stringify(await manager.authState());
    assert.equal(publicState.includes(lease.accountRef) || publicState.includes(flyConfigDir) || publicState.includes(flyctlPath)
      || publicState.includes('service-token'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Fly account lease supports verified shared default config without copying credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seagulled-fly-lease-'));
  const home = join(root, 'home');
  const flyConfigDir = join(home, '.fly');
  const helperRoot = join(root, 'helpers');
  const flyctlPath = join(helperRoot, 'fly', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
  mkdirSync(join(flyctlPath, '..'), { recursive: true });
  mkdirSync(flyConfigDir, { recursive: true });
  writeFileSync(flyctlPath, 'fixture');
  writeFileSync(join(flyConfigDir, 'config.yml'), 'fixture-shared-config');
  const calls = [];
  try {
    const manager = new ProviderManager({ dataDir: join(root, 'providers'), helperRoot,
      env: { [process.platform === 'win32' ? 'USERPROFILE' : 'HOME']: home,
        FLY_CONFIG_DIR: join(root, 'service'), FLY_API_TOKEN: 'service-token' },
      ptyCheck: async () => false,
      commandRunner: async (command, args, options) => {
        calls.push({ command, args, env: options.env });
        if (args.join(' ') === 'orgs list --json') return { code: 0, stdout: '{"personal":"Personal"}' };
        if (args.join(' ') === 'orgs show personal --json') return { code: 0,
          stdout: '{"Slug":"personal","Type":"PERSONAL","Apps":{"Nodes":[]}}' };
        return { code: 0, stdout: args.join(' ') === 'auth whoami --json'
          ? '{"email":"human@example.com"}' : 'fixture-version' };
      } });
    const lease = await manager.flyAccountLease();
    assert.match(lease.accountRef, /^fly-account-sha256:[a-f0-9]{64}$/);
    assert.deepEqual(lease, { available: true, flyctlPath, flyConfigDir,
      scope: 'shared', orgSlug: 'personal', accountRef: lease.accountRef });
    assert.deepEqual(await manager.flyFleetLease(), lease);
    assert.ok(calls.every(call => call.env.FLY_CONFIG_DIR === flyConfigDir
      && call.env.FLY_API_TOKEN === undefined));
    assert.deepEqual(manager.authEnvironment('fly'), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Fly account lease rejects service identity, missing account config, and unbundled helper', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seagulled-fly-lease-'));
  const helperRoot = join(root, 'helpers');
  const flyctlPath = join(helperRoot, 'fly', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
  const flyConfigDir = join(root, 'providers', 'auth', 'fly');
  const home = join(root, 'home');
  mkdirSync(join(flyctlPath, '..'), { recursive: true });
  mkdirSync(flyConfigDir, { recursive: true });
  writeFileSync(flyctlPath, 'fixture');
  writeFileSync(join(flyConfigDir, 'config.yml'), 'fixture');
  try {
    const manager = new ProviderManager({ dataDir: join(root, 'providers'), helperRoot,
      env: { [process.platform === 'win32' ? 'USERPROFILE' : 'HOME']: home,
        FLY_API_TOKEN: 'service-token' }, ptyCheck: async () => false,
      commandRunner: async (_command, args) => ({ code: 0,
        stdout: args.join(' ') === 'auth whoami --json'
          ? '{"email":"worker@tokens.fly.io"}' : 'fixture-version' }) });
    assert.equal((await manager.flyAccountLease()).available, false);
    const personal = new ProviderManager({ dataDir: join(root, 'other-providers'), helperRoot,
      env: { [process.platform === 'win32' ? 'USERPROFILE' : 'HOME']: home }, ptyCheck: async () => false,
      commandRunner: async (_command, args) => ({ code: 0,
        stdout: args.join(' ') === 'auth whoami --json'
          ? '{"email":"human@example.com"}' : 'fixture-version' }) });
    assert.equal((await personal.flyAccountLease()).available, false);
    const unbundled = new ProviderManager({ dataDir: join(root, 'providers'), commands: { fly: flyctlPath },
      commandRunner: async () => ({ code: 0, stdout: '{"email":"human@example.com"}' }) });
    assert.equal((await unbundled.flyAccountLease()).available, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Fly organization lease refuses ambiguous, shared-only, and malformed metadata', async () => {
  const cases = [
    { name: 'shared-only', list: { production: 'Private production' },
      show: { production: { Slug: 'production', Type: 'SHARED', Apps: { Nodes: [] } } } },
    { name: 'two-personal', list: { personal: 'One', 'other-personal': 'Two' },
      show: { personal: { Slug: 'personal', Type: 'PERSONAL', Apps: { Nodes: [] } },
        'other-personal': { Slug: 'other-personal', Type: 'PERSONAL', Apps: { Nodes: [] } } } },
    { name: 'unknown-type', list: { personal: 'Private' },
      show: { personal: { Slug: 'personal', Type: 'UNKNOWN', Apps: { Nodes: [] } } } },
    { name: 'missing-app-evidence', list: { personal: 'Private' },
      show: { personal: { Slug: 'personal', Type: 'PERSONAL' } } },
    { name: 'invalid-app-evidence', list: { personal: 'Private' },
      show: { personal: { Slug: 'personal', Type: 'PERSONAL', Apps: { Nodes: {} } } } },
  ];
  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), 'seagulled-fly-org-'));
    const helperRoot = join(root, 'helpers');
    const flyctlPath = join(helperRoot, 'fly', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
    const flyConfigDir = join(root, 'providers', 'auth', 'fly');
    mkdirSync(join(flyctlPath, '..'), { recursive: true });
    mkdirSync(flyConfigDir, { recursive: true });
    writeFileSync(flyctlPath, 'fixture');
    writeFileSync(join(flyConfigDir, 'config.yml'), 'fixture');
    const calls = [];
    try {
      const manager = new ProviderManager({ dataDir: join(root, 'providers'), helperRoot,
        env: { [process.platform === 'win32' ? 'USERPROFILE' : 'HOME']: join(root, 'home'),
          FLY_API_TOKEN: 'inherited-service-secret' }, ptyCheck: async () => false,
        commandRunner: async (_command, args, options) => {
          calls.push({ args, env: options.env });
          const command = args.join(' ');
          if (command === '--version') return { code: 0, stdout: 'fixture-version' };
          if (command === 'auth whoami --json') return { code: 0, stdout: '{"email":"human@example.com"}' };
          if (command === 'orgs list --json') return { code: 0, stdout: JSON.stringify(scenario.list) };
          if (args[0] === 'orgs' && args[1] === 'show') return { code: 0,
            stdout: JSON.stringify(scenario.show[args[2]]) };
          throw new Error('Unexpected Fly command');
        } });
      const result = await manager.flyFleetLease();
      assert.equal(result.available, false, scenario.name);
      assert.match(result.detail, /personal Fly organization/i);
      assert.equal(JSON.stringify(result).includes('production') || JSON.stringify(result).includes(root), false);
      assert.ok(calls.every(call => call.env.FLY_API_TOKEN === undefined
        && ['--version', 'auth whoami --json', 'orgs list --json',
          'orgs show production --json', 'orgs show personal --json',
          'orgs show other-personal --json'].includes(call.args.join(' '))));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
