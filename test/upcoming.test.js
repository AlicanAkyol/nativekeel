import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingChanges, upcomingFinding, CHANGES } from '../src/upcoming.js';
import { loadProject } from '../src/project.js';
import { makeProject } from './helpers.js';

const ids = (root) => upcomingChanges(loadProject(root)).map((c) => c.id);

test('upcoming: React Native 0.87 removals found in app code, with file:line', () => {
  const root = makeProject({
    'package.json': { name: 'app', dependencies: { 'react-native': '0.86.3' }, engines: { node: '20.x' } },
    'tsconfig.json': '{}',
    'src/A.tsx': "import { InteractionManager, StatusBar, Modal } from 'react-native';\nimport x from 'react-native/Libraries/Utilities/codegenNativeComponent';\nexport const A = () => (<>\n<StatusBar translucent />\n<Modal animated={false} />\n<ScrollView keyboardShouldPersistTaps={true} />\n</>);\nInteractionManager.runAfterInteractions(() => {});\n",
    'ios/App/AppDelegate.h': '#import <RCTAppDelegate.h>\n',
    'android/build.gradle': '',
    'node_modules/react-native/package.json': { name: 'react-native', version: '0.86.3' },
    'node_modules/react-native/Libraries/AppDelegate/RCTAppDelegate.h': '',
  });
  const changes = upcomingChanges(loadProject(root));
  const got = changes.map((c) => c.id);
  for (const id of ['rn87-interaction-manager', 'rn87-statusbar-props', 'rn87-modal-animated', 'rn87-keyboard-persist-boolean', 'rn87-deep-imports', 'rn87-node']) assert.ok(got.includes(id), id);
  assert.ok(!got.includes('rn87-bare-includes'), 'the app\'s own <RCTAppDelegate.h> resolves in the app target');
  assert.deepEqual(changes.find((c) => c.id === 'rn87-interaction-manager').hits, ['src/A.tsx:1']);
  assert.match(changes.find((c) => c.id === 'rn87-node').hits[0], /engines\.node: 20/);
});

test('upcoming: nothing for code that is already fine, or for a version past the change', () => {
  const fine = makeProject({
    'package.json': { name: 'app', dependencies: { 'react-native': '0.86.0' }, engines: { node: '>=18' } },
    'src/A.js': "import { StatusBar } from 'expo-status-bar';\nexport const A = () => <StatusBar backgroundColor=\"#000\" translucent />;\n<ScrollView keyboardShouldPersistTaps=\"handled\" />\n",
  });
  assert.deepEqual(ids(fine), []);
  const done = makeProject({ 'package.json': { name: 'app', dependencies: { 'react-native': '0.87.1' } }, 'src/A.js': "import { InteractionManager } from 'react-native';\n" });
  assert.deepEqual(ids(done), []);
});

test('upcoming: Expo SDK 58 changes, only where the app is affected', () => {
  const root = makeProject({
    'package.json': { name: 'app', dependencies: { expo: '~57.0.23', 'react-native': '0.86.3', 'expo-notifications': '*', 'expo-sqlite': '*' }, scripts: { test: 'NODE_ENV=test expo start' } },
    'app.json': { expo: { ios: { requireFullScreen: true } } },
    'src/db.ts': "import { File } from 'expo-file-system';\nnew File('a').write('x');\nexport const o = { libSQLOptions: {} };\n",
  });
  const changes = upcomingChanges(loadProject(root));
  const got = changes.map((c) => c.id);
  for (const id of ['expo58-r8', 'expo58-node-env', 'expo58-file-write', 'expo58-libsql', 'expo58-notifications-foreground', 'expo58-require-full-screen']) assert.ok(got.includes(id), id);
  const [f] = upcomingFinding(loadProject(root));
  assert.match(f.title, /Expo SDK 58 \(React Native 0\.88\)/, 'stable now: no beta label');
  assert.equal(f.fix.kind, 'upcoming');

  const handled = makeProject({
    'package.json': { name: 'app', dependencies: { expo: '~57.0.0', 'expo-notifications': '*', 'expo-build-properties': '*' } },
    'app.json': { expo: { plugins: [['expo-build-properties', { android: { enableMinifyInReleaseBuilds: true } }]] } },
    'src/n.ts': 'Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: false }) });\n',
  });
  assert.deepEqual(ids(handled).filter((id) => id === 'expo58-r8' || id === 'expo58-notifications-foreground'), []);
});

test('upcoming: every entry names its version, kind, action and release-notes source', () => {
  for (const c of CHANGES) {
    assert.ok(c.rn || c.expo, c.id);
    assert.ok(['removed', 'behavior', 'tooling'].includes(c.kind), c.id);
    assert.ok(c.action && c.title, c.id);
    assert.match(c.source, /^https:\/\/(reactnative\.dev|(docs\.)?expo\.dev)\//, c.id); // official notes or official docs
  }
});

test('upcoming: expo-file-system File.write is flagged only on a real File instance', () => {
  const base = { name: 'app', dependencies: { expo: '57.0.0', 'react-native': '0.86.0', 'expo-file-system': '~19.0.0' } };
  const real = makeProject({ 'package.json': base, 'src/a.ts': "import { File } from 'expo-file-system';\nconst f = new File('x');\nf.write('data');\n" });
  const inline = makeProject({ 'package.json': base, 'src/b.ts': "import { File } from 'expo-file-system';\nnew File('x').write('d');\n" });
  // Imports expo-file-system but the .write() is a WatermelonDB transaction, not a File.
  const other = makeProject({ 'package.json': base, 'src/c.ts': "import { File } from 'expo-file-system';\nawait appDatabase.write(async () => {});\n" });
  assert.ok(ids(real).includes('expo58-file-write'), 'variable form');
  assert.ok(ids(inline).includes('expo58-file-write'), 'inline form');
  assert.ok(!ids(other).includes('expo58-file-write'), 'unrelated .write() is not flagged');
});

test('upcoming: additional React Native 0.87 removals and deprecations are catalogued', () => {
  const root = makeProject({
    'package.json': { name: 'app', dependencies: { 'react-native': '0.86.0' } },
    'src/A.ts': "import IO from 'react-native/src/private/webapis/intersectionobserver/IntersectionObserver';\nimport { DrawerLayoutAndroid } from 'react-native';\nimport { registerAssetsDir } from '@react-native/assets-registry';\n",
  });
  const got = ids(root);
  for (const id of ['rn87-src-private', 'rn87-drawer-layout-android', 'rn87-assets-registry']) assert.ok(got.includes(id), id);
});

test('upcoming: React Native 0.85 removals are catalogued (absoluteFillObject, jest preset)', () => {
  const root = makeProject({
    'package.json': { name: 'app', dependencies: { 'react-native': '0.81.0' } },
    'src/styles.ts': 'export const overlay = StyleSheet.absoluteFillObject;\n',
    'jest.config.js': "module.exports = { preset: 'react-native' };\n",
  });
  const got = ids(root);
  assert.ok(got.includes('rn85-absolute-fill-object'), 'absoluteFillObject');
  assert.ok(got.includes('rn85-jest-preset'), 'jest preset');
  // Already on 0.85+: not reported.
  const current = makeProject({ 'package.json': { name: 'app', dependencies: { 'react-native': '0.86.0' } }, 'src/styles.ts': 'const x = StyleSheet.absoluteFillObject;\n' });
  assert.ok(!ids(current).includes('rn85-absolute-fill-object'));
});

test('upcoming: expo-router SDK 58 migration items, only in projects that use expo-router', () => {
  const files = {
    'app/_layout.tsx': "import { Stack } from 'expo-router';\nexport const unstable_settings = { initialRouteName: '(tabs)' };\nexport default function Layout() { return <Stack screenOptions={{ freezeOnBlur: true }}><Stack.Screen name=\"old\" redirect /></Stack>; }\n",
    'app/edit.tsx': "import { useNavigation } from 'expo-router';\nexport default function Edit() { const navigation = useNavigation(); navigation.addListener('beforeRemove', (e) => e.preventDefault()); return null; }\n",
  };
  const router = makeProject({ 'package.json': { name: 'app', dependencies: { expo: '57.0.0', 'react-native': '0.86.0', 'expo-router': '~57.0.0' } }, ...files });
  const got = ids(router);
  for (const id of ['expo58-router-initial-route-name', 'expo58-router-freeze-on-blur', 'expo58-router-before-remove', 'expo58-router-screen-props']) assert.ok(got.includes(id), id);
  const change = upcomingChanges(loadProject(router)).find((c) => c.id === 'expo58-router-initial-route-name');
  assert.equal(change.kind, 'behavior', 'a behaviour change, not a build break');
  assert.deepEqual(change.hits, ['app/_layout.tsx:2']);
  // Plain React Navigation keeps beforeRemove and freezeOnBlur.
  const plain = makeProject({ 'package.json': { name: 'app', dependencies: { expo: '57.0.0', 'react-native': '0.86.0', '@react-navigation/native': '^7.0.0' } }, ...files });
  assert.ok(!ids(plain).some((id) => id.startsWith('expo58-router-') && id !== 'expo58-router-react-navigation'));
});

test('upcoming: expo-router initialRouteName does not flag a plain React Navigation navigator', () => {
  const base = { name: 'app', dependencies: { expo: '57.0.0', 'react-native': '0.86.0', 'expo-router': '~57.0.0' } };
  const layout = makeProject({ 'package.json': base, 'app/_layout.tsx': "import { Stack } from 'expo-router';\nexport default function L() { return <Stack initialRouteName=\"index\" />; }\n" });
  assert.ok(ids(layout).includes('expo58-router-initial-route-name'));
  const nested = makeProject({ 'package.json': base, 'src/Nested.tsx': "import { createStackNavigator } from '@react-navigation/stack';\nconst Stack = createStackNavigator();\nexport default () => <Stack.Navigator initialRouteName=\"Home\" />;\n" });
  assert.ok(!ids(nested).includes('expo58-router-initial-route-name'));
});
