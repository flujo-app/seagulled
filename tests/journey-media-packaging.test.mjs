import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'seagulled-media-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ['scripts', 'docs', 'input']) mkdirSync(path.join(root, folder));
  const script = path.join(root, 'scripts', 'prepare-journey-media.mjs');
  copyFileSync(new URL('../scripts/prepare-journey-media.mjs', import.meta.url), script);
  const names = ['intro', 'selected', 'removed', 'confirmed', 'confirmed-alternate', 'fly-complete', 'starfield-loading'];
  const assets = names.map(id => {
    const bytes = Buffer.from(`offline-media-fixture:${id}`);
    writeFileSync(path.join(root, 'input', `${id}.mp4`), bytes);
    return { id, file: `${id}.mp4`, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  writeFileSync(path.join(root, 'docs', 'journey-media-lock.json'), JSON.stringify({ version: 1, cueTimingReview: 'pending-playback', assets }));
  const run = () => spawnSync(process.execPath, [script, path.join(root, 'input')], { encoding: 'utf8' });
  return { root, assets, run, destination: path.join(root, '.private', 'journey-media') };
}

test('media staging copies only the pinned cues and manifest, excluding input account and downloader state', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'input', 'credentials.json'), 'private fixture account state');
  writeFileSync(path.join(f.root, 'input', 'source.info.json'), 'private fixture download metadata');
  assert.equal(f.run().status, 0);
  assert.deepEqual(readdirSync(f.destination).sort(), [...f.assets.map(a => a.file), 'manifest.json'].sort());
  assert.deepEqual(readdirSync(path.join(f.root, 'ui', 'journey-media')).sort(), readdirSync(f.destination).sort());
  const manifest = readFileSync(path.join(f.destination, 'manifest.json'), 'utf8');
  assert.equal(manifest.includes('account state'), false);
  assert.equal(f.run().status, 0, 'an identical verified staging run is idempotent');
});

test('unexpected renderer media blocks all staging before the private destination is created', t => {
  const f = fixture(t), renderer = path.join(f.root, 'ui', 'journey-media');
  mkdirSync(renderer, { recursive: true });
  writeFileSync(path.join(renderer, 'credentials.json'), 'preserved fixture');
  assert.notEqual(f.run().status, 0);
  assert.equal(existsSync(f.destination), false);
  assert.equal(readFileSync(path.join(renderer, 'credentials.json'), 'utf8'), 'preserved fixture');
});

test('a changed media source fails before any asset is staged', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'input', 'fly-complete.mp4'), 'changed fixture');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hash mismatch/);
  assert.equal(existsSync(f.destination), false);
});

test('unexpected private destination state blocks packaging without overwriting it', t => {
  const f = fixture(t);
  mkdirSync(f.destination, { recursive: true });
  const privatePath = path.join(f.destination, 'credentials.json');
  writeFileSync(privatePath, 'preserved fixture');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected staging file/);
  assert.equal(readFileSync(privatePath, 'utf8'), 'preserved fixture');
  assert.deepEqual(readdirSync(f.destination), ['credentials.json']);
});

test('a fresh source checkout stages its committed media without private inputs', t => {
  const f = fixture(t);
  const bundled = path.join(f.root, 'assets', 'journey');
  mkdirSync(bundled, { recursive: true });
  for (const asset of f.assets) copyFileSync(path.join(f.root, 'input', asset.file), path.join(bundled, asset.file));
  const env = { ...process.env }; delete env.SEAGULLED_MEDIA_DIR;
  const result = spawnSync(process.execPath, [path.join(f.root, 'scripts', 'prepare-journey-media.mjs')], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(f.destination).sort(), [...f.assets.map(a => a.file), 'manifest.json'].sort());
});
