import test from 'node:test';
import assert from 'node:assert/strict';
import { removedApiInLibraries } from '../src/js-libraries.js';
import { upcomingChanges } from '../src/upcoming.js';
import { upgradeReport } from '../src/upgrade.js';
import { loadProject } from '../src/project.js';
import { makeProject } from './helpers.js';

const app = (deps, files = {}) => makeProject({ 'package.json': { name: 'app', dependencies: { 'react-native': '0.84.0', ...deps } }, 'src/App.js': "import React from 'react';\nexport default () => null;\n", ...files });
const uses = (root) => Object.fromEntries([...removedApiInLibraries(loadProject(root))].map(([id, list]) => [id, list.map((l) => `${l.name}@${l.version}`)]));

test('js libraries: installed code that calls a removed API is found, with file and line', () => {
  const root = app({ 'some-modal': '^2.0.0', 'some-skeleton': '^1.0.0' }, {
    'node_modules/some-modal/package.json': { name: 'some-modal', version: '2.1.0' },
    'node_modules/some-modal/dist/modal.js': "import { InteractionManager } from 'react-native';\nexport function open() {\n  this.handle = InteractionManager.createInteractionHandle();\n}\n",
    'node_modules/some-skeleton/package.json': { name: 'some-skeleton', version: '1.4.0' },
    'node_modules/some-skeleton/lib/index.js': "/* a\nlong\ncomment */\nconst s = [StyleSheet.absoluteFillObject, { opacity: 1 }];\n",
  });
  const found = removedApiInLibraries(loadProject(root));
  assert.deepEqual(found.get('rn87-interaction-manager'), [{ name: 'some-modal', version: '2.1.0', where: 'dist/modal.js:3' }]);
  assert.deepEqual(found.get('rn85-absolute-fill-object'), [{ name: 'some-skeleton', version: '1.4.0', where: 'lib/index.js:4' }], 'line numbers survive block comments');
});

test('js libraries: a library\'s own copy of the API, or a guarded call, is not reported', () => {
  const root = app({ 'web-shim': '1.0.0', careful: '1.0.0' }, {
    'node_modules/web-shim/package.json': { name: 'web-shim', version: '1.0.0' },
    'node_modules/web-shim/dist/native.cjs': "var InteractionManager = { runAfterInteractions(cb) { cb(); } };\nInteractionManager.runAfterInteractions(() => {});\nvar absoluteFillObject = { position: 'absolute' };\nStyleSheet.absoluteFillObject = absoluteFillObject;\n",
    'node_modules/careful/package.json': { name: 'careful', version: '1.0.0' },
    'node_modules/careful/index.js': "if (StatusBar.setBackgroundColor) StatusBar.setBackgroundColor('#000');\nconst fill = StyleSheet.absoluteFillObject ?? StyleSheet.absoluteFill;\n",
  });
  assert.deepEqual(uses(root), {});
});

test('js libraries: without node_modules, only the release range verified by hand is matched', () => {
  assert.deepEqual(uses(app({ 'react-native-draggable-flatlist': '4.0.3' })), { 'rn87-interaction-manager': ['react-native-draggable-flatlist@4.0.3'] });
  assert.deepEqual(uses(app({ 'react-native-draggable-flatlist': '4.0.2' })), {}, '4.0.2 does not use InteractionManager');
  assert.deepEqual(uses(app({ 'native-base': '^2.15.2' })), {}, 'native-base 2.x does not use absoluteFillObject');
  assert.deepEqual(uses(app({ 'native-base': '^3.4.28' })), { 'rn85-absolute-fill-object': ['native-base@3.4.28'] });
});

test('upgrade: clean app code with a dependency that crashes on the new version is NOT READY', () => {
  const root = app({ 'react-native-modal': '^13.0.1' });
  const changes = upcomingChanges(loadProject(root));
  const im = changes.find((c) => c.id === 'rn87-interaction-manager');
  assert.deepEqual(im.hits, [], 'not in the app code');
  assert.deepEqual(im.libraries, ['react-native-modal 13.0.1 (Modal)']);
  const result = { project: { reactNative: '0.84.0' }, findings: [{ id: 'upcoming-changes', fix: { kind: 'upcoming', changes: changes.map((c) => ({ ...c, version: `React Native 0.${c.rn}` })) } }] };
  const r = upgradeReport(result);
  assert.equal(r.status, 'blocked');
  assert.ok(r.blockers.some((b) => b.kind === 'library-js' && b.where[0].startsWith('react-native-modal')));
  assert.ok(!r.blockers.some((b) => b.kind === 'code' && /InteractionManager/.test(b.title)), 'no code blocker without a hit in the app');
});

test('js libraries: React Native itself is not reported as a library', () => {
  const root = app({}, {
    'node_modules/react-native/package.json': { name: 'react-native', version: '0.84.0' },
    'node_modules/react-native/Libraries/Lists/VirtualizedList.js': "InteractionManager.runAfterInteractions(() => {});\n",
  });
  assert.deepEqual(uses(root), {});
});

test('js libraries: a layout-only break in a dependency is for review, not a blocker; version ranges hold', () => {
  const root = app({ 'react-native-calendars': '1.1300.0' });
  const changes = upcomingChanges(loadProject(root));
  const af = changes.find((c) => c.id === 'rn85-absolute-fill-object');
  assert.deepEqual(af.libraries, ['react-native-calendars 1.1300.0 (Timeline)']);
  const result = { project: { reactNative: '0.84.0' }, findings: [{ id: 'upcoming-changes', fix: { kind: 'upcoming', changes: changes.map((c) => ({ ...c, version: `React Native 0.${c.rn}` })) } }] };
  const r = upgradeReport(result);
  assert.notEqual(r.status, 'blocked');
  assert.ok(r.notes.some((n) => n.kind === 'library-js' && /Timeline/.test(n.where[0])));
  assert.deepEqual(uses(app({ 'react-native-calendars': '1.1274.0' })), {}, '1.1274.0 is clean');
});

test('js libraries: a hook library is not flagged; the app calling the hook is', () => {
  const root = app({ '@react-native-community/hooks': '100.1.0' }, { 'src/Screen.js': "import { useInteractionManager } from '@react-native-community/hooks';\nexport default function S() { const done = useInteractionManager(); return null; }\n" });
  assert.deepEqual(uses(root), {});
  const im = upcomingChanges(loadProject(root)).find((c) => c.id === 'rn87-interaction-manager');
  assert.deepEqual(im.hits, ['src/Screen.js:2']);
});
