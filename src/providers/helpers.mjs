import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function regularFileWithin(root, file) {
  try {
    const actualRoot = realpathSync(root);
    const actualFile = realpathSync(file);
    const inside = relative(actualRoot, actualFile);
    return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`)
      && !isAbsolute(inside) && statSync(actualFile).isFile();
  } catch { return false; }
}

/** Resolve account helpers without inspecting or copying their credential stores. */
export function resolveAccountHelpers({ helperRoot, env = process.env, commands = {} } = {}) {
  const requestedRoot = helperRoot ?? env.SEAGULLED_HELPERS_DIR;
  const bundled = requestedRoot !== undefined && requestedRoot !== null && requestedRoot !== '';
  const root = bundled && typeof requestedRoot === 'string' && isAbsolute(requestedRoot)
    ? resolve(requestedRoot) : null;
  const flyFile = root ? join(root, 'fly', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl') : '';
  const pythonFile = root ? join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'python') : '';
  const modalModule = root ? join(root, 'python', 'Lib', 'site-packages', 'modal', '__main__.py') : '';
  const fly = commands.fly !== undefined
    ? { command: commands.fly, args: [], usable: true, bundled: false }
    : bundled
      ? { command: flyFile, args: [], usable: Boolean(root && regularFileWithin(root, flyFile)), bundled: true }
      : { command: 'flyctl', args: [], usable: true, bundled: false };
  const modal = commands.modal !== undefined
    ? { command: commands.modal, args: Array.isArray(commands.modalArgs) ? [...commands.modalArgs] : [],
      usable: true, bundled: false }
    : bundled
      ? { command: pythonFile, args: ['-B', '-m', 'modal'],
        usable: Boolean(root && [pythonFile, modalModule].every(file => regularFileWithin(root, file))),
        bundled: true, runtimeDir: root ? join(root, 'python') : undefined }
      : { command: 'modal', args: [], usable: true, bundled: false };
  return { fly, modal };
}
