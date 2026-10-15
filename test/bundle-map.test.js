import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeSourceMap, bundleChecks, findBundleMaps } from '../src/bundle-map.js';
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
