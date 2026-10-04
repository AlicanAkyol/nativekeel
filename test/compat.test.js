import test from 'node:test';
import assert from 'node:assert/strict';
import { bestRange, checkCompat } from '../src/compat.js';

test('react-native-screens: newest range per React Native version and architecture', () => {
  assert.equal(bestRange('react-native-screens', 77, true).range, '4.5–4.13.x');
  assert.equal(bestRange('react-native-screens', 80, true).range, '4.14–4.18.x');
  assert.equal(bestRange('react-native-screens', 87, true).range, '4.26+');
  assert.equal(bestRange('react-native-screens', 80, false).range, '4.19–4.24.x');
  assert.equal(bestRange('react-native-screens', 82, true).range, '4.25.x', 'single-minor range');
});

test('installed versions that cannot work are reported', () => {
  assert.match(checkCompat('react-native-screens', '4.28.0', 77, true), /supports React Native 0.84\+, not 0.77/);
  assert.match(checkCompat('react-native-screens', '4.28.0', 87, false), /does not support the legacy Architecture/);
  assert.equal(checkCompat('react-native-screens', '4.13.1', 77, true), null);
  assert.equal(checkCompat('react-native-screens', '3.29.0', 77, true), null, 'versions the table does not cover: no claim');
});

test('Reanimated 4 needs the New Architecture and a bounded React Native range', () => {
  assert.match(checkCompat('react-native-reanimated', '4.7.1', 87, false), /does not support the legacy/);
  assert.match(checkCompat('react-native-reanimated', '4.1.0', 84, true), /0.78–0.82, not 0.84/);
  assert.equal(bestRange('react-native-reanimated', 77, true).range, '3.18.x', 'newest Reanimated 3 range that includes RN 0.77');
  assert.equal(bestRange('react-native-reanimated', 80, true).range, '4.2.x', '4.3 starts at 0.81 (Reanimated compatibility.json)');
  assert.equal(bestRange('react-native-reanimated', 80, true, { major: 3 }).range, '3.19.x', 'same-major option');
  assert.equal(checkCompat('react-native-reanimated', '3.17.5', 77, true), null);
  assert.match(checkCompat('react-native-reanimated', '3.17.5', 80, true), /0.75–0.79, not 0.80/);
  // Expo SDK 51 pairs Reanimated 3.10 with React Native 0.74 on the legacy architecture.
  assert.equal(checkCompat('react-native-reanimated', '3.10.1', 74, false), null);
});

test('Gesture Handler: 2.x minimums and 3.x needs RN 0.82', () => {
  assert.equal(bestRange('react-native-gesture-handler', 80, true, { major: 2 }).range, '2.28–2.31.x');
  assert.match(checkCompat('react-native-gesture-handler', '2.33.0', 80, true), /0.84\+, not 0.80/);
  assert.equal(bestRange('react-native-gesture-handler', 84, true).range, '3.0+');
  assert.equal(bestRange('react-native-gesture-handler', 84, true, { major: 2 }).range, '2.32–2.99.x');
});
