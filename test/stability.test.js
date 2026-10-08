import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProject } from '../src/project.js';
import { stabilityChecks } from '../src/stability.js';
import { makeProject } from './helpers.js';

const ids = (files) => stabilityChecks(loadProject(makeProject(files))).map((f) => f.id);
const app = (deps, extra = {}) => ({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.80.0', ...deps } }, ...extra });

test('Reanimated Babel plugin', () => {
  assert.ok(ids(app({ 'react-native-reanimated': '3.19.1' }, { 'babel.config.js': "module.exports = { presets: ['module:@react-native/babel-preset'] };" })).includes('crash-reanimated-babel'));
  assert.ok(!ids(app({ 'react-native-reanimated': '3.19.1' }, { 'babel.config.js': "module.exports = { plugins: ['react-native-reanimated/plugin'] };" })).includes('crash-reanimated-babel'));
  assert.ok(!ids(app({ 'react-native-reanimated': '3.19.1' }, { 'babel.config.js': "module.exports = { presets: ['babel-preset-expo'] };" })).includes('crash-reanimated-babel'), 'Expo preset adds it');
  assert.ok(
    !ids(app({ 'react-native-reanimated': '4.5.0', 'react-native-worklets': '0.6.0' }, { 'babel.config.js': "const s = require('./config/shared');\nmodule.exports = { plugins: s };", 'config/shared.js': "module.exports = ['react-native-worklets/plugin'];" })).includes('crash-reanimated-babel'),
    'plugin in a shared config file',
  );
  assert.ok(!ids(app({ 'react-native-reanimated': '2.2.0' }, { 'babel.config.js': 'module.exports = {};', 'src/A.js': "import Animated from 'react-native-reanimated';\nconst x = new Animated.Value(0);" })).includes('crash-reanimated-babel'), 'Reanimated 2 with the v1 API only');
  assert.ok(ids(app({ 'react-native-reanimated': '2.2.0' }, { 'babel.config.js': 'module.exports = {};', 'src/A.js': "import { useSharedValue } from 'react-native-reanimated';" })).includes('crash-reanimated-babel'));
});

test('Reanimated 4 needs react-native-worklets', () => {
  assert.ok(ids(app({ 'react-native-reanimated': '4.5.0' }, { 'babel.config.js': "module.exports = { plugins: ['react-native-worklets/plugin'] };" })).includes('crash-reanimated-worklets'));
});

test('mixed Firebase and Navigation majors', () => {
  assert.ok(ids(app({ '@react-native-firebase/app': '22.2.1', '@react-native-firebase/messaging': '21.0.0' })).includes('crash-firebase-versions'));
  assert.ok(!ids(app({ '@react-native-firebase/app': '22.2.1', '@react-native-firebase/messaging': '22.4.0' })).includes('crash-firebase-versions'));
  assert.ok(ids(app({ '@react-navigation/native': '7.1.0', '@react-navigation/bottom-tabs': '6.6.1' })).includes('crash-navigation-versions'));
  assert.ok(!ids(app({ '@react-navigation/native': '5.9.4', '@react-navigation/web': '1.0.0', '@react-navigation/compat': '5.3.20' })).includes('crash-navigation-versions'), 'own version lines');
});

test('a second React inside a runtime dependency, not inside dev tooling', () => {
  const base = {
    'node_modules/react/package.json': { version: '18.2.0' },
    'node_modules/react-native/package.json': { version: '0.80.0' },
    'node_modules/icons/package.json': { version: '1.0.0' },
    'node_modules/icons/node_modules/react/package.json': { version: '16.5.0' },
    'node_modules/@storybook/ui/package.json': { version: '7.0.0' },
    'node_modules/@storybook/ui/node_modules/react/package.json': { version: '18.3.1' },
  };
  const files = { 'package.json': { name: 'a', dependencies: { 'react-native': '0.80.0', react: '18.2.0', icons: '1.0.0' }, devDependencies: { '@storybook/ui': '7.0.0' } }, ...base };
  const found = stabilityChecks(loadProject(makeProject(files)));
  const dup = found.find((f) => f.id === 'crash-duplicate-react');
  assert.ok(dup);
  assert.match(dup.detail, /icons \(16\.5\.0\)/);
  assert.ok(!dup.detail.includes('storybook'));
});

test('Babel config in a monorepo root counts; no config anywhere says nothing', () => {
  const mono = makeProject({
    'babel.config.js': "module.exports = { plugins: ['react-native-reanimated/plugin'] };",
    'apps/mobile/package.json': { name: 'm', dependencies: { 'react-native': '0.80.0', 'react-native-reanimated': '3.19.1' } },
  });
  assert.ok(!stabilityChecks(loadProject(`${mono}/apps/mobile`)).some((f) => f.id === 'crash-reanimated-babel'));
  assert.ok(!ids(app({ 'react-native-reanimated': '3.19.1' })).includes('crash-reanimated-babel'), 'no Babel config found at all');
});

test('iOS usage descriptions: missing key flagged; add-only photo key and Expo plugins count', () => {
  const plist = (keys) => `<plist><dict>${keys.map((k) => `<key>${k}</key><string>x</string>`).join('')}</dict></plist>`;
  const withCam = (keys, extra = {}) => ({ ...app({ 'react-native-vision-camera': '4.0.0', '@react-native-camera-roll/camera-roll': '7.0.0' }), 'ios/App/Info.plist': plist(keys), ...extra });
  const f = stabilityChecks(loadProject(makeProject(withCam([])))).find((x) => x.id === 'crash-ios-usage-description');
  assert.match(f.title, /NSCameraUsageDescription, NSPhotoLibraryUsageDescription/);
  assert.ok(!ids(withCam(['NSCameraUsageDescription', 'NSPhotoLibraryAddUsageDescription'])).includes('crash-ios-usage-description'));
  const expo = { 'package.json': { name: 'e', dependencies: { expo: '52.0.0', 'react-native': '0.76.0', 'expo-camera': '16.0.0' } }, 'ios/App/Info.plist': plist([]), 'app.json': JSON.stringify({ expo: { plugins: ['expo-camera'] } }) };
  assert.ok(!ids(expo).includes('crash-ios-usage-description'), 'the Expo config plugin adds it at prebuild');
});

test('APIs removed from React Native core: crash now or after the upgrade', () => {
  const src = (rn, code) => stabilityChecks(loadProject(makeProject({ 'package.json': { name: 'r', dependencies: { 'react-native': rn } }, 'src/A.js': code }))).find((f) => f.id === 'crash-removed-core-imports');
  const asyncNow = src('0.80.0', "import { View, AsyncStorage } from 'react-native';\nawait AsyncStorage.getItem('k');");
  assert.equal(asyncNow.severity, 'high');
  assert.match(asyncNow.detail, /@react-native-async-storage\/async-storage/);
  assert.equal(src('0.65.0', "import { Picker } from 'react-native';\nconst p = <Picker />;").severity, 'medium');
  assert.equal(src('0.73.0', "const { ViewPropTypes } = require('react-native');\nX.propTypes = { style: ViewPropTypes.style };").severity, 'medium', 'PropTypes still exist on 0.73');
  assert.equal(src('0.74.0', "import { ViewPropTypes } from 'react-native';\nX.propTypes = { style: ViewPropTypes.style };").severity, 'high');
  const importOnly = src('0.85.0', "import { View, DatePickerAndroid } from 'react-native';\nexport default () => <View />;");
  assert.equal(importOnly.severity, 'low', 'an import that is never used is undefined, not a crash');
  assert.match(importOnly.title, /unused import/);
  assert.equal(src('0.85.0', "import { DatePickerAndroid } from 'react-native';\n/* old: DatePickerAndroid.open() */\n{/* DatePickerAndroid */}").severity, 'low', 'mentions in comments are not uses');
  assert.equal(src('0.80.0', "import { View, Text } from 'react-native';\nimport AsyncStorage from '@react-native-async-storage/async-storage';"), undefined);
});

test('APIs deprecated in React Native core (removal announced): low, with the replacement', () => {
  const find = (rn, code) => stabilityChecks(loadProject(makeProject({ 'package.json': { name: 'r', dependencies: { 'react-native': rn } }, 'src/A.js': code }))).find((f) => f.id === 'deprecated-core-imports');
  const f = find('0.81.0', "import { View, ImageBackground, SafeAreaView } from 'react-native';");
  assert.equal(f.severity, 'low');
  assert.match(f.title, /ImageBackground, SafeAreaView are deprecated/);
  assert.match(f.detail, /SafeAreaView \(src\/A\.js:1, deprecated in 0\.81\) → react-native-safe-area-context/);
  assert.match(f.detail, /already log a deprecation warning/, 'SafeAreaView warns on 0.81');
  assert.match(find('0.80.0', "import { ImageBackground } from 'react-native';").detail, /start logging a warning when you upgrade/);
  assert.equal(find('0.81.0', "import { SafeAreaView } from 'react-native-safe-area-context';"), undefined);
});

test('core SafeAreaView with target SDK 35+: medium, Android edge-to-edge explained', () => {
  const find = (files) => stabilityChecks(loadProject(makeProject({ 'package.json': { name: 'r', dependencies: { 'react-native': '0.79.0' } }, 'src/A.js': "import { SafeAreaView } from 'react-native';", ...files }))).find((f) => f.id === 'deprecated-core-imports');
  const f = find({ 'android/build.gradle': 'buildscript { ext { targetSdkVersion = 35 } }', 'android/app/build.gradle': '' });
  assert.equal(f.severity, 'medium');
  assert.match(f.detail, /edge-to-edge/);
  assert.equal(find({ 'android/build.gradle': 'buildscript { ext { targetSdkVersion = 34 } }', 'android/app/build.gradle': '' }).severity, 'low');
});

test('release builds talking to a development server; dev-only branches, settings defaults and WebView base URLs are fine', async () => {
  const { releaseDevServer } = await import('../src/stability.js');
  const run = (files) => releaseDevServer({ root: makeProject({ 'package.json': '{}', ...files }) });
  assert.match(run({ 'src/services/api.ts': "export const api = axios.create({ baseURL: 'http://10.0.2.2:3000' });" })[0].detail, /Android emulator/);
  assert.equal(run({ 'src/lib/socket.ts': "const SOCKET_URL = 'http://192.168.1.100:3000';" })[0].id, 'release-dev-server');
  assert.equal(run({ 'src/api.ts': "const BASE_URL = __DEV__ ? 'http://localhost:3000' : 'https://api.example.com';" }).length, 0);
  assert.equal(run({ 'src/config.ts': "baseURL:\n  process.env.SWAP_API_DEV === 'true'\n    ? 'http://localhost:5050'\n    : 'https://swap.example.com'," }).length, 0);
  assert.equal(run({ 'src/screens/settings/Server.tsx': "const url = 'http://192.168.4.1';" }).length, 0);
  assert.equal(run({ 'src/Web.tsx': "<WebView source={{ html, baseUrl: 'https://localhost' }} />\nconst uri = 'https://localhost';" }).length, 0);
  assert.equal(run({ 'src/api.web.ts': "fetch('http://localhost:3000/x')" }).length, 0);
});

test('dev server: server actions, named local fallbacks and local-service probes are deliberate', async () => {
  const { releaseDevServer } = await import('../src/stability.js');
  const run = (files) => releaseDevServer({ root: makeProject({ 'package.json': '{}', ...files }) });
  assert.equal(run({ 'src/actions/eval.ts': "'use server';\nconst r = await fetch(`http://localhost:8081/x.bundle`);" }).length, 0);
  assert.equal(run({ 'src/api-base.ts': "const LOCAL_API_URL = 'http://localhost:54321';\nconst API_URL = process.env.EXPO_PUBLIC_API_URL || LOCAL_API_URL;" }).length, 0);
  assert.equal(run({ 'src/oracle.ts': "// Auto-detect Ollama on localhost\ntry { const r = await fetch('http://localhost:11434/api/tags'); } catch {}" }).length, 0);
});
