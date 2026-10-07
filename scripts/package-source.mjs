import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const forbiddenPath = /(^|\/)(?:\.git|\.private|\.env[^/]*|node_modules|release|dist|coverage|\.seagulled|__pycache__|credentials?\.(?:json|ya?ml|toml|ini|txt)|auth\.json|session\.json|state\.json|runtime\.lock|modal\.toml|config\.yml)(\/|$)|\.(?:pem|key|db|sqlite3?|log|pyc)$|\.local\.json$/i;
const credentialPattern = /gh[pousr]_[A-Za-z0-9]{25,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/;

export function packageSource({ root = process.cwd(), outputDir = path.join(root, 'release', 'source') } = {}) {
  const git = args => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  const tree = git(['ls-tree', '-r', '-z', commit]).toString().split('\0').filter(Boolean);
  const files = tree.map(entry => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Invalid Git tree entry.');
    const [, mode, type, object, filename] = match;
    if (!['100644', '100755'].includes(mode) || type !== 'blob') throw new Error(`Links and submodules are excluded: ${filename}`);
    if (filename.includes('\\') || filename.includes(':') || filename.includes('\n') || filename.includes('\r')
      || filename.split('/').some(part => !part || part === '.' || part === '..') || forbiddenPath.test(filename)) {
      throw new Error(`Unsafe source path: ${filename}`);
    }
    const bytes = git(['cat-file', 'blob', object]);
    if (/\.(?:md|json|mjs|cjs|js|py|html|css|ya?ml|txt)$/.test(filename) && credentialPattern.test(bytes.toString('utf8'))) {
      throw new Error(`Credential pattern in committed source: ${filename}`);
    }
    return { path: filename, mode, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const pkg = JSON.parse(git(['show', `${commit}:package.json`]));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid source package version.');
  const stem = `seagulled-${pkg.version}-source`, prefix = `seagulled-${pkg.version}/`;
  const archive = path.join(outputDir, `${stem}.zip`);
  const inventoryPath = path.join(outputDir, `${stem}.inventory.json`);
  const checksumsPath = path.join(outputDir, `${stem}.SHA256SUMS.txt`);
  for (const file of [archive, inventoryPath, checksumsPath]) if (existsSync(file)) throw new Error(`Preserve existing export: ${file}`);
  mkdirSync(outputDir, { recursive: true });
  git(['archive', '--format=zip', `--prefix=${prefix}`, `--output=${archive}`, commit]);
  const archiveBytes = readFileSync(archive);
  const inventory = { schemaVersion: 1, version: pkg.version, sourceCommit: commit, prefix,
    archive: { file: path.basename(archive), bytes: archiveBytes.length, sha256: sha256(archiveBytes) }, files };
  const inventoryBytes = Buffer.from(JSON.stringify(inventory, null, 2) + '\n');
  writeFileSync(inventoryPath, inventoryBytes, { flag: 'wx' });
  writeFileSync(checksumsPath, `${inventory.archive.sha256}  ${path.basename(archive)}\n${sha256(inventoryBytes)}  ${path.basename(inventoryPath)}\n`, { flag: 'wx' });
  return { sourceCommit: commit, files: files.length, archive, inventory: inventoryPath, checksums: checksumsPath, sha256: inventory.archive.sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(packageSource({ outputDir: process.argv[2] ? path.resolve(process.argv[2]) : undefined }), null, 2));
}
