import test from 'node:test';
import assert from 'node:assert/strict';
import { devServerCve } from '../src/dev-server-cve.js';
import { makeProject } from './helpers.js';

const npmLock = (entries) => JSON.stringify({ name: 'a', lockfileVersion: 3, packages: Object.fromEntries([['', {}], ...Object.entries(entries).map(([n, v]) => [`node_modules/${n}`, { version: v }])]) });

test('dev-server CVE: a vulnerable cli-server-api version in the lockfile is flagged critical', () => {
  const root = makeProject({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.81.0' } }, 'package-lock.json': npmLock({ '@react-native-community/cli-server-api': '18.0.0', '@react-native-community/cli': '18.0.0' }) });
  const f = devServerCve(root);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'critical');
  assert.equal(f[0].id, 'dev-server-rce-cve-2025-11953');
  assert.match(f[0].detail, /CVE-2025-11953|GHSA-399j/);
  assert.match(f[0].detail, /18\.0\.0/);
});

test('dev-server CVE: a patched version is not flagged', () => {
  for (const v of ['18.0.1', '19.1.2', '20.0.0', '20.1.0', '17.0.0']) {
    const root = makeProject({ 'package.json': { name: 'a' }, 'package-lock.json': npmLock({ '@react-native-community/cli-server-api': v }) });
    assert.deepEqual(devServerCve(root), [], `${v} should be safe`);
  }
});

test('dev-server CVE: a vulnerable transitive copy is caught even when a safe copy also exists', () => {
  // yarn.lock style: two resolutions for the same package, one safe, one vulnerable.
  const yarn = [
    '"@react-native-community/cli-server-api@npm:20.0.2":',
    '  version "20.0.2"',
    '"@react-native-community/cli-server-api@npm:^19.1.0":',
    '  version "19.1.1"',
    '',
  ].join('\n');
  const root = makeProject({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.82.0' } }, 'yarn.lock': yarn });
  const f = devServerCve(root);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /19\.1\.1/);
  assert.doesNotMatch(f[0].detail, /20\.0\.2/, 'the safe copy is not listed as vulnerable');
});

test('dev-server CVE: nothing when no cli is resolvable', () => {
  const root = makeProject({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.74.0' } } });
  assert.deepEqual(devServerCve(root), []);
});
