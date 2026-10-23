import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeReport, upgradeText } from '../src/upgrade.js';
import { NEXT } from '../src/upcoming.js';

const render = (r) => upgradeText(r); // no color helper → plain strings, must not throw

// A scan result trimmed to what upgrade reads.
const result = (project, findings = []) => ({ project, findings });

test('upgrade: a removed API in app code blocks the upgrade with its location', () => {
  const r = upgradeReport(result({ reactNative: `0.${NEXT.rn.minor - 2}.0` }, [
    { id: 'upcoming-changes', severity: 'low', area: 'react-native', fix: { kind: 'upcoming', changes: [
      { id: 'rn87-statusbar-props', version: 'React Native 0.87', kind: 'removed', title: 'StatusBar props removed', hits: ['App.js:12'], action: 'Remove them.' },
      { id: 'rn87-color-scheme-unspecified', version: 'React Native 0.87', kind: 'behavior', title: 'useColorScheme no longer returns unspecified', hits: ['src/theme.ts:4'], action: 'Treat null as system.' },
    ] } },
  ]));
  assert.equal(r.status, 'blocked');
  assert.equal(r.coverage, 'full');
  assert.equal(r.counts.blockers, 1);
  assert.equal(r.blockers[0].where[0], 'App.js:12');
  assert.equal(r.notes.length, 1);
  assert.match(render(r), /NOT READY/);
  assert.match(render(r), /App\.js:12/);
});

test('upgrade: a library that cannot compile or load is a blocker', () => {
  const r = upgradeReport(result({ reactNative: `0.${NEXT.rn.minor - 1}.0` }, [
    { id: 'upcoming-changes', fix: { kind: 'upcoming', changes: [
      { id: 'rn87-bare-includes', version: 'React Native 0.87', kind: 'removed', title: 'React headers without React/ stop the iOS build', hits: ['some-lib 1.2.3 (ios/X.h:1)'], action: 'Patch it.' },
    ] } },
    { id: 'interop-job:react-native-foo', severity: 'high', area: 'react-native', title: 'react-native-foo will not load through interop', detail: 'Job return.', fix: { kind: 'interop-job', name: 'react-native-foo', methods: [] } },
  ]));
  assert.equal(r.status, 'blocked');
  assert.equal(r.counts.blockers, 2);
  assert.ok(r.blockers.some((b) => b.kind === 'library-ios-build'));
  assert.ok(r.blockers.some((b) => b.kind === 'library-interop'));
});

test('upgrade: no blockers one step back reads as ready', () => {
  const r = upgradeReport(result({ reactNative: `0.${NEXT.rn.minor - 1}.0` }, []));
  assert.equal(r.status, 'ready');
  assert.equal(r.coverage, 'full');
  assert.match(render(r), /READY — no blockers/);
});

test('upgrade: a multi-version jump is never a clean go, even with no catalog hits', () => {
  const r = upgradeReport(result({ reactNative: `0.${NEXT.rn.minor - 6}.0` }, []));
  assert.equal(r.status, 'partial');
  assert.equal(r.coverage, 'partial');
  assert.match(render(r), /MULTI-VERSION JUMP/);
  assert.match(r.cantKnow.join(' '), /multi-version jump/i);
  assert.match(r.cantKnow.join(' '), /one version at a time/);
});

test('upgrade: an Expo multi-version jump is partial too', () => {
  const r = upgradeReport(result({ reactNative: '0.76.0', expo: `${NEXT.expo.sdk - 6}.0.0` }, []));
  assert.equal(r.coverage, 'partial');
  assert.match(render(r), /Expo SDK/);
});

test('upgrade: already on the newest line says up to date', () => {
  const r = upgradeReport(result({ reactNative: `0.${NEXT.rn.minor}.0` }, []));
  assert.equal(r.status, 'current');
  assert.match(render(r), /Up to date/);
});

test('upgrade: no React Native or Expo detected', () => {
  const r = upgradeReport(result({}, []));
  assert.equal(r.status, 'unknown');
  assert.doesNotThrow(() => render(r));
});

test('upgrade: end of support is shown with the verdict, not as a limit of the scan', () => {
  const r = upgradeReport(result({ reactNative: `0.${NEXT.rn.minor - 1}.0` }, [{ id: 'rn-unsupported', severity: 'critical', area: 'react-native', title: 'React Native 0.87.0 is no longer supported' }]));
  assert.deepEqual(r.support, ['React Native 0.87.0 is no longer supported']);
  assert.ok(!r.cantKnow.some((k) => /no longer supported/.test(k)));
  assert.match(render(r), /! React Native 0\.87\.0 is no longer supported/);
});

test('upgrade: a long action is shortened but its guide link stays whole', () => {
  const url = 'https://nativekeel.com/fix/statusbar-backgroundcolor-translucent-removed-react-native-0-87';
  const r = upgradeReport(result({ reactNative: `0.${NEXT.rn.minor - 1}.0` }, [
    { id: 'upcoming-changes', fix: { kind: 'upcoming', changes: [{ id: 'x', version: 'React Native 0.87', kind: 'removed', title: 'Long one', hits: ['a.js:1'], action: `${'word '.repeat(80)}${url}` }] } },
  ]));
  const text = render(r);
  assert.ok(text.includes(url), 'the full link is printed');
  assert.match(text, /…/);
});

test('upgrade: the hand-over line shows only when there is upgrade work', () => {
  const blocked = upgradeReport(result({ reactNative: `0.${NEXT.rn.minor - 1}.0` }, [
    { id: 'upcoming-changes', fix: { kind: 'upcoming', changes: [{ id: 'x', version: 'React Native 0.87', kind: 'removed', title: 'Gone', hits: ['a.js:1'], action: 'Fix it.' }] } },
  ]));
  assert.match(render(blocked), /hello@nativekeel\.com/);
  const ready = upgradeReport(result({ reactNative: `0.${NEXT.rn.minor - 1}.0` }, []));
  assert.doesNotMatch(render(ready), /hello@nativekeel\.com/);
});
