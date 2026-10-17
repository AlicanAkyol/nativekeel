import fs from './read-boundary.js';
import path from 'node:path';
import { unprefixedReactImports } from './react-headers.js';

// What changes in the React Native and Expo versions ahead of the project, matched against its
// own code: only the changes that touch this app are reported, each with file:line. Includes the
// next version while it is still in beta or release candidate, so the work can be planned early.
// Every entry is copied from the release notes linked in `source` (checked 2026-10-11).

const RN_087 = 'https://reactnative.dev/blog/2026/08/11/react-native-0.87';
const EXPO_58 = 'https://expo.dev/changelog/sdk-58-beta';

// Expo SDK → React Native minor it ships (SDK 58 beta uses 0.88 release candidates).
export const EXPO_RN = { 54: 81, 55: 83, 56: 85, 57: 86, 58: 88 };
// The newest release line we have entries for, and whether it is still a beta / release candidate.
export const NEXT = {
  expo: { sdk: 58, status: 'stable', since: '2026-10-16' },
  rn: { minor: 88, status: 'stable', since: '2026-10-15' },
};

const fromRn = (name) => new RegExp(`import\\s*(?:type\\s*)?(?:[\\w$]+\\s*,\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]react-native['"]`);
const importsFrom = (pkg) => new RegExp(`from\\s*['"]${pkg.replace(/[/.]/g, '\\$&')}(?:/[^'"]*)?['"]|require\\(\\s*['"]${pkg.replace(/[/.]/g, '\\$&')}`);

// kind: 'removed' breaks the build or crashes; 'behavior' changes what the app does; 'tooling'
// needs a newer toolchain or config.
export const CHANGES = [
  // React Native 0.87 (also in Expo SDK 58)
  { id: 'rn87-interaction-manager', rn: 87, kind: 'removed', title: '`InteractionManager` is removed', action: 'Use `requestIdleCallback` (or run the work after the interaction finishes).', code: [fromRn('InteractionManager')], source: RN_087 },
  { id: 'rn87-modal-animated', rn: 87, kind: 'removed', title: 'The `animated` prop of `Modal` is removed', action: 'Use `animationType="slide"` or `"fade"` instead of `animated`.', code: [/<Modal\b[^>]*\sanimated(?:\s*=\s*\{?\s*(?:true|false)\s*\}?)?[\s/>]/], requireCode: fromRn('Modal'), source: RN_087 },
  { id: 'rn87-statusbar-props', rn: 87, kind: 'removed', title: '`StatusBar` `backgroundColor`, `translucent` and `networkActivityIndicatorVisible` (props and setters) are removed', action: 'Remove them from the React Native `StatusBar`: edge-to-edge draws behind the status bar on Android. expo-status-bar is not affected.', code: [/<StatusBar\b[^>]*\b(?:backgroundColor|translucent|networkActivityIndicatorVisible)\b/, /\bStatusBar\.(?:setBackgroundColor|setTranslucent|setNetworkActivityIndicatorVisible)\s*\(/], requireCode: fromRn('StatusBar'), source: RN_087 },
  { id: 'rn87-keyboard-persist-boolean', rn: 87, kind: 'removed', title: '`keyboardShouldPersistTaps` no longer accepts `true`/`false`', action: 'Use `"always"` (was `true`) or `"never"` (was `false`).', code: [/keyboardShouldPersistTaps\s*=\s*\{\s*(?:true|false)\s*\}|keyboardShouldPersistTaps(?=\s*[/>\n]|\s+[a-zA-Z])(?!\s*=)/], source: RN_087 },
  { id: 'rn87-deep-imports', rn: 87, kind: 'removed', title: 'Deep imports from `react-native/Libraries/` are type errors (Strict TypeScript API is the default)', action: 'Import from `react-native` instead. To defer, add `"customConditions": ["react-native", "react-native-legacy-deep-imports"]` to tsconfig.json (works through 0.88 only).', code: [/from\s*['"]react-native\/Libraries\//], ts: true, source: RN_087 },
  { id: 'rn87-properties-types', rn: 87, kind: 'removed', title: 'The deprecated `*Properties` type aliases are gone', action: 'Use the `*Props` types (`ViewProperties` → `ViewProps`).', code: [fromRn('\\w+Properties')], ts: true, source: RN_087 },
  { id: 'rn87-native-methods', rn: 87, kind: 'removed', title: '`NativeMethods`, `NativeMethodsMixin` and the `Touchable` root export are removed', action: 'Type refs with `HostInstance` (or `ViewInstance`, `TextInputInstance`), and extend `ViewProps` instead of `Touchable`.', code: [fromRn('NativeMethods(?:Mixin)?'), fromRn('Touchable')], source: RN_087 },
  { id: 'rn87-color-scheme-unspecified', rn: 87, kind: 'behavior', title: "`useColorScheme()` no longer returns `'unspecified'`, and `Appearance.setColorScheme('unspecified')` is deprecated", action: "Treat `null` as \"follow the system\" and call `Appearance.setColorScheme('auto')`.", code: [/['"]unspecified['"]/], requireCode: /useColorScheme|Appearance/, source: RN_087 },
  { id: 'rn87-polyfills', rn: 87, kind: 'removed', title: '`react-native/rn-get-polyfills` and `@react-native/core-cli-utils` are gone', action: 'Use `@react-native/js-polyfills`.', code: [/react-native\/rn-get-polyfills|@react-native\/core-cli-utils/], config: true, source: RN_087 },
  { id: 'rn87-initialize-core', rn: 87, kind: 'removed', title: '`react-native/Libraries/Core/InitializeCore` is deprecated', action: 'Use `react-native/setup-env`.', code: [/react-native\/Libraries\/Core\/InitializeCore/], config: true, source: RN_087 },
  { id: 'rn87-metro-yaml', rn: 87, kind: 'tooling', title: 'Metro no longer reads YAML or `.es6` config files', action: 'Move the Metro config to `metro.config.js` (TypeScript and ESM configs are now supported).', files: [/^metro\.config\.(?:ya?ml|es6)$|^\.metro\.config\.ya?ml$/], source: RN_087 },
  { id: 'rn87-bare-includes', rn: 87, kind: 'removed', title: 'React headers imported without `React/` stop the iOS build', action: 'Write `#import <React/RCTBridge.h>` instead of `#import "RCTBridge.h"` or `#import <RCTBridge.h>`; for a library, update it or patch it (patch-package).', reactHeaders: true, source: RN_087 },
  { id: 'rn87-node', rn: 87, kind: 'tooling', title: 'Node.js 22.13 or newer is required', action: 'Update `.nvmrc`, `engines` and the CI Node version to 22.13+ (or 24.3+). Expo SDK 58 also rejects odd-numbered Node releases.', node: true, source: RN_087 },

  // Expo SDK 58 (beta)
  { id: 'expo58-r8', expo: 58, kind: 'behavior', title: 'R8 minification is on by default in Android release builds', action: 'Build a release APK/AAB and test it: code that relies on reflection, some SDKs, and native modules without keep rules can break only in release. Opt out with `expo-build-properties` (`android.enableMinifyInReleaseBuilds: false`) if you cannot fix it yet.', android: true, unlessConfig: /enableMinifyInReleaseBuilds|enableProguardInReleaseBuilds\s*["']?\s*:\s*true/, source: EXPO_58 },
  { id: 'expo58-node-env', expo: 58, kind: 'behavior', title: 'Expo CLI now sets `NODE_ENV` before loading `.env` files and the app config', action: 'Scripts that set NODE_ENV themselves no longer pick the .env file: `NODE_ENV=test npx expo start` loads .env.development. Switch environments with your own variable (APP_ENV) and `--env-file`/dotenv-cli.', scripts: /\bNODE_ENV=(?!production\b|development\b)\w+[^&|;]*\b(?:expo|eas)\b/, source: EXPO_58 },
  { id: 'expo58-file-write', expo: 58, kind: 'removed', title: 'expo-file-system: `File.write()` is now async, and `File.md5` is deprecated', action: 'Await `file.write(...)` or use `file.writeSync(...)`; replace `.md5` with `file.digest()`.', code: [/\.write\s*\(/, /\.md5\b/], requireImport: 'expo-file-system', source: EXPO_58 },
  { id: 'expo58-libsql', expo: 58, kind: 'removed', title: 'expo-sqlite: libSQL support is removed', action: 'Remove `syncLibSQL()`, `libSQLOptions` and the `useLibSQL` config plugin option.', code: [/\bsyncLibSQL\b|\blibSQLOptions\b|\buseLibSQL\b/], config: true, source: EXPO_58 },
  { id: 'expo58-notifications-foreground', expo: 58, kind: 'behavior', title: 'expo-notifications: notifications are now shown while the app is open, unless your handler says otherwise', action: 'If foreground notifications should stay hidden, call `Notifications.setNotificationHandler` and return `shouldShowBanner: false`, `shouldShowList: false`.', dep: 'expo-notifications', unlessCode: /setNotificationHandler/, source: EXPO_58 },
  { id: 'expo58-router-react-navigation', expo: 58, kind: 'removed', title: 'expo-router: the navigation core was reworked and most of the forked React Navigation API is gone', action: 'Check each import from `expo-router/react-navigation` and custom navigators against the SDK 58 migration guide; JavaScript Tabs, TopTabs and Drawer now use standard-navigation.', code: [/from\s*['"]expo-router\/react-navigation['"]/, /\bwithLayoutContext\s*\(/], source: EXPO_58 },
  { id: 'expo58-localization-rtl', expo: 58, kind: 'behavior', title: 'expo-localization: `supportsRTL` no longer forces right-to-left layout on iOS', action: 'Layout direction now follows `I18nManager`: call `I18nManager.allowRTL(true)` / `forceRTL` where you need it, and test an RTL language.', configText: /supportsRTL/, source: EXPO_58 },
  { id: 'expo58-require-full-screen', expo: 58, kind: 'behavior', title: 'iOS 27: `requireFullScreen` no longer stops the app from being resized, so orientation locks may not apply', action: 'Test layouts at different window sizes on iPad and do not rely on `ScreenOrientation.lockAsync` alone.', configText: /requireFullScreen/, source: EXPO_58 },
  { id: 'expo58-media-library-video', expo: 58, kind: 'behavior', title: 'expo-media-library: video URIs now point to the current (edited) version on iOS', action: 'Pass `version: AssetUriVersion.ORIGINAL` where you need the original video.', code: [/\bgetUri\s*\(|\bgetAssetInfoAsync\s*\(/], requireImport: 'expo-media-library', source: EXPO_58 },
  { id: 'expo58-expo-ui', expo: 58, kind: 'behavior', title: '@expo/ui: `Host` top-aligns its content, unset `spacing` uses the SwiftUI default, and some props are renamed', action: 'Pass `spacing={0}` to HStack/VStack/GlassEffectContainer to keep the old layout, `background` instead of `backgroundOverlay`, `modifiers` instead of `style` on RNHostView.', dep: '@expo/ui', source: EXPO_58 },
  { id: 'expo58-deprecations', expo: 58, kind: 'removed', title: '`NativeArrayBuffer` (expo-modules-core) and `AppMetrics` (expo-observe) are deprecated', action: 'Use `ArrayBuffer` and `Observe`.', code: [/\bNativeArrayBuffer\b|\bAppMetrics\b/], source: EXPO_58 },
];

const SKIP = new Set(['node_modules', '.git', 'android', 'ios', 'build', 'dist', '.expo', 'coverage', '__tests__', '__mocks__', 'web-build', 'vendor', 'test', 'tests', 'e2e']);

function codeFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < 10 && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
      } else if (/\.[cm]?[jt]sx?$/.test(e.name) && !/\.(test|spec|d)\.[jt]sx?$/.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function nodeTooOld(root, pkg) {
  const specs = [];
  for (const f of ['.nvmrc', '.node-version']) {
    const v = read(path.join(root, f)).trim();
    if (v) specs.push([f, v]);
  }
  if (pkg && pkg.engines && pkg.engines.node) specs.push(['package.json engines.node', String(pkg.engines.node)]);
  for (const [where, spec] of specs) {
    const m = spec.match(/(\d+)(?:\.(\d+))?/);
    if (!m) continue;
    const major = Number(m[1]);
    const minor = m[2] === undefined ? null : Number(m[2]);
    // A range such as ">=18" allows newer versions; only exact pins and caret/tilde ranges pin an old line.
    if (/>=?/.test(spec) && !/</.test(spec)) continue;
    if (major < 22 || (major === 22 && minor !== null && minor < 13) || major === 23) return `${where}: ${spec}`;
  }
  return null;
}

// project: loadProject() result. Returns the changes ahead of it that touch its code.
export function upcomingChanges(project) {
  const root = project.root;
  const rnMinor = project.rnVersion ? Number(project.rnVersion.split('.')[1]) : null;
  const expoMajor = project.expoVersion ? Number(String(project.expoVersion).split('.')[0]) : null;
  if (rnMinor === null && expoMajor === null) return [];
  const isExpo = expoMajor !== null;
  // For an Expo app, React Native changes arrive with the SDK that ships them.
  const ahead = (c) => (c.expo ? isExpo && expoMajor < c.expo : rnMinor !== null && rnMinor < c.rn && (!isExpo || Object.entries(EXPO_RN).some(([sdk, rn]) => Number(sdk) > expoMajor && rn >= c.rn)));
  const candidates = CHANGES.filter(ahead);
  if (!candidates.length) return [];

  const pkg = (() => {
    try {
      return JSON.parse(read(path.join(root, 'package.json')));
    } catch {
      return {};
    }
  })();
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const isTs = fs.existsSync(path.join(root, 'tsconfig.json'));
  const configText = ['app.json', 'app.config.js', 'app.config.ts', 'app.config.mjs'].map((f) => read(path.join(root, f))).join('\n');
  const files = codeFiles(root).map((f) => ({ rel: path.relative(root, f).split(path.sep).join('/'), text: stripComments(read(f)) }));
  const configFiles = ['metro.config.js', 'babel.config.js', 'index.js', 'jest.config.js', 'package.json', 'app.json', 'app.config.js', 'app.config.ts']
    .map((f) => ({ rel: f, text: read(path.join(root, f)) }))
    .filter((f) => f.text);
  const hasAndroid = isExpo ? true : !!project.android;

  const out = [];
  for (const c of candidates) {
    const hits = [];
    if (c.code) {
      const pool = c.config ? [...files, ...configFiles.filter((f) => !files.some((x) => x.rel === f.rel))] : files;
      for (const f of pool) {
        if (c.ts && !/\.tsx?$/.test(f.rel)) continue;
        if (c.requireCode && !c.requireCode.test(f.text)) continue;
        if (c.requireImport && !importsFrom(c.requireImport).test(f.text)) continue;
        for (const re of c.code) {
          const m = re.exec(f.text);
          if (m) {
            hits.push(`${f.rel}:${lineOf(f.text, m.index)}`);
            break;
          }
        }
        if (hits.length >= 5) break;
      }
    }
    if (c.ts && !isTs && !hits.length) continue;
    if (c.reactHeaders) {
      const { libraries, app } = unprefixedReactImports(project);
      for (const l of libraries) hits.push(`${l.name}${l.version ? ` ${l.version}` : ''} (${l.hits[0].file}:${l.hits[0].line})`);
      for (const h of app) hits.push(`${h.file}:${h.line}`);
    }
    if (c.files) {
      for (const name of fs.readdirSync(root)) if (c.files[0].test(name)) hits.push(name);
    }
    if (c.node) {
      const old = nodeTooOld(root, pkg);
      if (old) hits.push(old);
    }
    if (c.scripts) {
      for (const [k, s] of Object.entries(pkg.scripts || {})) if (c.scripts.test(s)) hits.push(`package.json scripts.${k}`);
    }
    if (c.configText) {
      const m = c.configText.exec(configText);
      if (m) hits.push('app config');
    }
    if (c.dep && deps[c.dep]) {
      if (!c.unlessCode || !files.some((f) => c.unlessCode.test(f.text))) hits.push(`uses ${c.dep}`);
    }
    if (c.android && hasAndroid) {
      const gradle = read(path.join(root, 'android', 'gradle.properties'));
      if (!c.unlessConfig.test(configText) && !/android\.enableMinifyInReleaseBuilds\s*=\s*true|enableProguardInReleaseBuilds\s*=\s*true/.test(gradle) && !/minifyEnabled\s*(?:=\s*)?true/.test(read(path.join(root, 'android', 'app', 'build.gradle')))) hits.push('Android release build');
    }
    if (hits.length) out.push({ ...c, hits: [...new Set(hits)].slice(0, 5) });
  }
  return out;
}

// Name the React Native version an SDK ships, so nobody reads "SDK 58" as "React Native 0.87".
const versionLabel = (c) => (c.expo ? `Expo SDK ${c.expo} (${c.expo === NEXT.expo.sdk && NEXT.expo.status !== 'stable' ? `${NEXT.expo.status}, ` : ''}React Native 0.${EXPO_RN[c.expo]})` : `React Native 0.${c.rn}`);

export function upcomingFinding(project) {
  const changes = upcomingChanges(project);
  if (!changes.length) return [];
  const versions = [...new Set(changes.map(versionLabel))];
  const breaking = changes.filter((c) => c.kind === 'removed').length;
  return [
    {
      id: 'upcoming-changes',
      severity: breaking ? 'low' : 'info',
      area: 'react-native',
      title: `${changes.length} change${changes.length === 1 ? '' : 's'} in ${versions.join(' and ')} affect${changes.length === 1 ? 's' : ''} this app${breaking ? ` (${breaking} break${breaking === 1 ? 's' : ''} code)` : ''}`,
      detail: changes.map((c) => `${c.title} (${c.hits.join(', ')}): ${c.action}`).join(' '),
      fix: { kind: 'upcoming', changes: changes.map((c) => ({ id: c.id, version: versionLabel(c), kind: c.kind, title: c.title, hits: c.hits, action: c.action, source: c.source })) },
    },
  ];
}
