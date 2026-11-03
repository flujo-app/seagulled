import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** CLI and browser development reuse prepared helpers; Electron supplies its resource root. */
export function productHelperRoot(env = process.env) {
  if (env.SEAGULLED_HELPERS_DIR) return path.resolve(env.SEAGULLED_HELPERS_DIR);
  const root = fileURLToPath(new URL('../.private/helpers/', import.meta.url));
  const candidate = path.join(root, `${process.platform}-${process.arch}`);
  return existsSync(path.join(candidate, 'fly', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl'))
    ? candidate : undefined;
}

/** A privately installed provider client takes precedence over an older host CLI. */
export function productProviderCommands(dataDir) {
  const triples = {'win32-x64':'x86_64-pc-windows-msvc','win32-arm64':'aarch64-pc-windows-msvc',
    'linux-x64':'x86_64-unknown-linux-musl','linux-arm64':'aarch64-unknown-linux-musl',
    'darwin-x64':'x86_64-apple-darwin','darwin-arm64':'aarch64-apple-darwin'};
  const platform = `${process.platform}-${process.arch}`, triple = triples[platform];
  if (!triple) return {};
  const codex = path.join(dataDir,'product','codex-cli','node_modules','@openai',`codex-${platform}`,
    'vendor',triple,'bin',process.platform === 'win32' ? 'codex.exe' : 'codex');
  return existsSync(codex) ? {codex} : {};
}
