import fs from 'node:fs';
import path from 'node:path';
import { cleanVersion, findPackageDir, installedVersion, versionFromSpec } from './project.js';
import { filesImportingWith } from './usage.js';

// Static checks for setups that build fine and then crash at runtime. Each one is a known,
// documented failure, not a style preference.

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const majorOf = (v) => (v ? Number(String(v).split('.')[0]) : null);

// The app's Babel config, or the workspace root's (monorepos keep babel.config.js at the root).
// null when none is found: then nothing can be said about plugins.
function babelConfig(root, pkgJson) {
  const files = ['babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json', '.babelrc', '.babelrc.js', '.babelrc.json'];
  let dir = root;
  let texts = [];
  while (true) {
    texts = files.map((f) => readText(path.join(dir, f))).filter(Boolean);
    if (texts.length || fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  root = dir;
  if (pkgJson.babel) texts.push(JSON.stringify(pkgJson.babel));
  // Shared config pulled in with require('./config/babel-shared') and the like.
  for (const t of [...texts]) {
    for (const m of t.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const base = path.join(root, m[1]);
      const text = [base, `${base}.js`, `${base}.cjs`, `${base}.json`].map(readText).find(Boolean);
      if (text) texts.push(text);
    }
  }
  return texts.length ? texts.join('\n') : null;
}

export function stabilityChecks(project) {
  const findings = [];
  const add = (f) => findings.push(f);
  const root = project.root;
  const pkgJson = JSON.parse(readText(path.join(root, 'package.json')) || '{}');
  const deps = { ...project.devDeps, ...project.deps };
  const versionOf = (name) => cleanVersion(installedVersion(root, name) || versionFromSpec(name, deps[name]) || '');

  // Reanimated needs its Babel plugin: without it, worklets are not compiled and the first
  // animation throws ("Failed to create a worklet" / "Reanimated 2 failed to create a worklet").
  // babel-preset-expo adds it automatically.
  if (deps['react-native-reanimated']) {
    const rea = versionOf('react-native-reanimated');
    const babel = babelConfig(root, pkgJson);
    const expoPreset = babel ? /babel-preset-expo/.test(babel) : !!project.expoVersion;
    const hasPlugin = !babel || /react-native-reanimated\/plugin|react-native-worklets\/plugin/.test(babel);
    // Reanimated 2 also runs the v1 API, which needs no plugin: only flag it when the app uses
    // worklet APIs. From 3 on the plugin is always required.
    const needsPlugin =
      majorOf(rea) >= 3 ||
      (majorOf(rea) === 2 && filesImportingWith(root, 'react-native-reanimated', "useSharedValue|useAnimatedStyle|useDerivedValue|useAnimatedScrollHandler|runOnJS|runOnUI|['\"]worklet['\"]").length > 0);
    if (!expoPreset && !hasPlugin && needsPlugin) {
      const plugin = majorOf(rea) >= 4 ? 'react-native-worklets/plugin' : 'react-native-reanimated/plugin';
      add({
        id: 'crash-reanimated-babel',
        severity: 'high',
        area: 'crash',
        title: `Reanimated ${rea} without its Babel plugin`,
        detail: `Worklets are compiled by \`${plugin}\`; without it the first animation throws at runtime ("Failed to create a worklet"). Add it as the last entry of \`plugins\` in your Babel config, then restart Metro with \`--reset-cache\`.`,
        fix: { kind: 'crash', step: `Add \`'${plugin}'\` as the last Babel plugin, then \`npx react-native start --reset-cache\`.` },
      });
    }
    // Reanimated 4 moved worklets into a separate package that must be installed by the app.
    if (majorOf(rea) >= 4 && !deps['react-native-worklets']) {
      add({
        id: 'crash-reanimated-worklets',
        severity: 'high',
        area: 'crash',
        title: `Reanimated ${rea} needs react-native-worklets`,
        detail: 'Reanimated 4 depends on react-native-worklets as a peer: without it the native build fails or the app crashes on start. Install the version Reanimated\'s compatibility table lists for your React Native version.',
        fix: { kind: 'crash', step: `Install \`react-native-worklets\` (${project.expoVersion ? '`npx expo install react-native-worklets`' : 'the version that matches Reanimated'}).` },
      });
    }
  }

  // React Native Firebase: every @react-native-firebase/* package must be on the same version.
  // Mixed versions fail to build or crash on start (native SDK version conflicts).
  const rnfb = Object.keys(deps).filter((n) => n.startsWith('@react-native-firebase/'));
  if (rnfb.length > 1) {
    const versions = Object.fromEntries(rnfb.map((n) => [n, versionOf(n)]).filter(([, v]) => v));
    const majors = new Set(Object.values(versions).map(majorOf));
    if (majors.size > 1) {
      add({
        id: 'crash-firebase-versions',
        severity: 'high',
        area: 'crash',
        title: 'React Native Firebase packages are on different major versions',
        detail: `${Object.entries(versions).map(([n, v]) => `${n} ${v}`).join(', ')}. They share one native Firebase SDK and must all be on the same version; mixed majors fail to build or crash at startup.`,
        fix: { kind: 'crash', step: 'Move every `@react-native-firebase/*` package to the same version (the same as `@react-native-firebase/app`).' },
      });
    }
  }

  // React Navigation: navigators and @react-navigation/native must share a major version.
  // elements, devtools, web and compat follow their own version numbers.
  const navOwnVersions = new Set(['@react-navigation/elements', '@react-navigation/devtools', '@react-navigation/web', '@react-navigation/compat']);
  const nav = Object.keys(deps).filter((n) => n.startsWith('@react-navigation/') && !navOwnVersions.has(n));
  if (nav.length > 1) {
    const versions = Object.fromEntries(nav.map((n) => [n, versionOf(n)]).filter(([, v]) => v));
    const majors = new Set(Object.values(versions).map(majorOf));
    if (majors.size > 1) {
      add({
        id: 'crash-navigation-versions',
        severity: 'high',
        area: 'crash',
        title: 'React Navigation packages are on different major versions',
        detail: `${Object.entries(versions).map(([n, v]) => `${n} ${v}`).join(', ')}. Navigators from one major do not work with the core of another; this usually crashes on the first navigation ("Couldn't find a navigation context" or undefined functions).`,
        fix: { kind: 'crash', step: 'Move every `@react-navigation/*` package to the same major version, following its migration guide.' },
      });
    }
  }

  // A second copy of react or react-native inside a dependency: "Invalid hook call" or
  // duplicate native module registration at runtime.
  if (project.hasNodeModules) {
    for (const core of ['react', 'react-native']) {
      const rootVersion = installedVersion(root, core);
      const nm = findPackageDir(root, core) ? path.dirname(findPackageDir(root, core)) : null;
      if (!nm || !rootVersion) continue;
      const copies = [];
      // Only runtime dependencies end up in the bundle (Storybook and @types copies do not).
      const runtime = new Set(Object.keys(project.deps).filter((n) => !n.startsWith('@types/')));
      for (const dep of listPackages(nm).filter((d) => runtime.has(d))) {
        const nested = path.join(nm, dep, 'node_modules', core, 'package.json');
        const text = readText(nested);
        if (!text) continue;
        try {
          const v = JSON.parse(text).version;
          if (v && v !== rootVersion) copies.push(`${dep} (${v})`);
        } catch {
          // unreadable
        }
      }
      if (copies.length) {
        add({
          id: `crash-duplicate-${core}`,
          severity: 'high',
          area: 'crash',
          title: `A second copy of ${core} is installed inside ${copies.length === 1 ? 'a dependency' : `${copies.length} dependencies`}`,
          detail: `${copies.slice(0, 5).join(', ')}${copies.length > 5 ? ', …' : ''}, next to ${core} ${rootVersion}. ${core === 'react' ? 'Two Reacts in one bundle crash with "Invalid hook call".' : 'Two copies of React Native register native modules twice and fail at startup.'} Align the dependency's version or deduplicate (resolutions/overrides).`,
          fix: { kind: 'crash', step: `Remove the nested ${core} copies: align versions or add an \`overrides\`/\`resolutions\` entry for \`${core}\`, reinstall, and check with \`npm ls ${core}\`.` },
        });
      }
    }
  }

  for (const f of iosUsageDescriptions(project)) add(f);
  return findings;
}

// Top-level package folder names in a node_modules directory (scoped ones as @scope/name).
function listPackages(nm) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(nm, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      try {
        for (const sub of fs.readdirSync(path.join(nm, e.name))) out.push(`${e.name}/${sub}`);
      } catch {
        // unreadable scope
      }
    } else {
      out.push(e.name);
    }
  }
  return out;
}

// iOS terminates an app that touches a protected resource without the matching usage
// description in Info.plist, and App Review rejects it. Expo managed apps get these from config
// plugins, so only projects with their own ios/ folder are checked.
const USAGE_KEYS = [
  { key: 'NSCameraUsageDescription', what: 'the camera', pkgs: ['react-native-vision-camera', 'react-native-camera', 'expo-camera', 'react-native-camera-kit', 'react-native-qrcode-scanner'] },
  { key: 'NSPhotoLibraryUsageDescription', what: 'the photo library', pkgs: ['@react-native-camera-roll/camera-roll', '@react-native-community/cameraroll', 'expo-media-library', 'react-native-image-crop-picker'] },
  { key: 'NSLocationWhenInUseUsageDescription', what: 'location', pkgs: ['@react-native-community/geolocation', 'react-native-geolocation-service', 'expo-location', 'react-native-background-geolocation', '@mauron85/react-native-background-geolocation'] },
  { key: 'NSMicrophoneUsageDescription', what: 'the microphone', pkgs: ['@react-native-voice/voice', 'react-native-audio-recorder-player', 'expo-audio', 'react-native-audio-record'] },
  { key: 'NSContactsUsageDescription', what: 'contacts', pkgs: ['react-native-contacts', 'expo-contacts'] },
  { key: 'NSCalendarsUsageDescription', what: 'calendars', pkgs: ['react-native-calendar-events', 'expo-calendar'] },
  { key: 'NSBluetoothAlwaysUsageDescription', what: 'Bluetooth', pkgs: ['react-native-ble-plx', 'react-native-ble-manager'] },
  { key: 'NSFaceIDUsageDescription', what: 'Face ID', pkgs: ['react-native-biometrics', '@sbaiahmed1/react-native-biometrics', 'expo-local-authentication', 'react-native-touch-id'] },
];

export function iosUsageDescriptions(project) {
  const iosDir = path.join(project.root, 'ios');
  if (!fs.existsSync(iosDir) || project.managed) return [];
  const plists = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && depth < 2 && !['Pods', 'build', 'DerivedData'].includes(e.name) && !/Tests?$|Extension$|Widget/.test(e.name)) walk(path.join(dir, e.name), depth + 1);
      else if (e.name === 'Info.plist') plists.push(path.join(dir, e.name));
    }
  };
  walk(iosDir, 0);
  if (!plists.length) return [];
  const text = plists.map(readText).join('\n');
  // Expo projects can add the keys at prebuild from app.json/app.config (infoPlist or a config
  // plugin of the same package): count those too.
  const expoConfig = project.expoVersion ? ['app.json', 'app.config.js', 'app.config.ts'].map((f) => readText(path.join(project.root, f)) || '').join('\n') : '';
  const deps = { ...project.deps };
  const missing = [];
  for (const u of USAGE_KEYS) {
    // In Expo projects, prebuild applies the config plugins of installed expo-* packages on its
    // own, and they add default usage strings.
    const used = u.pkgs.filter((p) => deps[p] && !(project.expoVersion && p.startsWith('expo-')));
    if (!used.length) continue;
    const keys = u.key === 'NSPhotoLibraryUsageDescription' ? [u.key, 'NSPhotoLibraryAddUsageDescription'] : [u.key];
    const inPlist = keys.some((k) => text.includes(`<key>${k}</key>`));
    const inExpo = keys.some((k) => expoConfig.includes(k)) || used.some((p) => expoConfig.includes(`"${p}"`) || expoConfig.includes(`'${p}'`));
    if (!inPlist && !inExpo) missing.push({ ...u, used });
  }
  if (!missing.length) return [];
  return [
    {
      id: 'crash-ios-usage-description',
      severity: 'high',
      area: 'crash',
      title: `Info.plist is missing ${missing.length === 1 ? 'a usage description' : `${missing.length} usage descriptions`} (${missing.map((m) => m.key).join(', ')})`,
      detail: `${missing.map((m) => `${m.used[0]} uses ${m.what}`).join('; ')}. iOS terminates the app the moment it asks for access without the matching key, and App Review rejects the build. Add each key with a sentence that says why the app needs it.`,
      fix: { kind: 'crash', step: `Add ${missing.map((m) => `\`${m.key}\``).join(', ')} to the app's Info.plist, each with a user-facing reason.` },
    },
  ];
}
