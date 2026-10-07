import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

if (!process.argv[2]) throw new Error('Supply the downloaded source inventory JSON path.');
const inventory = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.files) || !inventory.files.length) throw new Error('Invalid source inventory.');
const root = realpathSync(process.cwd()), names = new Set();
for (const entry of inventory.files) {
  if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.includes(':')
    || entry.path.split('/').some(part => !part || part === '.' || part === '..') || names.has(entry.path)
    || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Unsafe inventory entry.');
  names.add(entry.path);
  const filename = path.join(root, ...entry.path.split('/')), relative = path.relative(root, realpathSync(filename));
  if (relative.startsWith('..') || path.isAbsolute(relative) || !lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) throw new Error(`Unsafe source file: ${entry.path}`);
  const bytes = readFileSync(filename);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Source mismatch: ${entry.path}`);
}
console.log(`Verified ${names.size} source inputs from ${inventory.sourceCommit}.`);
