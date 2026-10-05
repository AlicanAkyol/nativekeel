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
