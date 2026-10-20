import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { sonarReport } from '../src/report-sonar.js';
import { makeProject } from './helpers.js';

test('sonar: generic issue format with rules, impacts and paths relative to the analyzed folder', () => {
  const root = makeProject({ 'package.json': '{\n  "name": "a",\n  "dependencies": {\n    "lodash": "4.17.0"\n  }\n}\n', 'src/App.js': '' });
  const result = {
    project: { root },
    findings: [
      { id: 'secret:aws-access-key:src/App.js', severity: 'critical', area: 'secret', title: 'AWS key', detail: 'Revoke it.', fix: { file: 'src/App.js', line: 6 } },
      { id: 'crash-removed-core-imports', severity: 'high', area: 'crash', title: 'Removed API', detail: 'x', fix: {} },
      { id: 'vuln:lodash', severity: 'high', area: 'security', title: 'lodash', detail: 'y', fix: { name: 'lodash' } },
      { id: 'vuln:other', severity: 'medium', area: 'security', title: 'other', detail: 'z', fix: {} },
      { id: 'note', severity: 'info', area: 'native', title: 'n', detail: '' },
    ],
  };
  const r = sonarReport(result, { base: path.dirname(root) });
  const base = path.basename(root);
  assert.equal(r.issues.length, 4, 'info notes are left out');
  assert.deepEqual(r.issues[0].primaryLocation, { message: '[critical] AWS key. Revoke it.', filePath: `${base}/src/App.js`, textRange: { startLine: 6 } });
  assert.deepEqual(r.issues[2].primaryLocation.filePath, `${base}/package.json`);
  assert.equal(r.issues[2].primaryLocation.textRange.startLine, 4, 'the dependency line');
  const rule = (id) => r.rules.find((x) => x.id === id);
  assert.deepEqual(rule('secret').impacts, [{ softwareQuality: 'SECURITY', severity: 'BLOCKER' }]);
  assert.equal(rule('secret').type, 'VULNERABILITY');
  assert.equal(rule('crash-removed-core-imports').type, 'BUG');
  assert.ok(rule('vuln.high') && rule('vuln.medium'), 'one rule per severity when a check has several');
  assert.ok(r.rules.every((x) => x.engineId === 'nativekeel' && x.name && x.description));
});

test('sonar: locations given as "file:line" or only in the text; secondary locations; scope warning', async () => {
  const { sonarScopeWarning } = await import('../src/report-sonar.js');
  const f = (id, extra) => ({ id, severity: 'medium', area: 'accessibility', title: 't', detail: 'd', ...extra });
  const root = makeProject({ 'package.json': '{"name":"a"}' });
  const result = { project: { root }, findings: [
    f('a11y-icon-button-unlabeled', { evidence: [{ kind: 'source', at: 'src/A.tsx:4' }, { kind: 'source', at: 'src/B.tsx:9' }] }),
    f('perf-console-in-release', { detail: 'see src/screens/Home.tsx:12 and more' }),
  ] };
  const r = sonarReport(result, { base: root });
  assert.deepEqual(r.issues.map((i) => [i.primaryLocation.filePath, i.primaryLocation.textRange.startLine]), [['src/A.tsx', 4], ['src/screens/Home.tsx', 12]]);
  assert.deepEqual(r.issues[0].secondaryLocations.map((l) => l.filePath), ['src/B.tsx']);
  fs.writeFileSync(path.join(root, 'sonar-project.properties'), 'sonar.sources=app\n');
  assert.match(sonarScopeWarning(r, { cwd: root }), /^2 of 2 issues point at files outside sonar.sources \(app\)/);
  fs.writeFileSync(path.join(root, 'sonar-project.properties'), 'sonar.sources=src\n');
  assert.equal(sonarScopeWarning(r, { cwd: root }), null);
});
