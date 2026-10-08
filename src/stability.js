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
    // npm 7+ and pnpm install peer dependencies on their own: if the lockfile (or node_modules)
    // already has it, the app has it.
    const lockHasWorklets = () =>
      fs.existsSync(path.join(project.root, 'node_modules', 'react-native-worklets')) ||
      ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock'].some((f) => /(?:node_modules\/|["'\s/])react-native-worklets(?:@|["':])/.test(readText(path.join(project.root, f)) || ''));
    if (majorOf(rea) >= 4 && !deps['react-native-worklets'] && !lockHasWorklets()) {
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
  for (const f of removedCoreImports(project)) add(f);
  if (!project.isLibrary) for (const f of releaseDevServer(project)) add(f);
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

// Components and APIs that left React Native core. Importing them from 'react-native' throws
// ("X has been removed from react-native core", checked in RN's index.js for 0.72-0.76) or, from
// 0.74 for the PropTypes and later for the rest, is simply undefined: a crash on first use.
const REMOVED_FROM_CORE = {
  AsyncStorage: '@react-native-async-storage/async-storage',
  NetInfo: '@react-native-community/netinfo',
  WebView: 'react-native-webview',
  Slider: '@react-native-community/slider',
  ListView: 'FlatList or SectionList (core)',
  SwipeableListView: 'FlatList with a swipeable row library',
  CameraRoll: '@react-native-camera-roll/camera-roll',
  ImageEditor: '@react-native-community/image-editor',
  ImageStore: 'expo-file-system or react-native-blob-util',
  TimePickerAndroid: '@react-native-community/datetimepicker',
  DatePickerAndroid: '@react-native-community/datetimepicker',
  DatePickerIOS: '@react-native-community/datetimepicker',
  ToolbarAndroid: '@react-native-community/toolbar-android',
  ViewPagerAndroid: 'react-native-pager-view',
  CheckBox: '@react-native-community/checkbox',
  SegmentedControlIOS: '@react-native-segmented-control/segmented-control',
  StatusBarIOS: 'StatusBar (core)',
  Picker: '@react-native-picker/picker',
  PickerIOS: '@react-native-picker/picker',
  MaskedViewIOS: '@react-native-masked-view/masked-view',
  ImagePickerIOS: 'react-native-image-picker',
  ProgressViewIOS: '@react-native-community/progress-view',
  ART: 'react-native-svg',
};
const REMOVED_PROP_TYPES = ['ViewPropTypes', 'ColorPropType', 'EdgeInsetsPropType', 'PointPropType'];
// Deprecated in core and announced for removal (RN index.js warnOnce, checked 0.78-0.87).
// They still work; moving now avoids a crash when they are removed.
const DEPRECATED_IN_CORE = {
  SafeAreaView: { since: 81, use: 'react-native-safe-area-context' },
  ImageBackground: { since: 87, use: 'a View with an absolutely positioned Image' },
  DrawerLayoutAndroid: { since: 87, use: 'react-native-drawer-layout' },
  UTFSequence: { since: 87, use: "Unicode escapes written directly (e.g. '\\ufeff')" },
};

export function removedCoreImports(project) {
  const root = project.root;
  const used = new Map(); // name -> first file:line
  const referenced = new Set(); // used beyond the import line
  const deprecated = new Map();
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!['node_modules', '.git', 'android', 'ios', 'build', 'dist', '.expo', 'coverage', '__tests__', '__mocks__'].includes(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name));
      } else if (/\.[cm]?[jt]sx?$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  for (const file of files) {
    const text = readText(file) || '';
    if (!text.includes("'react-native'") && !text.includes('"react-native"')) continue;
    const blocks = [
      ...[...text.matchAll(/import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]react-native['"]/g)].map((m) => ({ names: m[1], index: m.index, length: m[0].length })),
      ...[...text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]react-native['"]\s*\)/g)].map((m) => ({ names: m[1], index: m.index, length: m[0].length })),
    ];
    for (const b of blocks) {
      for (const raw of b.names.split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        const at = () => `${path.relative(root, file)}:${text.slice(0, b.index).split('\n').length}`;
        if ((REMOVED_FROM_CORE[name] || REMOVED_PROP_TYPES.includes(name)) && !used.has(name)) used.set(name, at());
        // Referenced anywhere besides the import itself? An import alone is harmless (undefined).
        if (REMOVED_FROM_CORE[name] || REMOVED_PROP_TYPES.includes(name)) {
          const rest = text.slice(0, b.index) + text.slice(b.index + b.length);
          if (new RegExp(`\\b${name}\\b`).test(rest.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))) referenced.add(name);
        }
        if (DEPRECATED_IN_CORE[name] && !deprecated.has(name)) deprecated.set(name, at());
      }
    }
  }
  const minor = project.rnVersion ? Number(project.rnVersion.split('.')[1]) : null;
  const findings = [];
  if (deprecated.size) {
    const names = [...deprecated.keys()];
    const warnsNow = minor !== null && names.some((n) => minor >= DEPRECATED_IN_CORE[n].since);
    // Core SafeAreaView only ever applied to iOS. Targeting API 35+ (Expo SDK 52+ does), Android 15
    // draws edge-to-edge, so those screens slide under the status bar today.
    const target = project.android && project.android.targetSdk;
    const expoMajor = project.expoVersion ? Number(String(project.expoVersion).split('.')[0]) : null;
    const edgeToEdge = deprecated.has('SafeAreaView') && ((target && target >= 35) || (!target && expoMajor !== null && expoMajor >= 52));
    findings.push({
      id: 'deprecated-core-imports',
      severity: edgeToEdge ? 'medium' : 'low',
      area: 'react-native',
      title: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} deprecated in React Native core and will be removed`,
      detail: `${[...deprecated].map(([n, at]) => `${n} (${at}, deprecated in 0.${DEPRECATED_IN_CORE[n].since}) → ${DEPRECATED_IN_CORE[n].use}`).join('; ')}. ${warnsNow ? 'They already log a deprecation warning.' : 'They start logging a warning when you upgrade.'} Once removed, the import returns undefined and the screen crashes, so move off them while it is a small change.${edgeToEdge ? ' SafeAreaView also does nothing on Android: with your target SDK, Android 15 and newer draw the app edge-to-edge, so those screens already sit under the status bar there. react-native-safe-area-context handles both platforms.' : ''}`,
      fix: { kind: 'deprecated-core', step: `Replace ${names.map((n) => `\`${n}\` (→ ${DEPRECATED_IN_CORE[n].use})`).join(', ')} before React Native removes ${names.length === 1 ? 'it' : 'them'}.` },
    });
  }
  if (!used.size) return findings;
  const removedNow = (n) => (REMOVED_PROP_TYPES.includes(n) ? minor >= 74 : minor >= 72);
  const crashesNow = [...used.keys()].some((n) => removedNow(n) && referenced.has(n));
  const importOnly = [...used.keys()].every((n) => !referenced.has(n));
  const list = [...used].map(([n, at]) => `${n} (${at}${referenced.has(n) ? '' : ', imported but not used'}) → ${REMOVED_FROM_CORE[n] || 'deprecated-react-native-prop-types'}`);
  return [
    ...findings,
    {
      id: 'crash-removed-core-imports',
      severity: crashesNow ? 'high' : importOnly ? 'low' : 'medium',
      area: 'crash',
      title: importOnly
        ? `${used.size} unused import${used.size === 1 ? '' : 's'} of APIs removed from React Native core`
        : `${used.size} import${used.size === 1 ? '' : 's'} of APIs removed from React Native core${crashesNow ? '' : ' (they break when you upgrade)'}`,
      detail: `${list.slice(0, 6).join('; ')}${list.length > 6 ? '; …' : ''}. On current React Native these imports are undefined in release builds (development builds throw "has been removed from react-native core"), so ${importOnly ? 'an import that is never used is harmless: delete it' : 'the code that calls them fails at that point. Install the replacement and change the import'}.`,
      fix: { kind: 'crash', step: `Move ${[...used.keys()].map((n) => `\`${n}\``).join(', ')} off 'react-native' to their community packages (${[...new Set([...used.keys()].map((n) => REMOVED_FROM_CORE[n] || 'deprecated-react-native-prop-types'))].slice(0, 4).join(', ')}).` },
    },
  ];
}

// A release build that talks to a development server: the Android emulator's host alias
// (10.0.2.2), a LAN address, localhost or an ngrok tunnel used as the API address outside any
// dev-only branch. On users' phones that address does not exist, so the app cannot reach its
// backend. Settings screens, placeholders and defaults the user can change are left alone.
const DEV_HOST = /['"`](https?:\/\/(?:localhost|127\.0\.0\.1|10\.0\.2\.2|10\.0\.3\.2|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.ngrok(?:-free)?\.(?:io|app|dev)|[\w-]+\.loca\.lt)(?::\d+)?[^'"`\s]*)['"`]/g;
const DEV_BRANCH = /__DEV__|NODE_ENV|isDev\b|IS_DEV|\bdev(?:elopment)?\b|\bDev[A-Z]\w*|_DEV\b|\bDEV_|Platform\.OS|debug/i;
const API_USE = /(?:base_?url|api_?url|api_?base|server_?url|backend_?url|endpoint|host_?url|socket_?url|graphql|uri)\b\s*[:=]\s*$|(?:fetch|axios(?:\.\w+)?|io|create\w*|new\s+WebSocket|EventSource)\s*\(\s*$/i;

export function releaseDevServer(project) {
  const root = project.root;
  const SKIP = new Set(['node_modules', '.git', 'android', 'ios', 'build', 'dist', 'Pods', '__tests__', '__mocks__', 'e2e', 'detox', '.expo', 'coverage', 'vendor', 'scripts', 'server', 'backend', 'functions', 'test', 'tests', 'mocks', 'storybook', 'docs', 'example', 'examples', 'cli', 'admin', 'admin-dashboard', 'dashboard', 'web']);
  const files = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < 8 && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
      } else if (/\.[cm]?[jt]sx?$/.test(e.name) && !/\.(?:test|spec|stories|config|web)\.|(?:mock|fixture|dev|debug|local)/i.test(e.name)) files.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  for (const file of files) {
    if (/settings|setup|onboarding|preferences/i.test(path.relative(root, file))) continue;
    const text = readText(file);
    if (!text || !/localhost|127\.0\.0\.1|10\.\d|192\.168|172\.|ngrok|loca\.lt/.test(text)) continue;
    if (/^\s*['"]use server['"]/m.test(text)) continue; // Expo Router server code never ships to phones
    // Comments blanked out with spaces: positions stay the same as in `text`.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:])(\/\/[^\n]*)/g, (all, pre, c) => pre + ' '.repeat(c.length));
    for (const m of code.matchAll(DEV_HOST)) {
      if (/^https:\/\/localhost\/?$/.test(m[1])) continue; // a WebView base URL, not a server
      const before = code.slice(Math.max(0, m.index - 300), m.index);
      const line = code.slice(code.lastIndexOf('\n', m.index) + 1, code.indexOf('\n', m.index) + 1 || undefined);
      if (DEV_BRANCH.test(before) || /placeholder|default\w*\s*[:=]|example|hint|label/i.test(line + before.slice(-120))) continue;
      // A named local fallback (LOCAL_API_URL used when the configured one is missing) and
      // probes for a local service (auto-detect Ollama) are deliberate.
      if (/\b\w*(?:LOCAL|EMULATOR|SIMULATOR|FALLBACK)\w*\s*[:=]\s*$/i.test(before.slice(-80)) || /detect|probe|discover|fallback|ollama/i.test(text.slice(Math.max(0, m.index - 200), m.index))) continue;
      if (!API_USE.test(before.slice(-120))) continue;
      const rel = path.relative(root, file);
      const at = `${rel}:${code.slice(0, m.index).split('\n').length}`;
      return [
        {
          id: 'release-dev-server',
          severity: 'high',
          area: 'crash',
          title: `The app talks to a development server in release builds (${m[1].slice(0, 40)}, ${at})`,
          detail: `${m[1]} is used as an API address outside any development-only branch. ${/10\.0\.[23]\.2/.test(m[1]) ? 'It is the Android emulator\'s name for your computer' : /ngrok|loca\.lt/.test(m[1]) ? 'It is a temporary tunnel to your computer' : /localhost|127\.0\.0\.1/.test(m[1]) ? 'On a phone, localhost is the phone itself' : 'It is an address on your local network'}, so on users' phones every call fails. Read the API address from build configuration (EXPO_PUBLIC_API_URL, react-native-config) with the production URL for release builds.`,
          fix: { kind: 'crash', step: `Replace \`${m[1].slice(0, 40)}\` in \`${at}\` with the production API address from build configuration, keeping local addresses for development builds only.` },
        },
      ];
    }
  }
  return [];
}
