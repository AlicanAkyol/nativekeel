import test from 'node:test';
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
