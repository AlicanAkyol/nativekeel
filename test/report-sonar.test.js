import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
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
