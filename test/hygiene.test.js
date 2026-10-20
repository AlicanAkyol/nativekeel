import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProject } from '../src/project.js';
import { hygieneChecks } from '../src/hygiene.js';
import { makeProject } from './helpers.js';

const pkg = { name: 'a', main: 'index.js', dependencies: { react: '19.1.0', 'react-native': '0.80.0' } };
const run = (files) => Object.fromEntries(hygieneChecks(loadProject(makeProject({ 'package.json': pkg, ...files }))).map((f) => [f.id, f]));
const app = {
  'index.js': "import { AppRegistry } from 'react-native';\nimport App from './src/App';\nAppRegistry.registerComponent('a', () => App);",
  'src/App.tsx': "import Home from './screens/Home';\nimport { Button } from '@/ui/Button';\nexport default () => <Home />;",
  'src/screens/Home.tsx': "import logo from '../assets/logo.png';\nimport { fmt } from '../utils/format';\nexport default () => null;",
  'src/utils/format.ts': 'export const fmt = (x) => x;',
  'src/ui/Button.tsx': 'export const Button = () => null;',
  'src/assets/logo.png': 'x',
  'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
};

test('cleanup: backup copies, debugger statements, unused files and images', () => {
  const r = run({
    ...app,
    'src/screens/Home copy.tsx': 'export default () => null;',
    'src/screens/Old.tsx': 'export default () => null;',
    'src/utils/legacy.ts': "export const x = 1;\ndebugger;",
    'src/utils/onlyTests.ts': 'export const y = 1;',
    '__tests__/y.test.ts': "import { y } from '../src/utils/onlyTests';",
    'src/assets/unused-banner.png': 'x',
    'src/assets/logo@2x.png': 'x',
    'src/services/cloud-backup.ts': "import '../utils/format';",
  });
  assert.match(r['cleanup-backup-files'].detail, /src\/screens\/Home copy\.tsx/);
  assert.doesNotMatch(r['cleanup-backup-files'].detail, /cloud-backup/);
  assert.match(r['cleanup-debugger'].title, /src\/utils\/legacy\.ts:2/);
  const unused = r['cleanup-unused-files'].evidence.map((e) => e.file).sort();
  assert.deepEqual(unused, ['src/screens/Home copy.tsx', 'src/screens/Old.tsx', 'src/services/cloud-backup.ts', 'src/utils/legacy.ts']);
  assert.deepEqual(r['cleanup-unused-images'].evidence.map((e) => e.file), ['src/assets/unused-banner.png']);
});

test('cleanup: no unused-file report when an import cannot be resolved', () => {
  const tilde = "import Home from '~/screens/Home';\nimport { Button } from '@/ui/Button';\nexport default () => <Home />;";
  const r = run({ ...app, 'src/App.tsx': tilde, 'src/utils/dead.ts': 'export const z = 1;' });
  assert.equal(r['cleanup-unused-files'], undefined);
  const root = run({ ...app, 'src/App.tsx': tilde, 'src/utils/dead.ts': 'export const z = 1;', 'babel.config.js': "module.exports = { plugins: [['babel-plugin-root-import', { rootPathSuffix: 'src' }]] };" });
  assert.deepEqual(root['cleanup-unused-files']?.evidence.map((e) => e.file), ['src/utils/dead.ts']);
});
