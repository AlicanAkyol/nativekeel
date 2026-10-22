import fs from './read-boundary.js';
import path from 'node:path';

// Exact versions of direct dependencies, read from the lockfile next to the app or at the
// workspace root (monorepos). Used where a range from package.json would be a guess, e.g.
// matching security advisories. Returns { name: version } for the names it could resolve.

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

function findUp(root, names) {
  let dir = root;
  while (true) {
    for (const n of names) {
      const file = path.join(dir, n);
      if (fs.existsSync(file)) return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function lockedVersions(root, declared) {
  const file = findUp(root, ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']);
  if (!file) return {};
  const text = readText(file);
  if (!text) return {};
  const rel = path.relative(path.dirname(file), root).split(path.sep).join('/');
  if (file.endsWith('.json')) return fromNpm(text, rel, declared);
  if (file.endsWith('pnpm-lock.yaml')) return fromPnpm(text, rel || '.', declared);
  return fromYarn(text, declared);
}

function fromNpm(text, rel, declared) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return {};
  }
  const out = {};
  for (const name of Object.keys(declared)) {
    const pkgs = lock.packages || {};
    const hit =
      (rel && pkgs[`${rel}/node_modules/${name}`]) || pkgs[`node_modules/${name}`] || (lock.dependencies && lock.dependencies[name]);
    if (hit && hit.version && /^\d/.test(hit.version)) out[name] = hit.version;
  }
  return out;
}

// pnpm-lock.yaml (v6 and v9): importers.<path>.(dependencies|devDependencies).<name>.version
function fromPnpm(text, importer, declared) {
  const out = {};
  const lines = text.split('\n');
  let inImporters = false;
  let current = null;
  let section = null;
  let pkg = null;
  for (const line of lines) {
    if (/^importers:\s*$/.test(line)) {
      inImporters = true;
      continue;
    }
    if (inImporters && /^\S/.test(line)) {
      // Next top-level key. pnpm 11 can write several YAML documents, so keep looking.
      inImporters = false;
      current = null;
      continue;
    }
    if (!inImporters) continue;
    const imp = line.match(/^ {2}(\S.*?):\s*$/);
    if (imp) {
      current = imp[1].replace(/^['"]|['"]$/g, '');
      section = null;
      continue;
    }
    if (current !== importer) continue;
    const sec = line.match(/^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/);
    if (sec) {
      section = sec[1];
      continue;
    }
    if (!section) continue;
    const name = line.match(/^ {6}(\S.*?):\s*$/);
    if (name) {
      pkg = name[1].replace(/^['"]|['"]$/g, '');
      continue;
    }
    const ver = line.match(/^ {8}version:\s*['"]?([0-9][^\s('"]*)/);
    if (ver && pkg && declared[pkg]) out[pkg] = ver[1];
  }
  return out;
}

// yarn.lock v1 ("name@range", name@range:\n  version "x") and berry ("name@npm:range":\n  version: x)
function fromYarn(text, declared) {
  const byPattern = {};
  let patterns = null;
  for (const line of text.split('\n')) {
    if (/^\S.*:\s*$/.test(line) && !line.startsWith('#') && !line.startsWith('__metadata')) {
      patterns = line
        .replace(/:\s*$/, '')
        .split(/,\s*/)
        .map((p) => p.trim().replace(/^"|"$/g, ''));
      continue;
    }
    const ver = line.match(/^\s+version:?\s+"?([0-9][^"\s]*)"?/);
    if (ver && patterns) {
      for (const p of patterns) byPattern[p] = ver[1];
      patterns = null;
    }
  }
  const out = {};
  for (const [name, range] of Object.entries(declared)) {
    const v = byPattern[`${name}@${range}`] || byPattern[`${name}@npm:${range}`];
    if (v) out[name] = v;
  }
  return out;
}

// Every version of one package the lockfile resolves, nested copies included
// (two copies of a core package means two module instances at runtime). null without a lockfile.
export function lockedCopies(root, name) {
  const file = findUp(root, ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']);
  const text = file && readText(file);
  if (!text) return null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new Set();
  if (file.endsWith('bun.lock')) {
    for (const m of text.matchAll(new RegExp(`^\\s*"(?:[^"]*/)?${esc}": \\["${esc}@(\\d[^"]*)"`, 'gm'))) found.add(m[1]);
  } else if (file.endsWith('.json')) {
    try {
      const lock = JSON.parse(text);
      for (const [key, v] of Object.entries(lock.packages || {})) {
        if ((key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) && v.version && /^\d/.test(v.version)) found.add(v.version);
      }
    } catch {
      return null;
    }
  } else if (file.endsWith('pnpm-lock.yaml')) {
    for (const m of text.matchAll(new RegExp(`^ {2}['"]?/?${esc}@(\\d[^(:'"\\s]*)`, 'gm'))) found.add(m[1]);
  } else {
    let patterns = null;
    for (const line of text.split('\n')) {
      if (/^\S.*:\s*$/.test(line) && !line.startsWith('#')) {
        patterns = line.replace(/:\s*$/, '').split(/,\s*/).map((p) => p.trim().replace(/^"|"$/g, ''));
        continue;
      }
      const ver = line.match(/^\s+version:?\s+"?([0-9][^"\s]*)"?/);
      if (ver && patterns) {
        if (patterns.some((p) => p.startsWith(`${name}@`) && !/@(?:patch|workspace|link|file|portal):/.test(p.slice(name.length)))) found.add(ver[1]);
        patterns = null;
      }
    }
  }
  return [...found];
}

// Every package the lockfile resolves, transitive ones included: Map name -> Set of versions.
// Supply-chain attacks land deep in the tree (a compromised dependency of a dependency), so
// security advisories are matched against all of it, not only package.json. Registry packages
// only: workspace, link, file, git and patch entries are other code that merely shares a name.
// Returns { file, packages } or null without a lockfile.
export function lockedInventory(root) {
  const file = findUp(root, ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']);
  const text = file && readText(file);
  if (!text) return null;
  const packages = new Map();
  const add = (name, version) => {
    if (!name || !/^\d+\.\d+\.\d+/.test(version || '')) return;
    if (!packages.has(name)) packages.set(name, new Set());
    packages.get(name).add(version);
  };
  if (file.endsWith('.json')) {
    let lock;
    try {
      lock = JSON.parse(text);
    } catch {
      return null;
    }
    for (const [key, v] of Object.entries(lock.packages || {})) {
      const at = key.lastIndexOf('node_modules/');
      if (at < 0 || !v || v.link || (v.resolved && !/^https?:/.test(v.resolved))) continue;
      add(v.name || key.slice(at + 'node_modules/'.length), v.version);
    }
    // lockfileVersion 1: a nested dependencies tree.
    const walk = (deps) => {
      for (const [name, v] of Object.entries(deps || {})) {
        if (v && !(v.version || '').includes(':')) add(name, v.version);
        walk(v && v.dependencies);
      }
    };
    if (!lock.packages) walk(lock.dependencies);
  } else if (file.endsWith('pnpm-lock.yaml')) {
    // Package keys sit at two spaces under packages:/snapshots: ("/name@1.2.3", "name@1.2.3(peer)").
    for (const m of text.matchAll(/^ {2}['"]?\/?((?:@[^/\s'"]+\/)?[^@\s'"/]+)@(\d+\.\d+\.\d+[^(:'"\s]*)/gm)) add(m[1], m[2]);
  } else if (file.endsWith('bun.lock')) {
    for (const m of text.matchAll(/^\s*"[^"]+": \["((?:@[^@"/]+\/)?[^@"]+)@(\d[^"]*)"/gm)) add(m[1], m[2]);
  } else {
    // yarn v1 ("name@^1", "name@~1":) and berry ("name@npm:^1":), version on a following line.
    // An alias ("local@npm:real@^1") installs `real`: advisories belong to that name, never to
    // the local one (a squatted package can carry the local name and a malware advisory).
    const realName = (p) => {
      const local = p.slice(0, p.indexOf('@', 1));
      const alias = p.slice(local.length + 1).match(/^npm:((?:@[^@/]+\/)?[^@]+)@/);
      return alias ? alias[1] : local;
    };
    let names = null;
    let version = null;
    const flush = () => {
      if (names && version) for (const n of new Set(names)) add(n, version);
      names = null;
      version = null;
    };
    for (const line of text.split('\n')) {
      if (/^\S.*:\s*$/.test(line) && !line.startsWith('#') && !line.startsWith('__metadata')) {
        flush();
        names = line
          .replace(/:\s*$/, '')
          .split(/,\s*/)
          .map((p) => p.trim().replace(/^"|"$/g, ''))
          .filter((p) => !/@(?:patch|workspace|link|file|portal|exec|git\+|https?):/.test(p.slice(1)))
          .map(realName);
        continue;
      }
      if (!names) continue;
      const ver = line.match(/^\s+version:?\s+"?([0-9][^"\s]*)"?/);
      if (ver) version = ver[1];
      // berry names the package actually installed: "@swc/helpers@npm:0.4.14".
      const res = line.match(/^\s+resolution:\s+"((?:@[^@/"]+\/)?[^@"]+)@npm:/);
      if (res) names = [res[1]];
    }
    flush();
  }
  return { file, packages };
}
