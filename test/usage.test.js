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
