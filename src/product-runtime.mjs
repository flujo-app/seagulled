import {createRequire} from 'node:module';
import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const require = createRequire(import.meta.url);
const unpacked = file => file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
export const PRODUCT_WORKER_IMAGE = 'ghcr.io/mario-andreschak/flujo@sha256:d736dc60c548e5a924c4f50ee5763fb4d602971ac0147ed09cf8f13e677c7acf';

/** Retain the SDK's source/capability checks and bind their result to this release. */
export function productImageResolver(cloudSdkRoot) {
  return async input => {
    const {resolveWorkerImage}=await import(pathToFileURL(path.join(cloudSdkRoot,'lib','images.mjs')).href);
    const resolved=await resolveWorkerImage({...input,channel:'3.48.1'});
    if(resolved.image!==PRODUCT_WORKER_IMAGE)throw Object.assign(new Error('The published Worker image changed; update Seagulled before running this goal.'),{code:'IMAGE_IDENTITY',outcome:'not_applied'});
    return resolved;
  };
}

/** Resolve executable product dependencies without importing any account state. */
export function installedProductRuntime() {
  try {
    const sourceAppRoot = realpathSync(unpacked(path.dirname(require.resolve('flujo-ai/package.json'))));
    const cloudSdkRoot = realpathSync(unpacked(path.dirname(path.dirname(require.resolve('flujo-cloud')))));
    if (!existsSync(path.join(sourceAppRoot, '.next', 'BUILD_ID'))
      || !existsSync(path.join(cloudSdkRoot, 'lib', 'managed.mjs'))) return null;
    return {sourceAppRoot, cloudSdkRoot};
  } catch { return null; }
}

export function productNodeBinary(productRoot) {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const bundled = process.resourcesPath && path.join(process.resourcesPath, 'node-runtime', name);
  if (bundled && existsSync(bundled)) return bundled;
  const installed = path.join(productRoot, 'node', name);
  return existsSync(installed) ? installed : process.execPath;
}
