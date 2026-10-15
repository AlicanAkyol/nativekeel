import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeSourceMap, bundleChecks, findBundleMaps, annotateWithBundle, compareBundles, compareText } from '../src/bundle-map.js';
import { makeProject } from './helpers.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (n) => { let v = n < 0 ? (-n << 1) | 1 : n << 1, out = ''; do { let d = v & 31; v >>>= 5; if (v) d |= 32; out += B64[d]; } while (v); return out; };
// One generated line; each entry [column, sourceIndex]. Columns and sources are delta-encoded.
const mapOf = (sources, segments, extra = {}) => {
  let col = 0, src = 0;
  const mappings = segments.map(([c, s]) => { const seg = vlq(c - col) + vlq(s - src) + vlq(0) + vlq(0); col = c; src = s; return seg; }).join(',');
  return JSON.stringify({ version: 3, sources, names: [], mappings, ...extra });
};
const sources = ['/src/App.tsx', '/node_modules/lodash/lodash.js', '/node_modules/a/node_modules/lodash/lodash.js', '/node_modules/@scope/pkg/index.js', '/src/data/big.json'];

test('source map bytes are attributed to app code and packages; second copies are found', () => {
  const r = analyzeSourceMap(mapOf(sources, [[0, 0], [100, 1], [5100, 2], [8100, 3], [8300, 4], [8400, 0], [8410, 0]], { x_hermes_function_offsets: {} }));
  assert.equal(r.hermes, true);
  assert.equal(r.mappedBytes, 8410);
  assert.equal(r.appBytes, 100 + 100 + 10);
  assert.deepEqual(r.packages.map((p) => [p.name, p.bytes]), [['lodash', 8000], ['@scope/pkg', 200]]);
  assert.deepEqual(r.duplicates.map((d) => [d.name, d.copies.map((c) => c.bytes)]), [['lodash', [5000, 3000]]]);
  assert.deepEqual(r.json.map((j) => j.source), ['/src/data/big.json']);
  assert.throws(() => analyzeSourceMap('{"version":2}'), /version 3/);
});

test('the scan finds the release map a build left behind and reports measured duplicates', () => {
  const map = mapOf(sources, [[0, 0], [100, 1], [5100, 2], [8100, 3], [8300, 0], [8310, 0]]);
  const root = makeProject({ 'package.json': { name: 'x', dependencies: { 'react-native': '0.80.0' } } });
  try {
    const rel = 'android/app/build/generated/sourcemaps/react/release/index.android.bundle.map';
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), map);
    assert.deepEqual(findBundleMaps(root).map((m) => m.file), [rel]);
    const { findings, measured } = bundleChecks(root);
    assert.equal(measured.mappedBytes, 8310);
    assert.match(findings[0].title, /^JavaScript bundle measured: 8 KB of mapped code/);
    const dup = findings.find((f) => f.id === 'bundle-duplicate-packages');
    assert.match(dup.title, /1 package is bundled more than once \(3 KB extra, measured\)/);
    assert.match(dup.fix.step, /npm ls lodash/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no map, no bundle findings', () => {
  const root = makeProject({ 'package.json': { name: 'x', dependencies: { 'react-native': '0.80.0' } } });
  try { assert.deepEqual(bundleChecks(root).findings, []); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('heavy-import findings get the measured bundle bytes, or say the package is not in the bundle', () => {
  const analysis = analyzeSourceMap(mapOf(['/src/App.tsx', '/node_modules/lodash/lodash.js', '/node_modules/moment/moment.js', '/node_modules/moment/locale/de.js'], [[0, 0], [1000, 1], [3048, 2], [4072, 3], [5096, 0], [5100, 0]]));
  const bundle = { analysis, measured: { file: 'dist/x.hbc.map', mappedBytes: analysis.mappedBytes, stale: false } };
  const findings = [{ id: 'perf-heavy-imports', title: 'Review root imports of lodash and moment', detail: 'Source pattern.', evidence: [] }];
  annotateWithBundle(findings, bundle);
  assert.match(findings[0].detail, /Measured in dist\/x\.hbc\.map: lodash is 2 KB \(40\.2%\) of the measured bundle; moment is 2 KB \(40\.2%\) of the measured bundle, 1 KB of it locale files\./);
  const onlyApp = { analysis: analyzeSourceMap(mapOf(['/src/App.tsx'], [[0, 0], [100, 0]])), measured: { file: 'm.map', stale: true } };
  const f2 = [{ id: 'perf-heavy-imports', title: 'Review root imports of lodash', detail: 'Source pattern.' }];
  annotateWithBundle(f2, onlyApp);
  assert.match(f2[0].detail, /Measured in m\.map \(older than package\.json\): lodash is not in the measured bundle\./);
});

test('MCP measure_bundle measures a map inside the project and refuses one outside it', async () => {
  const { handle } = await import('../src/mcp.js');
  const root = makeProject({ 'package.json': { name: 'x', dependencies: { 'react-native': '0.80.0' } }, 'dist/app.js.map': mapOf(sources, [[0, 0], [100, 1], [5100, 2], [8100, 0], [8110, 0]]) });
  const outside = makeProject({ 'leak.map': mapOf(sources, [[0, 0], [10, 0]]) });
  const call = (args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'measure_bundle', arguments: { path: root, ...args } } }, { version: 'test', roots: [fs.realpathSync(root)] });
  try {
    const ok = await call({ map: 'dist/app.js.map' });
    const data = JSON.parse(ok.result.content[0].text);
    assert.equal(data.found, true);
    assert.deepEqual(data.packages.map((p) => p.name), ['lodash']);
    assert.equal(data.duplicates[0].name, 'lodash');
    const none = JSON.parse((await call({})).result.content[0].text);
    assert.equal(none.found, false);
    const bad = await call({ map: path.relative(root, path.join(outside, 'leak.map')) });
    assert.ok(bad.result?.isError || bad.error);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('comparing two builds shows what was added, removed, changed and newly duplicated', () => {
  const before = analyzeSourceMap(mapOf(['/src/App.tsx', '/node_modules/moment/moment.js', '/node_modules/lodash/lodash.js'], [[0, 0], [1000, 1], [6000, 2], [9000, 0], [9010, 0]]));
  const after = analyzeSourceMap(mapOf(['/src/App.tsx', '/node_modules/dayjs/dayjs.js', '/node_modules/lodash/lodash.js', '/node_modules/x/node_modules/lodash/lodash.js'], [[0, 0], [2000, 1], [4000, 2], [7000, 3], [9048, 0], [9058, 0]]));
  const d = compareBundles(before, after);
  assert.equal(d.comparable, true);
  assert.deepEqual(d.added.map((c) => [c.name, c.delta]), [['dayjs', 2000]]);
  assert.deepEqual(d.removed.map((c) => [c.name, c.delta]), [['moment', -5000]]);
  assert.deepEqual(d.changed.map((c) => [c.name, c.before, c.after]), [['lodash', 3000, 5048]]);
  assert.deepEqual(d.newDuplicates.map((x) => x.name), ['lodash']);
  const text = compareText(d, 'old.map', 'new.map');
  assert.match(text, /New in the bundle:\n\s+\+2 KB  dayjs/);
  assert.match(text, /No longer in the bundle:\n\s+−5 KB  moment/);
  assert.match(text, /Now bundled more than once:/);
  assert.match(compareText(compareBundles(before, before), 'a', 'b'), /No package changed size by 1 KB or more\./);
  assert.match(compareText(compareBundles(before, { ...after, hermes: true }), 'a', 'b'), /not comparable/);
});

test('MCP measure_bundle compares against a base map inside the project', async () => {
  const { handle } = await import('../src/mcp.js');
  const root = makeProject({
    'package.json': { name: 'x', dependencies: { 'react-native': '0.80.0' } },
    'old.map': mapOf(['/src/App.tsx', '/node_modules/moment/moment.js'], [[0, 0], [100, 1], [5100, 0], [5110, 0]]),
    'new.map': mapOf(['/src/App.tsx', '/node_modules/dayjs/dayjs.js'], [[0, 0], [100, 1], [2148, 0], [2158, 0]]),
  });
  try {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'measure_bundle', arguments: { path: root, map: 'new.map', base: 'old.map' } } }, { version: 'test', roots: [fs.realpathSync(root)] });
    const d = JSON.parse(res.result.content[0].text);
    assert.deepEqual([d.added.map((c) => c.name), d.removed.map((c) => c.name)], [['dayjs'], ['moment']]);
    assert.equal(d.total.delta, -2952);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
