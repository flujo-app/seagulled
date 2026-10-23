import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(readFileSync(path.join(root, 'docs', 'journey-media-lock.json'), 'utf8'));
const destinations = [path.join(root, '.private', 'journey-media'), path.join(root, 'ui', 'journey-media')];
const source = process.argv[2] || process.env.SEAGULLED_MEDIA_DIR || destinations[0];
if (!path.isAbsolute(source)) throw new Error('The media source must be an absolute directory.');
if (lock.version !== 1 || !Array.isArray(lock.assets) || lock.assets.length !== 7) throw new Error('Invalid journey media lock.');
const digest = data => createHash('sha256').update(data).digest('hex');
const sourceRoot = realpathSync(source);
const names = new Set();
const staged = lock.assets.map(asset => {
  if (!/^[a-z-]+\.mp4$/.test(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256) || names.has(asset.file)) throw new Error('Invalid locked media identity.');
  names.add(asset.file);
  const filename = path.join(sourceRoot, asset.file);
  if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()
    || path.dirname(realpathSync(filename)) !== sourceRoot) throw new Error('Media must be regular files inside the selected directory.');
  const bytes = readFileSync(filename);
  if (bytes.length > 20_000_000 || digest(bytes) !== asset.sha256) throw new Error(`Media hash mismatch: ${asset.file}`);
  return { asset, bytes };
});
const manifest = JSON.stringify(lock, null, 2) + '\n';
// Validate both targets before staging either, so a damaged renderer directory
// cannot cause a partially successful package preparation.
for (const destination of destinations) if (existsSync(destination)) {
  if (lstatSync(destination).isSymbolicLink()) throw new Error('The media staging directory cannot be a link.');
  for (const name of readdirSync(destination)) {
    if (!names.has(name) && name !== 'manifest.json') throw new Error('Unexpected staging file; preserve this directory and choose a clean checkout.');
  }
  for (const { asset } of staged) {
    const filename = path.join(destination, asset.file);
    if (existsSync(filename) && (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()
      || digest(readFileSync(filename)) !== asset.sha256)) throw new Error('Existing staged media differs from its lock.');
  }
  const manifestPath = path.join(destination, 'manifest.json');
  if (existsSync(manifestPath) && (lstatSync(manifestPath).isSymbolicLink() || !lstatSync(manifestPath).isFile()
    || readFileSync(manifestPath, 'utf8') !== manifest)) throw new Error('Existing media manifest differs from its lock.');
}
for (const destination of destinations) {
mkdirSync(destination, { recursive: true });
for (const { asset, bytes } of staged) {
  const filename = path.join(destination, asset.file);
  if (!existsSync(filename)) writeFileSync(filename, bytes, { flag: 'wx' });
}
const manifestPath = path.join(destination, 'manifest.json');
if (existsSync(manifestPath)) {
  if (lstatSync(manifestPath).isSymbolicLink() || readFileSync(manifestPath, 'utf8') !== manifest) throw new Error('Existing media manifest differs from its lock.');
} else writeFileSync(manifestPath, manifest, { flag: 'wx' });
}
console.log(`Verified ${staged.length} wizard media assets; cue timing review: ${lock.cueTimingReview}.`);
