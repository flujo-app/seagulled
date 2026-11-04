import {createRequire} from 'node:module';
import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const unpacked = file => file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
/** Node 24.22.2 on Debian slim, by digest. FACTORY's bootstrap installs the worker program on it. */
export const PRODUCT_WORKER_IMAGE = 'docker.io/library/node@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c';

/** Resolve executable product dependencies without importing any account state. */
export function installedProductRuntime() {
  try {
    const cloudSdkRoot = realpathSync(unpacked(path.dirname(path.dirname(require.resolve('flujo-cloud')))));
    if (!existsSync(path.join(cloudSdkRoot, 'lib', 'machines.mjs'))) return null;
    return {cloudSdkRoot};
  } catch { return null; }
}
