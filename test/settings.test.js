import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSettings, applySettings } from '../src/settings.js';
import { makeProject, FAKE_AWS_ID } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nativekeel.js');
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('settings: ignores need a reason; prefixes with *; bad values are reported, not applied', () => {
  const root = makeProject({ '.nativekeel.json': { failOn: 'sometimes', ignore: [{ id: 'flipper', reason: 'Removed next sprint' }, { id: 'secret:*', reason: 'Test keys' }, { id: 'a11y-x' }, { id: '*', reason: 'everything' }] } });
  const s = readSettings(root);
  assert.equal(s.failOn, undefined);
  assert.deepEqual(s.ignore.map((i) => i.id), ['flipper', 'secret:*']);
  assert.equal(s.warnings.length, 3);
  const { findings, ignored } = applySettings([{ id: 'flipper', severity: 'medium' }, { id: 'secret:aws:src/a.js', severity: 'critical' }, { id: 'flipperish', severity: 'low' }], s);
  assert.deepEqual(findings.map((f) => f.id), ['flipperish']);
  assert.deepEqual(ignored.map((i) => i.reason), ['Removed next sprint', 'Test keys']);
  assert.deepEqual(applySettings([{ id: 'malicious-code', severity: 'critical' }, { id: 'vscode-autorun-task', severity: 'critical' }], { ignore: [{ id: 'm*', reason: 'x' }, { id: 'v*', reason: 'x' }] }).ignored, [], 'malware warnings cannot be ignored');
  assert.equal(readSettings(makeProject({ 'x.txt': '' })), null);
  assert.match(readSettings(makeProject({ '.nativekeel.json': '{ nope' })).warnings[0], /not valid JSON/);
});

test('settings: the committed file sets the gate and hides accepted findings; --fail-on still wins', () => {
  const base = { 'package.json': { name: 's', dependencies: { 'react-native': '0.80.0' } }, 'src/keys.js': `export const k = '${FAKE_AWS_ID}';\n` };
  assert.equal(run([makeProject(base), '--offline']).status, 1);
  const ignored = makeProject({ ...base, '.nativekeel.json': { ignore: [{ id: 'secret:aws-access-key:*', reason: 'AWS documentation example key' }] } });
  const res = run([ignored, '--offline']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /\.nativekeel\.json: 1 finding ignored by the team \(secret:aws-access-key:src\/keys\.js: AWS documentation example key\)/);
  const json = JSON.parse(run([ignored, '--offline', '--json']).stdout);
  assert.equal(json.settings.ignored.length, 1);
  assert.equal(json.ratings.find((r) => r.key === 'security').rating, 'A');
  const strict = makeProject({ 'package.json': { name: 's', dependencies: { 'react-native': '0.80.0' } }, 'android/app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:usesCleartextTraffic="true"/></manifest>', '.nativekeel.json': { failOn: 'medium' } });
  assert.equal(run([strict, '--offline']).status, 1, 'failOn medium from the file');
  assert.equal(run([strict, '--offline', '--fail-on', 'critical']).status, 0, 'the flag overrides the file');
});

test('settings: exclude leaves out findings whose files are all in the folder', () => {
  const root = makeProject({ '.nativekeel.json': { exclude: [{ path: './tools/admin-web/', reason: 'Separate web project' }, { path: 'docs' }, { path: '../outside', reason: 'x' }, { path: 'a/*.js', reason: 'x' }] } });
  const s = readSettings(root);
  assert.deepEqual(s.exclude, [{ path: 'tools/admin-web', reason: 'Separate web project' }]);
  assert.equal(s.warnings.length, 3);
  const findings = [
    { id: 'secret:x:tools/admin-web/a.js', severity: 'high', title: 't1', fix: { file: 'tools/admin-web/a.js' } },
    { id: 'mixed', severity: 'low', title: 't2', evidence: [{ file: 'tools/admin-web/b.js' }, { file: 'src/App.js' }] },
    { id: 'nofile', severity: 'low', title: 't3' },
    { id: 'prefix', severity: 'low', title: 't4', fix: { file: 'tools/admin-website/a.js' } },
    { id: 'malicious-code', severity: 'critical', title: 't5', fix: { file: 'tools/admin-web/x.js' } },
  ];
  const { findings: kept, ignored } = applySettings(findings, s);
  assert.deepEqual(kept.map((f) => f.id), ['mixed', 'nofile', 'prefix', 'malicious-code']);
  assert.match(ignored[0].reason, /tools\/admin-web\/ excluded: Separate web project/);
});
