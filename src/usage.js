import fs from 'node:fs';
import path from 'node:path';
import { findPackageDir } from './project.js';

// Finds runtime dependencies that nothing uses. A package only counts as unused when it is
// (1) never imported from JS/TS, (2) not referenced from native code, (3) not required by
// another dependency (e.g. @rneui/themed needs @rneui/base even if the app never imports it),
// and (4) not mentioned in config files or package.json scripts. Removing unused native
// modules is the cheapest way to shrink an upgrade.

const SKIP_DIRS = new Set(['node_modules', '.git', 'Pods', 'build', '.gradle', 'DerivedData', '.expo', 'dist', 'coverage', 'vendor']);
const JS_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const NATIVE_EXT = new Set(['.m', '.mm', '.h', '.swift', '.java', '.kt', '.gradle', '.kts', '.xml', '.plist']);
const MAX_FILE_BYTES = 1024 * 1024;

// Packages that are used without being imported.
const IMPLICIT = [
  /^(react|react-native|expo|react-dom)$/,
  /^@babel\//,
  /^@types\//,
  /babel-plugin|babel-preset|eslint|prettier|typescript|metro/,
  /^@react-native\//, // versioned with React Native, used by the build
  /^@react-native-community\/cli/,
  /^react-native-vector-icons$/, // fonts linked by the build
  // Work by being installed: native auto-registration or compiler output.
  /^react-native-webp-format$/, // iOS WebP decoder registers itself with the image loader
  /^@react-native-firebase\/(crashlytics|perf)$/, // collect natively without any JS call
  /^react-compiler-runtime$/, // imported by babel-plugin-react-compiler output
  /^@react-native-vector-icons\//, // per-font packages: fonts linked by the build
  /^(hermes-engine|postinstall-postinstall|react-native-web)$/, // engine, install hook, web target
  // Named after Node.js core modules: dependencies require('stream'), Metro resolves the package.
  /^(assert|buffer|constants|crypto|events|os|path|process|punycode|querystring|stream|string_decoder|timers|tty|url|util|vm|zlib)$/,
];

function walk(dir, exts, out = []) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of list) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), exts, out);
    } else if (exts.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const readSmall = (file) => {
  try {
    return fs.statSync(file).size > MAX_FILE_BYTES ? '' : fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// 'lodash/fp' -> 'lodash', '@scope/pkg/sub' -> '@scope/pkg'
export function packageOf(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function importedPackages(text) {
  const found = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:\.resolve)?\s*\(\s*|\bjest\.(?:mock|requireActual)\s*\(\s*)['"]([^'"\n]+)['"]/g;
  for (const m of text.matchAll(re)) {
    const pkg = packageOf(m[1]);
    if (pkg) found.add(pkg);
  }
  return found;
}

// Names a package is known by in native code: its podspec module and its Android namespace.
function nativeTokens(root, name) {
  const dir = findPackageDir(root, name);
  if (!dir) return [];
  const tokens = [];
  try {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.podspec')) tokens.push(f.replace(/\.podspec$/, ''));
  } catch {
    // no podspec
  }
  const manifest = readSmall(path.join(dir, 'android', 'src', 'main', 'AndroidManifest.xml'));
  const gradle = readSmall(path.join(dir, 'android', 'build.gradle')) + readSmall(path.join(dir, 'android', 'build.gradle.kts'));
  const pkg = manifest.match(/package="([\w.]+)"/) || gradle.match(/namespace\s*=?\s*["']([\w.]+)["']/);
  if (pkg) tokens.push(pkg[1]);
  return tokens.filter((t) => t.length >= 5);
}

export function findUnused(project) {
  if (!project.hasNodeModules) return [];
  const root = project.root;
  const names = Object.keys(project.deps).filter((n) => !IMPLICIT.some((re) => re.test(n)));
  if (!names.length) return [];

  const used = new Set();
  for (const file of walk(root, JS_EXT)) for (const p of importedPackages(readSmall(file))) used.add(p);

  // Config and scripts: babel/metro/app config plugins, CLI tools in scripts.
  const pkgText = readSmall(path.join(root, 'package.json'));
  const pkgJson = JSON.parse(pkgText || '{}');
  const configText = [
    JSON.stringify(pkgJson.scripts || {}),
    JSON.stringify(pkgJson.jest || {}),
    // rn-nodeify style aliases: { "react-native": { "crypto": "react-native-crypto" } }
    JSON.stringify(pkgJson['react-native'] || {}),
    JSON.stringify(pkgJson.browser || {}),
    readSmall(path.join(root, 'app.json')),
    readSmall(path.join(root, 'app.config.js')),
    readSmall(path.join(root, 'app.config.ts')),
    readSmall(path.join(root, 'react-native.config.js')),
    // metro/babel/jest config and friends: aliases such as `crypto: 'crypto-browserify'`.
    ...fs
      .readdirSync(root)
      .filter((f) => /\.config\.[cm]?[jt]s$|^\.babelrc|^rn-cli\.config/.test(f))
      .map((f) => readSmall(path.join(root, f))),
  ].join('\n');
  // CLI tools run from scripts by their command name, which can differ from the package name.
  const scriptText = JSON.stringify(pkgJson.scripts || {});
  const usedByBin = (name) => {
    const dir = findPackageDir(root, name);
    try {
      const bin = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).bin;
      const bins = typeof bin === 'string' ? [name.split('/').pop()] : Object.keys(bin || {});
      return bins.some((b) => scriptText.includes(b));
    } catch {
      return false;
    }
  };

  // Required by any installed package (peer or regular), including indirect ones: e.g.
  // @react-navigation/elements, pulled in by the stack navigator, peers on masked-view.
  const requiredByOthers = new Set();
  for (const manifest of installedManifests(root)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      for (const k of ['peerDependencies', 'dependencies']) for (const d of Object.keys(m[k] || {})) requiredByOthers.add(d);
    } catch {
      // unreadable manifest
    }
  }

  // A package someone patched (patch-package) is one they care about: never call it unused.
  const patched = new Set();
  try {
    for (const f of fs.readdirSync(path.join(root, 'patches'))) {
      const m = f.match(/^(@[^+]+\+[^+]+|[^+@][^+]*)\+/);
      if (m) patched.add(m[1].replace('+', '/'));
    }
  } catch {
    // no patches folder
  }

  const candidates = names.filter((n) => !used.has(n) && !requiredByOthers.has(n) && !configText.includes(n) && !usedByBin(n) && !patched.has(n));
  if (!candidates.length) return [];

  const nativeText = ['ios', 'android'].flatMap((d) => walk(path.join(root, d), NATIVE_EXT)).map(readSmall).join('\n');
  return candidates
    .filter((n) => !nativeText.includes(n) && !nativeTokens(root, n).some((t) => nativeText.includes(t)))
    .map((name) => ({ name, native: nativeTokens(root, name).length > 0 }));
}

// package.json of every package in the node_modules folders from the app up to the filesystem
// root (monorepos hoist), one level of scopes deep. Nested node_modules are skipped.
function installedManifests(root) {
  const out = [];
  let dir = root;
  while (true) {
    const nm = path.join(dir, 'node_modules');
    let entries = [];
    try {
      entries = fs.readdirSync(nm, { withFileTypes: true });
    } catch {
      // none here
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith('@')) {
        try {
          for (const sub of fs.readdirSync(path.join(nm, e.name))) out.push(path.join(nm, e.name, sub, 'package.json'));
        } catch {
          // unreadable scope
        }
      } else if (!e.name.startsWith('.')) {
        out.push(path.join(nm, e.name, 'package.json'));
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

// Source files (relative paths) that import `pkg` and whose text matches `pattern`.
export function filesImportingWith(root, pkg, pattern) {
  const re = new RegExp(pattern);
  const out = [];
  for (const file of walk(root, JS_EXT)) {
    const text = readSmall(file);
    if (!text.includes(pkg) || !importedPackages(text).has(pkg)) continue;
    if (re.test(text)) out.push(path.relative(root, file));
  }
  return out.sort();
}
