import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageSource } from '../scripts/package-source.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-source-export-'));
  // Only this test's newly created directory is removed.
  t.after(() => { if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup.'); rmSync(root, { recursive: true, force: true }); });
  const git = args => execFileSync('git', ['-C', root, ...args], { windowsHide: true });
  git(['init', '-q']); git(['config', 'user.name', 'Source fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  writeFileSync(path.join(root, 'package.json'), '{"version":"0.1.1"}\n');
  writeFileSync(path.join(root, 'source.mjs'), 'export const value = "committed";\n');
  const commit = () => { git(['add', '.']); git(['commit', '-qm', 'offline source fixture']); };
  commit();
  return { root, git, commit, outputDir: path.join(root, 'release', 'source') };
}

test('source export includes committed blobs only, excluding local changes and private state', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'source.mjs'), 'export const value = "local change";\n');
  mkdirSync(path.join(f.root, '.private'));
  writeFileSync(path.join(f.root, '.private', 'auth.json'), 'private fixture');
  writeFileSync(path.join(f.root, 'untracked.txt'), 'untracked fixture');
  const result = packageSource(f), inventory = JSON.parse(readFileSync(result.inventory));
  assert.deepEqual(inventory.files.map(file => file.path), ['package.json', 'source.mjs']);
  const committed = f.git(['show', 'HEAD:source.mjs']);
  assert.equal(inventory.files[1].bytes, committed.length);
  assert.ok(existsSync(result.archive));
  assert.throws(() => packageSource(f), /Preserve existing export/);
});

test('source export refuses tracked account state before writing an archive', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'auth.json'), 'private fixture'); f.commit();
  assert.throws(() => packageSource(f), /Unsafe source path/);
  assert.equal(existsSync(f.outputDir), false);
});

test('source export refuses credential patterns in committed text', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'notes.md'), ['ghp', '_', 'A'.repeat(30)].join('')); f.commit();
  assert.throws(() => packageSource(f), /Credential pattern/);
  assert.equal(existsSync(f.outputDir), false);
});

test('source export refuses symbolic links represented in the Git tree', t => {
  const f = fixture(t);
  const object = f.git(['hash-object', '-w', '--stdin']).toString().trim();
  f.git(['update-index', '--add', '--cacheinfo', `120000,${object},link`]);
  f.git(['commit', '-qm', 'offline link fixture']);
  assert.throws(() => packageSource(f), /Links and submodules/);
  assert.equal(existsSync(f.outputDir), false);
});
