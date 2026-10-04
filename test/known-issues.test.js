import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, matchKnownIssues, KNOWN_ISSUES } from '../src/known-issues.js';

test('version compare', () => {
  assert.equal(compareVersions('2.36.2', '2.37.0'), -1);
  assert.equal(compareVersions('2.37.0', '2.37.0'), 0);
  assert.equal(compareVersions('4.5.0', '4.4.9'), 1);
  assert.equal(compareVersions('4.0.0-rc.7', '4.0.0'), 0);
});

const ids = (args) => matchKnownIssues(args).map((m) => m.issue.id);

test('fs fork 2.37+ on RN 0.77 matches; 2.36.2 or a newer RN does not', () => {
  const dep = (v) => [{ name: '@dr.pogodin/react-native-fs', version: v }];
  assert.deepEqual(ids({ deps: dep('2.40.3'), rnVersion: '0.77.1' }), ['rnfs-fork-codegen-eventemitter']);
  assert.deepEqual(ids({ deps: dep('2.36.2'), rnVersion: '0.77.1' }), []);
  assert.deepEqual(ids({ deps: dep('2.40.3'), rnVersion: '0.85.0' }), []);
});

test('every entry documents where it was seen', () => {
  for (const k of KNOWN_ISSUES) {
    assert.ok(k.source && k.title && k.detail && k.pkg && k.severity, k.id);
  }
});

test('drawer 6 with React Native close to the Reanimated 4 boundary', () => {
  const deps = [{ name: '@react-navigation/drawer', version: '6.6.2' }];
  assert.deepEqual(ids({ deps, rnVersion: '0.80.3' }), ['drawer6-reanimated4']);
  assert.deepEqual(ids({ deps, rnVersion: '0.77.1' }), [], 'not relevant two hops away');
  assert.deepEqual(ids({ deps: [{ name: '@react-navigation/drawer', version: '7.1.0' }], rnVersion: '0.80.3' }), []);
});

test('linear-gradient 2.x only matters with the New Architecture on RN 0.76+', () => {
  const deps = [{ name: 'react-native-linear-gradient', version: '2.8.3' }];
  assert.deepEqual(ids({ deps, rnVersion: '0.80.3', newArchOn: true }), ['linear-gradient-interop-unmount']);
  assert.deepEqual(ids({ deps, rnVersion: '0.77.1', newArchRequired: true }), ['linear-gradient-interop-unmount']);
  assert.deepEqual(ids({ deps, rnVersion: '0.80.3', newArchOn: false }), []);
  assert.deepEqual(ids({ deps, rnVersion: '0.74.5', newArchOn: true }), []);
});
