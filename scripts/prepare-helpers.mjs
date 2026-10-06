import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The bundled sign-in helpers currently target Windows x64.');
const lockBytes = readFileSync(new URL('../docs/helpers-lock.json', import.meta.url));
const lock = JSON.parse(lockBytes), digest = data => createHash('sha256').update(data).digest('hex');
const root = path.resolve('.private/helpers/win32-x64'), cache = path.resolve('.private/helper-downloads');
const manifestPath = path.join(root, 'manifest.json'), lockSha256 = digest(lockBytes);
mkdirSync(cache, { recursive: true });
function inventory(directory = root) {
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), relative = path.relative(root, file).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) throw new Error('A link entered the helper bundle.');
    if (entry.isDirectory()) entries.push(...inventory(file));
    else if (relative !== 'manifest.json') {
      if (!entry.isFile() || /(^|\/)(?:state\.json|session\.json|runtime\.lock|\.env.*|modal\.toml|config\.yml)$/.test(relative)) throw new Error('Unexpected helper account state.');
      const bytes = readFileSync(file); entries.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath));
  if (manifest.lockSha256 !== lockSha256 || JSON.stringify(manifest.files) !== JSON.stringify(inventory())) throw new Error('Helper bundle differs from its pinned inventory; preserve it and build in a clean directory.');
  console.log(`Verified ${manifest.files.length} bundled helper files.`);
  process.exit(0);
}
if (existsSync(root) && readdirSync(root).length) throw new Error('An unfinished helper bundle exists; preserve it before rebuilding.');
mkdirSync(root, { recursive: true });
async function artifact(item) {
  if (!/^[A-Za-z0-9_.-]+$/.test(item.filename) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid artifact lock.');
  const url = new URL(item.url);
  if (url.protocol !== 'https:' || !['www.python.org', 'github.com', 'files.pythonhosted.org', 'raw.githubusercontent.com'].includes(url.hostname)) throw new Error('Untrusted helper artifact origin.');
  const file = path.join(cache, item.filename), localWheel = path.resolve('.private/helper-wheels', item.filename);
  if (existsSync(localWheel) && lstatSync(localWheel).isFile() && digest(readFileSync(localWheel)) === item.sha256) return localWheel;
  if (existsSync(file)) { if (digest(readFileSync(file)) !== item.sha256) throw new Error(`Cached artifact mismatch: ${item.filename}`); return file; }
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Artifact unavailable: ${item.filename}`);
  let size = 0; const parts = [];
  for await (const part of response.body) { size += part.length; if (size > 128 * 1024 * 1024) throw new Error('Helper artifact exceeded its size limit.'); parts.push(part); }
  const bytes = Buffer.concat(parts);
  if (digest(bytes) !== item.sha256) throw new Error(`Downloaded artifact mismatch: ${item.filename}`);
  writeFileSync(file, bytes); return file;
}
function extract(archive, destination) {
  const names = execFileSync('tar.exe', ['-tf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split(/\r?\n/);
  for (const name of names) {
    if (!name || path.isAbsolute(name) || name.includes(':') || name.replaceAll('\\', '/').split('/').includes('..')) throw new Error('Unsafe helper archive member.');
  }
  mkdirSync(destination, { recursive: true });
  execFileSync('tar.exe', ['-xf', archive, '-C', destination], { windowsHide: true, stdio: 'pipe' });
}
const python = path.join(root, 'python'), fly = path.join(root, 'fly');
extract(await artifact(lock.python), python);
extract(await artifact(lock.fly), fly);
writeFileSync(path.join(fly, 'LICENSE.txt'), readFileSync(await artifact(lock.fly.license)));
for (const wheel of lock.modal.wheels) extract(await artifact(wheel), path.join(python, 'Lib', 'site-packages'));
writeFileSync(path.join(python, 'python313._pth'), 'python313.zip\n.\nLib/site-packages\nimport site\n');
// Version checks import the actual bundled runtimes; -B keeps them immutable.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:FLY_|MODAL_|PYTHON|BROWSER$)/i.test(key)));
const versions = {
  fly: execFileSync(path.join(fly, 'flyctl.exe'), ['version'], { env: cleanEnv, encoding: 'utf8', windowsHide: true }).trim(),
  modal: execFileSync(path.join(python, 'python.exe'), ['-B', '-m', 'modal', '--version'], { env: cleanEnv, encoding: 'utf8', windowsHide: true }).trim(),
};
const manifest = { schema: 1, platform: 'win32-x64', lockSha256, versions, files: inventory() };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${manifest.files.length} verified helper files: Fly ${lock.fly.version}, Python ${lock.python.version}, Modal ${lock.modal.version}.`);
