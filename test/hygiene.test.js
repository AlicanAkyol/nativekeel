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

test('cleanup: files loaded with require.context count as used; a computed import makes the graph incomplete', () => {
  const ctx = run({ ...app, 'src/App.tsx': "import Home from './screens/Home';\nimport { Button } from '@/ui/Button';\nconst more = require.context('./extra', true, /\\.tsx$/);\nexport default () => <Home />;", 'src/extra/Web.tsx': 'export default () => null;', 'src/utils/dead.ts': 'export const z = 1;' });
  assert.deepEqual(ctx['cleanup-unused-files']?.evidence.map((e) => e.file), ['src/utils/dead.ts'], 'the require.context folder is used');
  const dyn = run({ ...app, 'src/App.tsx': "import Home from './screens/Home';\nimport { Button } from '@/ui/Button';\nconst load = (name) => import(`./extra/${name}`);\nexport default () => <Home />;", 'src/utils/dead.ts': 'export const z = 1;' });
  assert.equal(dyn['cleanup-unused-files'], undefined, 'import(`./extra/${name}`) cannot be followed');
});

test('cleanup: an import that names its extension reaches the file', () => {
  const r = run({
    ...app,
    'src/screens/Home.tsx': "import Checkout from './Checkout.js';\nimport { fmt } from '../utils/format';\nexport default () => null;",
    'src/screens/Checkout.js': 'export default () => null;',
    'src/screens/Old.tsx': 'export default () => null;',
  });
  assert.deepEqual(r['cleanup-unused-files'].evidence.map((e) => e.file), ['src/screens/Old.tsx']);
});

test('cleanup: loading by path in a string, script or test keeps the graph; service workers are entries', () => {
  const r = run({
    ...app,
    'src/utils/format.ts': "export const fmt = (x) => x;\nexport const code = 'return import(specifier)';",
    'scripts/build.mjs': 'const m = await import(file);',
    'src/feature/tests/gen.mjs': 'const m = await import(file);',
    'src/service-worker.ts': 'self.addEventListener("fetch", () => {});',
    'src/screens/Old.tsx': 'export default () => null;',
  });
  assert.deepEqual(r['cleanup-unused-files'].evidence.map((e) => e.file), ['src/screens/Old.tsx']);
});

test('cleanup: files used without an import are not unused', () => {
  const r = run({
    ...app,
    'package.json': { ...pkg, scripts: { desktop: 'electron public/electron.js' }, codegenConfig: { jsSrcsDir: './codegen' } },
    'public/electron.js': 'const { app } = require("electron");',
    'verify/run.js': "const fs = require('fs');\nfs.readFileSync(process.argv[2]);",
    'tools/gen.mjs': '#!/usr/bin/env node\nconsole.log(1);',
    'src/helpers/inject.js': 'window.x = 1;',
    'src/helpers/inject.preval.js': "module.exports = require('fs').readFileSync('inject.js', 'utf8');",
    'config/flow/libdef.js': "declare module 'x' { declare module.exports: any; }",
    '.flowconfig': '[libs]\nconfig/flow/libdef.js',
    'scripts2/serve.js': "const express = require('express');\nconst http = require('http');\nconst os = require('os');",
    'watch/oh-package.json5': '{}',
    'watch/entry/app.js': 'export default {};',
    'codegen/NativeThing.ts': "export default TurboModuleRegistry.get('Thing');",
    'web/next.config.mjs': 'export default {};',
    'web/src/pages/_app.tsx': 'export default () => null;',
    'src/utils/quick.windows.ts': 'export const q = 1;',
    'src/utils/quick.ts': 'export const q = 1;',
    'src/screens/Home.tsx': "import logo from '../assets/logo.png';\nimport { fmt } from '../utils/format';\nimport { q } from '../utils/quick';\nexport default () => null;",
    'src/screens/Old.tsx': 'export default () => null;',
  });
  assert.deepEqual(r['cleanup-unused-files'].evidence.map((e) => e.file), ['src/screens/Old.tsx'], 'a script importing express does not make the graph untrusted; a nested project is not the app');
});
