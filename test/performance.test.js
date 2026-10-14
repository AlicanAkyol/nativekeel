import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { loadProject } from '../src/project.js';
import { performanceChecks } from '../src/performance.js';
import { makeProject } from './helpers.js';

const ids = (files) => performanceChecks(loadProject(makeProject({ 'package.json': { name: 'p', dependencies: { 'react-native': '0.80.0' } }, ...files }))).map((f) => f.id);

test('nested vertical lists, not horizontal ones or TypeScript generics', () => {
  assert.ok(ids({ 'src/A.js': '<ScrollView>\n  <FlatList data={d} renderItem={({ item }) => <Row item={item} />} />\n</ScrollView>' }).includes('perf-nested-lists'));
  assert.ok(!ids({ 'src/A.js': '<ScrollView>\n  <FlatList\n    renderItem={({ item }) => <Row />}\n    horizontal\n  />\n</ScrollView>' }).includes('perf-nested-lists'), 'horizontal after an arrow function');
  assert.ok(!ids({ 'src/A.tsx': 'const ref = useRef<ScrollView>(null);\nreturn <FlatList data={d} />;' }).includes('perf-nested-lists'), 'a generic is not a tag');
});

test('JS-driven animations, console logs, heavy imports', () => {
  const anim = Array.from({ length: 3 }, () => 'Animated.timing(v, { toValue: 1, useNativeDriver: false }).start();').join('\n');
  assert.ok(ids({ 'src/A.js': anim }).includes('perf-js-driven-animations'));
  const logs = Array.from({ length: 30 }, (_, i) => `console.log('x${i}');`).join('\n');
  assert.ok(ids({ 'src/A.js': logs }).includes('perf-console-in-release'));
  assert.ok(!ids({ 'src/A.js': logs, 'babel.config.js': "module.exports = { env: { production: { plugins: ['transform-remove-console'] } } };" }).includes('perf-console-in-release'));
  assert.ok(ids({ 'src/A.js': "import _ from 'lodash';\nimport moment from 'moment';" }).includes('perf-heavy-imports'));
  assert.ok(!ids({ 'src/A.js': "import debounce from 'lodash/debounce';" }).includes('perf-heavy-imports'));
});

test('large images count only when the app requires them', () => {
  const big = 'x'.repeat(600 * 1024);
  assert.ok(ids({ 'src/assets/hero.png': big, 'src/A.js': "const img = require('./assets/hero.png');" }).includes('perf-large-images'));
  assert.ok(!ids({ 'docs/screenshot.png': big, 'src/A.js': 'export default 1;' }).includes('perf-large-images'), 'repo screenshots are not in the app');
});

test('Redux selectors that return a new object every time', async () => {
  const { performanceChecks } = await import('../src/performance.js');
  const ids = (code) => performanceChecks({ root: makeProject({ 'package.json': '{}', 'src/A.js': code }) }).map((f) => f.id);
  assert.ok(ids("const { a, b } = useSelector(state => ({ a: state.a, b: state.b }));").includes('perf-redux-selector-new-object'));
  assert.ok(ids("const g = useSelector((state) => state.guide[id] || {});").includes('perf-redux-selector-new-object'));
  assert.ok(!ids("const v = useSelector(state => ({ a: state.a }), shallowEqual);").includes('perf-redux-selector-new-object'));
  assert.ok(!ids("const a = useSelector((state) => state.a);").includes('perf-redux-selector-new-object'));
});

test('performance findings point at the right line even after block comments', async () => {
  const { performanceChecks } = await import('../src/performance.js');
  const code = "/*\n a\n b\n c\n*/\nconst x = useSelector(state => ({ a: state.a }));";
  const f = performanceChecks({ root: makeProject({ 'package.json': '{}', 'src/A.js': code }) }).find((x) => x.id === 'perf-redux-selector-new-object');
  assert.match(f.title, /src\/A\.js:6/);
});

test('import recommendations state evidence and unknown benefit, not automatic replacement', () => {
  const root = makeProject({ 'src/App.js': "import { debounce } from 'lodash';\nimport moment from 'moment';" });
  const finding = performanceChecks({ root }).find((f) => f.id === 'perf-heavy-imports');
  assert.equal(finding.recommendation.status, 'needs-verification');
  assert.equal(finding.recommendation.measuredBenefit, null);
  assert.equal(finding.recommendation.automaticFix, false);
  assert.equal(finding.recommendation.evidence[0].file, 'src/App.js:1');
  assert.doesNotMatch(JSON.stringify(finding), /hundreds of KB|use dayjs|use lodash-es|pulls in all locales/);
  assert.match(finding.detail, /No size or startup saving has been measured/);
});

test('comments, string examples, type imports and property calls are not import evidence', () => {
  for (const code of [
    `// import _ from 'lodash';`,
    `const example = "import _ from 'lodash';";`,
    "const example = `require('lodash')`;",
    `const example = /require\\('lodash'\\)/;`,
    `import type { DebouncedFunc } from 'lodash';`,
    `loader.require('lodash');`,
    `import debounce from 'lodash/debounce';`,
  ]) assert.ok(!ids({ 'src/A.ts': code }).includes('perf-heavy-imports'), code);
});

test('large JSON imported into the bundle: translations and Lottie get specific advice; tests and dynamic imports do not count', () => {
  const big = (extra = '') => `{${extra}"data":"${'x'.repeat(320 * 1024)}"}`;
  const root = makeProject({
    'package.json': { name: 'fixture', dependencies: { 'react-native': '0.80.0' } },
    'src/i18n.js': "import en from './locales/en.json';\nimport de from './locales/de.json';\nconst lazy = () => import('./locales/fr.json');",
    'src/locales/en.json': big(), 'src/locales/de.json': big(), 'src/locales/fr.json': big(),
    'src/Loader.js': "const anim = require('./anim/loader.json');",
    'src/anim/loader.json': big('"nm":"x","ddd":0,"layers":[],"ip":0,'),
    'src/__fixtures__/api.js': "import r from './response.json';",
    'src/__fixtures__/response.json': big(),
  });
  try {
    const f = performanceChecks(loadProject(root)).find((x) => x.id === 'perf-large-json');
    assert.ok(f);
    assert.match(f.title, /^3 JSON files over 300 KB/);
    assert.match(f.detail, /2 look like translations: load only the active language/);
    assert.match(f.detail, /1 is a Lottie animation: \.lottie files load as assets/);
    assert.deepEqual(f.evidence.map((e) => e.file).sort(), ['src/anim/loader.json', 'src/locales/de.json', 'src/locales/en.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('large JSON required inside a function is bundled but described as evaluated only when used', () => {
  const big = `{"data":"${'x'.repeat(320 * 1024)}"}`;
  const root = makeProject({
    'package.json': { name: 'fixture', dependencies: { 'react-native': '0.80.0' } },
    'src/map.ts': "let cached;\nexport function load() {\n  if (!cached) cached = require('./world.json');\n  return cached;\n}\n",
    'src/world.json': big,
  });
  try {
    const f = performanceChecks(loadProject(root)).find((x) => x.id === 'perf-large-json');
    assert.match(f.detail, /every user downloads it\. It is required inside a function, so evaluated only when that code runs\./);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
