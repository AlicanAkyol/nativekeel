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
  for (const id of ['rn87-interaction-manager', 'rn87-statusbar-props', 'rn87-modal-animated', 'rn87-keyboard-persist-boolean', 'rn87-deep-imports', 'rn87-bare-includes', 'rn87-node']) assert.ok(got.includes(id), id);
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

test('upcoming: Expo SDK 58 beta changes, only where the app is affected', () => {
  const root = makeProject({
    'package.json': { name: 'app', dependencies: { expo: '~57.0.23', 'react-native': '0.86.3', 'expo-notifications': '*', 'expo-sqlite': '*' }, scripts: { test: 'NODE_ENV=test expo start' } },
    'app.json': { expo: { ios: { requireFullScreen: true } } },
    'src/db.ts': "import { File } from 'expo-file-system';\nnew File('a').write('x');\nexport const o = { libSQLOptions: {} };\n",
  });
  const changes = upcomingChanges(loadProject(root));
  const got = changes.map((c) => c.id);
  for (const id of ['expo58-r8', 'expo58-node-env', 'expo58-file-write', 'expo58-libsql', 'expo58-notifications-foreground', 'expo58-require-full-screen']) assert.ok(got.includes(id), id);
  const [f] = upcomingFinding(loadProject(root));
  assert.match(f.title, /Expo SDK 58 \(beta, React Native 0\.88\)/);
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
    assert.match(c.source, /^https:\/\/(reactnative\.dev|expo\.dev)\//, c.id);
  }
});
