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

export function loadProject(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) throw new Error(`No package.json found in ${root}`);
  const deps = { ...(pkg.dependencies || {}) };
  // Monorepos often keep react-native in devDependencies; autolinking still links native modules from there.
  const devDeps = { ...(pkg.devDependencies || {}) };
  const declared = (name) => deps[name] || devDeps[name];
  if (!declared('react-native') && !declared('expo')) {
    throw new Error('This does not look like a React Native app (no react-native or expo dependency). Run it inside your app folder.');
  }

  const hasAndroid = fs.existsSync(path.join(root, 'android'));
  const hasIos = fs.existsSync(path.join(root, 'ios'));
  const appConfig = readJson(path.join(root, 'app.json'));

  return {
    root,
    name: pkg.name,
    deps,
    devDeps,
    rnVersion: cleanVersion(installedVersion(root, 'react-native') || declared('react-native') || ''),
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
