import fs, { checkedPath } from './read-boundary.js';
import path from 'node:path';

// Conservative references, not a runtime reachability graph. An optional/peer declaration
// blocks an unused candidate even when its activation condition is not known. Never execute
// a package, resolver or PnP loader. Failure/budget exhaustion means we cannot prove absence.
export function dependencyReferences(root, { maxPackages = 20000 } = {}) {
  const references = new Set();
  const visited = new Set();
  const packages = new Set();
  const pending = [];
  let complete = true;
  for (let dir = root; ; dir = path.dirname(dir)) {
    pending.push(path.join(dir, 'node_modules'));
    if (dir === path.dirname(dir)) break;
  }
  const list = (dir, optional = false) => {
    try { return fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) {
      if (!(optional && e.code === 'ENOENT')) complete = false;
      return [];
    }
  };
  const inspect = (dir) => {
    let real;
    try {
      real = fs.realpathSync(checkedPath(dir));
      if (packages.has(real)) return;
      if (packages.size >= maxPackages) { complete = false; return; }
      packages.add(real);
      const file = path.join(real, 'package.json');
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) { complete = false; return; }
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) { complete = false; return; }
      for (const kind of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = manifest[kind];
        if (deps === undefined) continue;
        if (!deps || typeof deps !== 'object' || Array.isArray(deps)) { complete = false; continue; }
        for (const name of Object.keys(deps)) references.add(name);
      }
      pending.push(path.join(real, 'node_modules'));
      // pnpm links resolve into .pnpm/<locator>/node_modules/<package>. Its siblings
      // include the transitive packages; walking the physical node_modules preserves them.
      const parent = path.basename(path.dirname(real)).startsWith('@') ? path.dirname(path.dirname(real)) : path.dirname(real);
      if (path.basename(parent) === 'node_modules') pending.push(parent);
    } catch { complete = false; }
  };
  for (let i = 0; i < pending.length; i++) {
    const dir = pending[i];
    let real;
    try { real = fs.realpathSync(checkedPath(dir)); }
    catch (e) { if (e.code !== 'ENOENT') complete = false; continue; }
    if (visited.has(real)) continue;
    visited.add(real);
    for (const entry of list(real)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue;
      const location = path.join(real, entry.name);
      if (entry.name.startsWith('@')) {
        for (const child of list(location)) {
          if (child.isDirectory() || child.isSymbolicLink()) inspect(path.join(location, child.name));
        }
      } else inspect(location);
      if (packages.size >= maxPackages) return { references, complete: false };
    }
  }
  return { references, complete };
}
