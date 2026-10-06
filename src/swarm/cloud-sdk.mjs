import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function installedCloudSdkRoot() {
  return path.dirname(fileURLToPath(import.meta.resolve('flujo-cloud/package.json')));
}

/** Resolve the selected SDK's public exports without importing its internal files. */
export function cloudSdkEntry(subpath = '.', selectedRoot) {
  const root = selectedRoot ?? installedCloudSdkRoot();
  if (!path.isAbsolute(root)) throw new Error('An installed cloud SDK package root is required.');
  const packageRoot = realpathSync(root);
  const manifestPath = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!['flujo-cloud', '@flujo-app/flujo-cloud'].includes(manifest.name)) {
    throw new Error('The selected package is not the FLUJO cloud SDK.');
  }
  const suffix = subpath === '.' ? '' : subpath.slice(1);
  if (subpath !== '.' && !/^\.\/[a-z-]+$/.test(subpath)) throw new Error('Invalid cloud SDK export.');
  const legacyFiles = { '.': 'managed.mjs', './process': 'process.mjs',
    './private-files': 'private-files.mjs', './snapshot': 'snapshot.mjs' };
  const declared = manifest.exports && Object.hasOwn(manifest.exports, subpath);
  if (!declared && !(selectedRoot !== undefined && manifest.name === 'flujo-cloud' && legacyFiles[subpath])) {
    throw new Error(`The selected cloud SDK does not expose ${subpath}.`);
  }
  // Saved explicit roots retain their original module identity during continuation.
  const entry = realpathSync(declared
    ? createRequire(pathToFileURL(manifestPath)).resolve(`${manifest.name}${suffix}`)
    : path.join(packageRoot, 'lib', legacyFiles[subpath]));
  const relative = path.relative(packageRoot, entry);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The cloud SDK export escaped its installed package.');
  }
  return entry;
}

export const importCloudSdk = (subpath, root) => import(pathToFileURL(cloudSdkEntry(subpath, root)).href);
