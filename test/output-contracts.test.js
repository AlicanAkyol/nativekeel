import test from 'node:test';
import assert from 'node:assert/strict';
import { textReport } from '../src/report-text.js';
import { htmlReport } from '../src/report-html.js';
import { markdownReport } from '../src/report-md.js';
import { sarifReport } from '../src/report-sarif.js';
import { sonarReport } from '../src/report-sonar.js';
import { makeProject } from './helpers.js';

// Every way a check records where a finding is, through every exporter. Exporters must not throw,
// and no location may be undefined, carry a stray parenthesis, or fall back to package.json when a
// real file is known.
const root = makeProject({ 'package.json': '{"name":"contracts","dependencies":{"left-pad":"1.0.0"}}' });
const f = (id, extra) => ({ id, severity: 'high', area: 'security', title: `Finding ${id}`, detail: 'Detail.', ...extra });
const findings = [
  f('ev-file', { evidence: [{ file: 'src/a.ts', line: 3 }, { file: 'src/b.ts', line: 4, role: 'second' }] }),
  f('ev-at', { evidence: [{ kind: 'source', at: 'src/c.tsx:5' }, { kind: 'source', at: 'app/(tabs)/[id].tsx:6' }] }),
  f('ev-file-with-line', { evidence: [{ file: 'src/d.ts:7' }] }),
  f('fix-only', { fix: { kind: 'security', file: 'android/app/src/main/AndroidManifest.xml', line: 2 } }),
  f('text-only', { title: 'Something wrong (index.js:6)', detail: 'Also in app/(auth)/login.tsx:9.' }),
  f('no-location', {}),
  f('dep:left-pad', { area: 'dependency', fix: { kind: 'bump-dep', name: 'left-pad' } }),
  f('unicode', { title: 'Ödeme ✓ “quotes” <tag> & ampersand', evidence: [{ at: 'src/ödeme ekranı.tsx:1' }] }),
  f('empty-evidence', { evidence: [null, {}, { role: 'x' }] }),
];
const result = { project: { root, name: 'contracts', reactNative: '0.80.0', newArch: {} }, deps: [], latest: {}, warnings: [], findings, scannedAt: '2026-10-21T00:00:00Z', toolVersion: '0.0.0' };

test('every exporter accepts every location shape', () => {
  assert.doesNotThrow(() => textReport(result, { color: false }));
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.doesNotThrow(() => htmlReport(result));
  assert.doesNotThrow(() => markdownReport(result));
  const sarif = sarifReport(result);
  const sonar = sonarReport(result, { base: root });
  const uris = [
    ...sarif.runs[0].results.flatMap((r) => [r.locations[0].physicalLocation.artifactLocation.uri, ...(r.relatedLocations || []).map((l) => l.physicalLocation.artifactLocation.uri)]).map(decodeURIComponent),
    ...sonar.issues.flatMap((i) => [i.primaryLocation.filePath, ...(i.secondaryLocations || []).map((l) => l.filePath)]),
  ];
  for (const u of uris) {
    assert.equal(typeof u, 'string');
    assert.ok(u && u !== 'undefined' && !/^\(|undefined/.test(u), u);
  }
  const at = (id) => sonar.issues[findings.findIndex((x) => x.id === id)].primaryLocation;
  assert.equal(at('ev-at').filePath, 'src/c.tsx');
  assert.deepEqual(sonar.issues[1].secondaryLocations.map((l) => l.filePath), ['app/(tabs)/[id].tsx']);
  assert.deepEqual([at('ev-file-with-line').filePath, at('ev-file-with-line').textRange.startLine], ['src/d.ts', 7]);
  assert.equal(at('fix-only').filePath, 'android/app/src/main/AndroidManifest.xml');
  assert.equal(at('text-only').filePath, 'index.js');
  assert.equal(at('no-location').filePath, 'package.json');
});
