import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeReport, upgradeText } from '../src/upgrade.js';
import { NEXT } from '../src/upcoming.js';
import { analyze } from '../src/analyze.js';
import { loadProject } from '../src/project.js';
import { makeProject, fakeRegistry } from './helpers.js';
import { spawnSync } from 'node:child_process';

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

const expoFiles = (extra = {}) => ({
  'package.json': { name: 'expo-coverage', dependencies: { expo: '~57.0.9', 'react-native': '0.86.3', 'expo-camera': '~18.0.0' } },
  ...extra,
});
const expoPins = { 'react-native': '0.86.3', 'expo-camera': '~18.0.0' };
const scanExpo = (files, options = {}) => analyze(loadProject(makeProject(files)), { get: async () => null, offline: true, ...options });

test('upgrade: offline Expo without SDK metadata is partial in both CLI text and JSON', async () => {
  const root = makeProject(expoFiles());
  const cli = new URL('../bin/nativekeel.js', import.meta.url);
  for (const json of [false, true]) {
    const run = spawnSync(process.execPath, [cli.pathname, 'upgrade', root, '--offline', '--no-color', ...(json ? ['--json'] : [])], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    if (json) {
      const report = JSON.parse(run.stdout);
      assert.equal(report.status, 'partial');
      assert.equal(report.catalogCoverage, 'full');
      assert.equal(report.coverage, 'partial');
      assert.ok(report.checks.every((c) => c.status === 'skipped'));
    } else {
      assert.match(run.stdout, /PARTIALLY EVALUATED/);
      assert.match(run.stdout, /Skipped — Expo \/ React Native compatibility/);
      assert.doesNotMatch(run.stdout, /READY|MULTI-VERSION JUMP/);
    }
  }
});

test('upgrade: installed Expo pins and resolved packages can be checked offline', async () => {
  const scan = await scanExpo(expoFiles({
    'node_modules/expo/package.json': { version: '57.0.9' },
    'node_modules/expo/bundledNativeModules.json': expoPins,
    'node_modules/react-native/package.json': { version: '0.86.3' },
    'node_modules/expo-camera/package.json': { version: '18.0.2' },
  }));
  const report = upgradeReport(scan);
  assert.equal(report.status, 'ready');
  assert.ok(report.checks.every((c) => c.status === 'checked' && c.source === 'installed'));
  assert.match(render(report), /Checked — Expo package version compatibility/);
});

test('upgrade: available pins cannot certify a declared package with no resolved version', async () => {
  const report = upgradeReport(await scanExpo(expoFiles({
    'node_modules/expo/package.json': { version: '57.0.9' },
    'node_modules/expo/bundledNativeModules.json': expoPins,
  })));
  assert.equal(report.status, 'partial');
  assert.equal(report.checks[0].status, 'checked');
  assert.equal(report.checks[1].status, 'skipped');
  assert.match(report.checks[1].reason, /expo-camera/);
});

test('upgrade: lockfile plus fetched metadata supports online checks; network failure stays partial', async () => {
  const files = expoFiles({ 'package-lock.json': { lockfileVersion: 3, packages: {
    'node_modules/expo': { version: '57.0.9' },
    'node_modules/react-native': { version: '0.86.3' },
    'node_modules/expo-camera': { version: '18.0.2' },
  } } });
  const registry = fakeRegistry();
  const get = (url, ...args) => url === 'https://unpkg.com/expo@57.0.9/bundledNativeModules.json' ? expoPins : registry(url, ...args);
  const report = upgradeReport(await scanExpo(files, { offline: false, get }));
  assert.equal(report.status, 'ready');
  assert.ok(report.checks.every((c) => c.status === 'checked' && c.source === 'registry'));
  const failed = upgradeReport(await scanExpo(files, { offline: false, get: registry }));
  assert.equal(failed.status, 'partial');
  assert.ok(failed.checks.every((c) => c.status === 'skipped'));
});

test('upgrade: blockers retain priority over incomplete metadata, including the newest SDK', async () => {
  const project = { reactNative: '0.81.5', expo: `${NEXT.expo.sdk}.0.0` };
  const missing = upgradeReport(result(project));
  assert.equal(missing.status, 'partial');
  assert.doesNotMatch(render(missing), /Up to date/);
  const blocked = upgradeReport(result(project, [{ id: 'expo-rn-mismatch', title: 'React Native mismatch', detail: 'Use the SDK version.' }]));
  assert.equal(blocked.status, 'blocked');
  assert.match(render(blocked), /NOT READY/);
  assert.equal(blocked.coverage, 'partial');
});

test('upgrade: malformed pins stay partial and explicit package exclusions remain visible', async () => {
  const files = expoFiles({
    'node_modules/expo/package.json': { version: '57.0.9' },
    'node_modules/expo/bundledNativeModules.json': { 'expo-camera': '~18.0.0' },
  });
  const malformed = upgradeReport(await scanExpo(files));
  assert.equal(malformed.status, 'partial');
  assert.ok(malformed.checks.every((c) => c.status === 'skipped'));
  files['node_modules/expo/bundledNativeModules.json'] = expoPins;
  files['package.json'].expo = { install: { exclude: ['expo-camera'] } };
  const excluded = upgradeReport(await scanExpo(files));
  assert.equal(excluded.status, 'ready');
  assert.match(excluded.checks[1].reason, /expo.install.exclude/);
});

test('upgrade: resolved incompatible Expo packages remain blockers with checked coverage', async () => {
  const report = upgradeReport(await scanExpo(expoFiles({
    'node_modules/expo/package.json': { version: '57.0.9' },
    'node_modules/expo/bundledNativeModules.json': expoPins,
    'node_modules/react-native/package.json': { version: '0.81.5' },
    'node_modules/expo-camera/package.json': { version: '16.0.0' },
  })));
  assert.equal(report.status, 'blocked');
  assert.equal(report.coverage, 'full');
  assert.ok(report.checks.every((c) => c.status === 'checked'));
  assert.ok(report.blockers.some((b) => b.id === 'expo-rn-mismatch'));
  assert.ok(report.blockers.some((b) => b.id === 'expo-sdk-mismatch'));
});
