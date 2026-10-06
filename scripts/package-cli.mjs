import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const commit = execFileSync('git', ['rev-parse', '--verify', `${process.argv[2] || 'HEAD'}^{commit}`],
  { encoding: 'utf8', windowsHide: true }).trim();
assert.match(commit, /^[a-f0-9]{40}$/);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && path.isAbsolute(npmCli) && existsSync(npmCli), 'Run this command with npm run package:cli.');
const staging = path.join(root, '.private', `cli-package-${commit.slice(0, 7)}-${randomUUID()}`);
mkdirSync(staging, { recursive: true });
const sourceArchive = path.join(staging, 'source.tar');
execFileSync('git', ['archive', '--format=tar', '--output', sourceArchive, commit], { windowsHide: true });
const members = execFileSync('tar', ['-tf', sourceArchive], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
for (const member of members) {
  assert.ok(member && !path.isAbsolute(member) && !member.includes(':')
    && !member.replaceAll('\\', '/').split('/').includes('..'), 'Unsafe source archive entry.');
}
const source = path.join(staging, 'source');
mkdirSync(source);
execFileSync('tar', ['-xf', sourceArchive, '-C', source], { windowsHide: true });
const pkg = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
const bundled = pkg.bundleDependencies || pkg.bundledDependencies;
assert.ok(Array.isArray(bundled) && bundled.length > 0, 'The CLI must bundle its installed upstream runtime packages.');
const npm = args => execFileSync(process.execPath, [npmCli, ...args],
  { cwd: source, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json']));
const forbidden = /(?:^|\/)(?:\.private|upstream|tests?|diagnostics|__pycache__)\/|(?:^|\/)(?:\.env(?:\.|$)|state\.json|session\.json|runtime\.lock|modal\.toml|auth\.json)|\.pyc$/;
assert.deepEqual(packed.files.filter(file => forbidden.test(file.path)), [], 'Private state or vendored source entered the CLI package.');
for (const name of bundled) {
  assert.ok(packed.files.some(file => file.path === `node_modules/${name}/package.json`), `Missing bundled dependency: ${name}`);
}
const archive = path.join(source, packed.filename);
const unpacked = path.join(staging, 'unpacked');
mkdirSync(unpacked);
execFileSync('tar', ['-xf', archive, '-C', unpacked], { windowsHide: true });
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
env.PATH = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '';
const profile = path.join(homedir(), `.seagulled-cli-package-${randomUUID()}`);
env.HOME = profile;
env.USERPROFILE = profile;
env.APPDATA = path.join(profile, 'AppData', 'Roaming');
env.LOCALAPPDATA = path.join(profile, 'AppData', 'Local');
mkdirSync(env.APPDATA, { recursive: true });
mkdirSync(env.LOCALAPPDATA, { recursive: true });
const state = JSON.parse(execFileSync(process.execPath, [path.join(unpacked, 'package', 'bin', 'seagulled.mjs'),
  'status', '--home', profile, '--json'], { encoding: 'utf8', env, windowsHide: true }));
assert.equal(state.version, 1);
assert.deepEqual(state.goals, []);
assert.equal(existsSync(path.join(profile, 'runtime.lock')), false);
const output = path.join(root, 'release');
mkdirSync(output, { recursive: true });
const target = path.join(output, `Seagulled-${pkg.version}-${commit.slice(0, 7)}-cli.tgz`);
copyFileSync(archive, target, constants.COPYFILE_EXCL);
const receipt = { sourceCommit: commit, version: pkg.version, artifact: path.basename(target),
  bytes: statSync(target).size, sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
  entries: packed.entryCount, bundled, cleanGitExport: true, standaloneCli: true,
  lifecycleScriptsExecuted: false, published: false, liveProviderRun: false };
writeFileSync(path.join(staging, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
