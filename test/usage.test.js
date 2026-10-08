import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnused, importedPackages, packageOf } from '../src/usage.js';
import { loadProject } from '../src/project.js';
import { makeProject } from './helpers.js';

test('import specifiers map to package names', () => {
  assert.equal(packageOf('lodash/fp'), 'lodash');
  assert.equal(packageOf('@scope/pkg/sub/path'), '@scope/pkg');
  assert.equal(packageOf('./local'), null);
  const text = `import a from 'a'; import 'side-effect'; const b = require("@s/b/x"); const c = await import('c'); jest.mock('d'); export { e } from 'e';`;
  assert.deepEqual([...importedPackages(text)].sort(), ['@s/b', 'a', 'c', 'd', 'e', 'side-effect']);
});

function app(extraFiles = {}) {
  return makeProject({
    'package.json': {
      name: 'u',
      dependencies: {
        'react-native': '0.80.0',
        'used-js': '1.0.0',
        'unused-js': '1.0.0',
        'unused-native': '1.0.0',
        'native-only': '1.0.0',
        'peer-required': '1.0.0',
        'needs-peer': '1.0.0',
        'cli-tool': '1.0.0',
      },
      scripts: { postinstall: 'cli-tool run' },
    },
    'node_modules/react-native/package.json': { version: '0.80.0' },
    'node_modules/used-js/package.json': { version: '1.0.0' },
    'node_modules/unused-js/package.json': { version: '1.0.0' },
    'node_modules/unused-native/package.json': { version: '1.0.0' },
    'node_modules/unused-native/UnusedNative.podspec': '',
    'node_modules/native-only/package.json': { version: '1.0.0' },
    'node_modules/native-only/RNCNativeOnly.podspec': '',
    'node_modules/peer-required/package.json': { version: '1.0.0' },
    'node_modules/needs-peer/package.json': { version: '1.0.0', peerDependencies: { 'peer-required': '*' } },
    'node_modules/cli-tool/package.json': { version: '1.0.0' },
    'src/App.js': "import x from 'used-js';\nimport y from 'needs-peer';\n",
    'ios/App/AppDelegate.mm': '#import <RNCNativeOnly/RNCNativeOnly.h>\n',
    ...extraFiles,
  });
}

test('only truly unused packages are reported', () => {
  const unused = findUnused(loadProject(app()));
  assert.deepEqual(unused, [
    { name: 'unused-js', native: false },
    { name: 'unused-native', native: true },
  ]);
});

test('without node_modules nothing is claimed', () => {
  const root = makeProject({ 'package.json': { name: 'x', dependencies: { 'react-native': '0.80.0', lonely: '1.0.0' } } });
  assert.deepEqual(findUnused(loadProject(root)), []);
});

test('unused: config aliases, indirect peers, CLI command names and self-registering packages count as used', () => {
  const root = makeProject({
    'package.json': {
      name: 'u',
      scripts: { 'upload-maps': 'bugsnag-source-maps upload-react-native' },
      dependencies: {
        'react-native': '0.80.0',
        'crypto-browserify': '3.12.0',
        '@react-native-masked-view/masked-view': '0.3.2',
        '@bugsnag/source-maps': '2.3.0',
        'react-native-webp-format': '1.2.1',
        'left-pad': '1.3.0',
      },
    },
    'metro.config.js': "module.exports = { resolver: { extraNodeModules: { crypto: require.resolve('crypto-browserify') } } };\n",
    'node_modules/react-native/package.json': { version: '0.80.0' },
    'node_modules/crypto-browserify/package.json': { version: '3.12.0' },
    'node_modules/@react-native-masked-view/masked-view/package.json': { version: '0.3.2' },
    // Not declared by the app: pulled in by a navigator, and it peers on masked-view.
    'node_modules/@react-navigation/elements/package.json': { version: '2.0.0', peerDependencies: { '@react-native-masked-view/masked-view': '>= 0.2.0' } },
    'node_modules/@bugsnag/source-maps/package.json': { version: '2.3.0', bin: { 'bugsnag-source-maps': 'bin/cli.js' } },
    'node_modules/react-native-webp-format/package.json': { version: '1.2.1' },
    'node_modules/left-pad/package.json': { version: '1.3.0' },
    'src/App.js': "export default 1;\n",
  });
  const unused = findUnused(loadProject(root)).map((u) => u.name);
  assert.deepEqual(unused, ['left-pad']);
});

test('unused: a patched package is never reported', () => {
  const root = makeProject({
    'package.json': { name: 'p', dependencies: { 'react-native': '0.80.0', '@react-native-community/toolbar-android': '0.2.1', 'left-pad': '1.3.0' } },
    'patches/@react-native-community+toolbar-android+0.2.1.patch': 'diff --git a/x b/x\n',
    'node_modules/react-native/package.json': { version: '0.80.0' },
    'node_modules/@react-native-community/toolbar-android/package.json': { version: '0.2.1' },
    'node_modules/left-pad/package.json': { version: '1.3.0' },
    'src/App.js': 'export default 1;\n',
  });
  assert.deepEqual(findUnused(loadProject(root)).map((u) => u.name), ['left-pad']);
});

test('unused: package.json alias fields and Node core polyfills count as used', () => {
  const root = makeProject({
    'package.json': {
      name: 'n',
      'react-native': { crypto: 'react-native-crypto' },
      dependencies: { 'react-native': '0.80.0', 'react-native-crypto': '2.2.0', stream: '0.0.3', 'left-pad': '1.3.0' },
    },
    'node_modules/react-native/package.json': { version: '0.80.0' },
    'node_modules/react-native-crypto/package.json': { version: '2.2.0' },
    'node_modules/stream/package.json': { version: '0.0.3' },
    'node_modules/left-pad/package.json': { version: '1.3.0' },
    'src/App.js': 'export default 1;\n',
  });
  assert.deepEqual(findUnused(loadProject(root)).map((u) => u.name), ['left-pad']);
});

test('Expo modules that work without an import are not unused', () => {
  const root = makeProject({
    'package.json': { name: 'e', dependencies: { expo: '54.0.0', 'react-native': '0.81.0', 'expo-system-ui': '6.0.0', 'expo-splash-screen': '31.0.0', 'expo-haptics': '15.0.0' } },
    'node_modules/react-native/package.json': { version: '0.81.0' },
    'node_modules/expo-system-ui/package.json': { version: '6.0.0' },
    'node_modules/expo-splash-screen/package.json': { version: '31.0.0' },
    'node_modules/expo-haptics/package.json': { version: '15.0.0' },
    'app.json': JSON.stringify({ expo: { userInterfaceStyle: 'automatic' } }),
    'App.js': "export default function App() { return null; }\n",
  });
  assert.deepEqual(findUnused({ root, hasNodeModules: true, deps: { expo: '54.0.0', 'react-native': '0.81.0', 'expo-system-ui': '6.0.0', 'expo-splash-screen': '31.0.0', 'expo-haptics': '15.0.0' } }).map((u) => u.name), ['expo-haptics']);
});
