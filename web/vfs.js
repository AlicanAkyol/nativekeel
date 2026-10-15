// In-memory stand-in for src/read-boundary.js in the browser build. The web checker scans a
// project made only of the files the visitor pasted; nothing else exists.
import path from 'path-browserify';

const files = new Map();
export function setFiles(entries) {
  files.clear();
  for (const [p, text] of Object.entries(entries)) files.set(path.resolve(p), String(text));
}
const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
const isDir = (p) => { const d = path.resolve(p); if (d === '/') return true; const pre = d.endsWith('/') ? d : `${d}/`; for (const f of files.keys()) if (f.startsWith(pre)) return true; return false; };
const stat = (p) => {
  const r = path.resolve(p);
  if (files.has(r)) { const size = new TextEncoder().encode(files.get(r)).length; return { size, mtimeMs: 0, ctimeMs: 0, dev: 1, ino: r.length, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }; }
  if (isDir(r)) return { size: 0, mtimeMs: 0, ctimeMs: 0, dev: 1, ino: 0, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
  throw enoent(p);
};
const fds = new Map();
const fs = {
  constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 },
  existsSync: (p) => { try { stat(p); return true; } catch { return false; } },
  statSync: stat,
  lstatSync: stat,
  realpathSync: (p) => { stat(p); return path.resolve(p); },
  readFileSync: (p, enc) => { const r = path.resolve(p); if (!files.has(r)) throw enoent(p); const t = files.get(r); return enc ? t : new TextEncoder().encode(t); },
  readdirSync: (p, opts) => {
    const d = path.resolve(p);
    if (!isDir(d)) throw enoent(p);
    const pre = d.endsWith('/') ? d : `${d}/`;
    const names = new Map();
    for (const f of files.keys()) if (f.startsWith(pre)) { const rest = f.slice(pre.length); const name = rest.split('/')[0]; names.set(name, rest.includes('/')); }
    const list = [...names.keys()].sort();
    if (!opts || !opts.withFileTypes) return list;
    return list.map((name) => ({ name, isDirectory: () => names.get(name), isFile: () => !names.get(name), isSymbolicLink: () => false }));
  },
  openSync: (p) => { const r = path.resolve(p); if (!files.has(r)) throw enoent(p); const fd = fds.size + 3; fds.set(fd, r); return fd; },
  fstatSync: (fd) => stat(fds.get(fd)),
  readSync: (fd, buf, off, len, pos) => { const bytes = new TextEncoder().encode(files.get(fds.get(fd))); const n = Math.max(0, Math.min(len, bytes.length - pos)); buf.set(bytes.subarray(pos, pos + n), off); return n; },
  closeSync: (fd) => { fds.delete(fd); },
  writeFileSync: () => { throw new Error('read-only'); },
  rmSync: () => {},
  mkdtempSync: () => { throw new Error('not available in the browser'); },
};
export const readPolicy = () => undefined;
export const withReadRoots = (roots, fn) => fn();
export const checkedPath = (file) => file;
export default fs;
