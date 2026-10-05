import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const excluded = new Set(['node_modules', '.git', '.private', 'release', 'dist', 'coverage']);
const files = [];
function walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(absolute); else files.push(absolute);
  }
}
walk(root);
let issues = [];
for (const file of files) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (/\.(mjs|cjs|js)$/.test(file)) {
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
    catch { issues.push(`Syntax check failed: ${relative}`); }
  }
  if (!/\.(md|json|mjs|cjs|js|py|html|css|yml)$/.test(file) || /package-lock\.json$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (/gh[pousr]_[A-Za-z0-9]{25,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/.test(text)) issues.push(`Credential pattern: ${relative}`);
  if ((relative === 'README.md' || relative.startsWith('docs/')) && /hackathon/i.test(text)) issues.push(`Private project reference: ${relative}`);
}
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
for (const key of ['main', 'license', 'author', 'repository']) if (!pkg[key]) issues.push(`Missing package metadata: ${key}`);
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log(`Release checks passed: ${files.length} files; syntax, metadata and credential-pattern scan.`);
