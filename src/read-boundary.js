import nativeFs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

// Request-local policy: never change Node's global fs object or another concurrent scan.
// CLI scans keep their normal filesystem semantics; MCP wraps all project reads in a policy.
const policies = new AsyncLocalStorage();
export const readPolicy = () => policies.getStore();
export function withReadRoots(roots, fn) {
  const parent = readPolicy();
  return policies.run({ roots: roots.map(r => nativeFs.realpathSync(r)), denied: parent?.denied || new Set() }, fn);
}
const inside = (file, root) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
export function checkedPath(file) {
  const policy = readPolicy();
  if (!policy) return file;
  const real = nativeFs.realpathSync(file);
  if (!policy.roots.some(root => inside(real, root))) {
    policy.denied.add('outside-root');
    throw Object.assign(new Error('A project file points outside the folders this server may read.'), { code: 'EACCES' });
  }
  return real;
}
function openRead(file) {
  const real = checkedPath(file);
  const fd = nativeFs.openSync(real, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0) | (nativeFs.constants.O_NONBLOCK || 0));
  try {
    const st = nativeFs.fstatSync(fd);
    const current = nativeFs.statSync(checkedPath(file));
    if (!st.isFile() || st.size > 512 * 1024 * 1024 || st.dev !== current.dev || st.ino !== current.ino) {
      readPolicy()?.denied.add('non-regular-or-changed');
      throw new Error('Project input must be a regular, stable file smaller than 512 MB.');
    }
    return fd;
  } catch (e) { nativeFs.closeSync(fd); throw e; }
}
const fs = { ...nativeFs,
  existsSync(file) {
    try { return nativeFs.existsSync(checkedPath(file)); } catch { return false; }
  },
  statSync(file, ...args) { return nativeFs.statSync(checkedPath(file), ...args); },
  lstatSync(file, ...args) { checkedPath(file); return nativeFs.lstatSync(file, ...args); },
  readFileSync(file, options) {
    if (!readPolicy()) return nativeFs.readFileSync(file, options);
    const fd = openRead(file);
    try { return nativeFs.readFileSync(fd, options); } finally { nativeFs.closeSync(fd); }
  },
  openSync(file, flags, ...args) {
    if (!readPolicy()) return nativeFs.openSync(file, flags, ...args);
    if (flags !== 'r') throw new Error('Only read access is allowed during a scan.');
    return openRead(file);
  },
  readdirSync(dir, options) {
    const real = checkedPath(dir);
    if (!readPolicy() || !options?.recursive) return nativeFs.readdirSync(real, options);
    // The recursive native call would bypass our checks for nested directories.
    const out = [];
    const visit = (d, prefix = '') => {
      for (const e of nativeFs.readdirSync(checkedPath(d), { withFileTypes: true })) {
        const name = path.join(prefix, e.name);
        out.push(options.withFileTypes ? e : name);
        if (e.isDirectory()) visit(path.join(d, e.name), name);
      }
    };
    visit(real);
    return out;
  },
};
export default fs;
