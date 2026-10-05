import fs from 'node:fs';
import path from 'node:path';

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const readJson = (file) => {
  const text = readText(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export function cleanVersion(v) {
  const m = String(v).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? `${m[1]}.${m[2]}.${m[3] || 0}` : null;
}

// Monorepos hoist packages, so look in every node_modules from the app up to the filesystem root.
export function findPackageDir(root, name) {
  let dir = root;
  while (true) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function installedVersion(root, name) {
  const dir = findPackageDir(root, name);
  const pkg = dir && readJson(path.join(dir, 'package.json'));
  return pkg ? pkg.version : null;
}

// pnpm and Bun "catalogs": a dependency declared as `catalog:` or `catalog:<name>` takes its
// version from the workspace root (pnpm-workspace.yaml, or package.json `workspaces.catalog`).
// Returns { default: {pkg: range}, <name>: {...} } or null.
export function readCatalogs(root) {
  let dir = root;
  while (true) {
    const yaml = readText(path.join(dir, 'pnpm-workspace.yaml'));
    if (yaml) return parsePnpmCatalogs(yaml);
    const pkg = dir !== root ? readJson(path.join(dir, 'package.json')) : null;
    const ws = pkg && pkg.workspaces && !Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg;
    if (ws && (ws.catalog || ws.catalogs)) return { default: ws.catalog || {}, ...(ws.catalogs || {}) };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Just enough YAML for the two catalog sections: `catalog:` and `catalogs: <name>:` maps of
// "package": version lines. Anything else in the file is ignored.
function parsePnpmCatalogs(text) {
  const out = { default: {} };
  let section = null; // 'default' or a named catalog
  let inCatalogs = false;
  const unquote = (v) => v.trim().replace(/^["']|["']$/g, '');
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^("[^"]+"|'[^']+'|[^:\s]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = unquote(m[1]);
    const value = m[2];
    if (indent === 0) {
      inCatalogs = key === 'catalogs';
      section = key === 'catalog' ? 'default' : null;
    } else if (inCatalogs && !value) {
      section = key;
      out[section] = out[section] || {};
    } else if (section && value) {
      out[section][key] = unquote(value);
    }
  }
  return out;
}

function resolveCatalogRefs(deps, catalogs) {
  if (!catalogs) return deps;
  const out = { ...deps };
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('catalog:')) continue;
    const which = spec.slice('catalog:'.length) || 'default';
    const version = catalogs[which] && catalogs[which][name];
    if (version) out[name] = version;
  }
  return out;
}

// Expo SDKs up to 44 installed React Native from Expo's fork, declared as a tarball URL such as
// https://github.com/expo/react-native/archive/sdk-37.0.1.tar.gz. The number there is the SDK,
// not React Native. React Native version per SDK, from Expo's SDK history.
const EXPO_FORK_RN = { 31: '0.57.1', 32: '0.57.1', 33: '0.59.8', 34: '0.59.8', 35: '0.59.8', 36: '0.61.4', 37: '0.61.4', 38: '0.62.2', 39: '0.63.2', 40: '0.63.2', 41: '0.63.2', 42: '0.63.2', 43: '0.64.3', 44: '0.64.3' };

// A version number from a dependency spec, or null when the spec is a URL or git reference
// whose numbers are not the package version.
export function versionFromSpec(name, spec) {
  if (!spec) return null;
  const s = String(spec);
  if (/:\/\/|^(github|git|file|link|workspace):|#|\.tgz$|\.tar\.gz$/.test(s)) {
    const sdk = name === 'react-native' && s.match(/expo\/react-native\/archive\/sdk-(\d+)/);
    return sdk && EXPO_FORK_RN[Number(sdk[1])] ? EXPO_FORK_RN[Number(sdk[1])] : null;
  }
  return s;
}

export function loadProject(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) throw new Error(`No package.json found in ${root}`);
  const usesCatalog = JSON.stringify([pkg.dependencies, pkg.devDependencies]).includes('"catalog:');
  const catalogs = usesCatalog ? readCatalogs(root) : null;
  const deps = resolveCatalogRefs({ ...(pkg.dependencies || {}) }, catalogs);
  // Monorepos often keep react-native in devDependencies; autolinking still links native modules from there.
  const devDeps = resolveCatalogRefs({ ...(pkg.devDependencies || {}) }, catalogs);
  const declared = (name) => deps[name] || devDeps[name];
  if (!declared('react-native') && !declared('expo')) {
    throw new Error('This does not look like a React Native app (no react-native or expo dependency). Run it inside your app folder.');
  }

  const hasAndroid = fs.existsSync(path.join(root, 'android'));
  const hasIos = fs.existsSync(path.join(root, 'ios'));
  const appConfig = readJson(path.join(root, 'app.json'));

  // A React Native library (or an example inside one) is not an app: store checks do not apply.
  const androidGradle = readText(path.join(root, 'android', 'build.gradle')) || '';
  const isLibrary =
    !!(pkg.peerDependencies && pkg.peerDependencies['react-native']) ||
    /apply plugin:\s*['"]com\.android\.library['"]|id\s*\(?\s*['"]com\.android\.library['"]/.test(androidGradle);

  return {
    root,
    name: pkg.name,
    isLibrary,
    deps,
    devDeps,
    rnVersion: cleanVersion(installedVersion(root, 'react-native') || versionFromSpec('react-native', declared('react-native')) || ''),
    expoVersion: declared('expo') ? cleanVersion(installedVersion(root, 'expo') || declared('expo')) : null,
    // Expo "managed" apps generate android/ and ios/ at build time (Continuous Native Generation).
    managed: !!declared('expo') && !hasAndroid && !hasIos,
    hasNodeModules: !!findPackageDir(root, 'react-native'),
    newArch: detectNewArch(root, appConfig),
    android: hasAndroid ? detectAndroid(root) : null,
  };
}

// Returns { android, ios } with true / false / null (not set, so the React Native default applies)
function detectNewArch(root, appConfig) {
  const result = { android: null, ios: null };

  const gradle = readText(path.join(root, 'android', 'gradle.properties'));
  const g = gradle && gradle.match(/^\s*newArchEnabled\s*=\s*(true|false)/m);
  if (g) result.android = g[1] === 'true';

  const podProps = readJson(path.join(root, 'ios', 'Podfile.properties.json'));
  if (podProps && podProps.newArchEnabled !== undefined) result.ios = String(podProps.newArchEnabled) === 'true';

  const podfile = readText(path.join(root, 'ios', 'Podfile'));
  const p = podfile && podfile.match(/RCT_NEW_ARCH_ENABLED'?\]?\s*=\s*'?([01]|true|false)/);
  if (p && result.ios === null) result.ios = p[1] === '1' || p[1] === 'true';

  const expo = appConfig && appConfig.expo;
  if (expo) {
    const flag = (platform) =>
      expo[platform] && expo[platform].newArchEnabled !== undefined ? expo[platform].newArchEnabled : expo.newArchEnabled;
    for (const platform of ['android', 'ios']) {
      if (result[platform] === null && flag(platform) !== undefined) result[platform] = !!flag(platform);
    }
  }
  return result;
}

// Reads targetSdk / compileSdk from the usual places: root ext block or app/build.gradle(.kts).
function detectAndroid(root) {
  const files = ['build.gradle', 'build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts']
    .map((f) => readText(path.join(root, 'android', f)))
    .filter(Boolean)
    .join('\n');
  const num = (key) => {
    const m = files.match(new RegExp(`\\b${key}(?:Version)?\\s*=?\\s*(\\d{2})\\b`));
    return m ? Number(m[1]) : null;
  };
  return { targetSdk: num('targetSdk'), compileSdk: num('compileSdk'), minSdk: num('minSdk') };
}
