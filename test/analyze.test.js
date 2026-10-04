import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../src/project.js';
import { analyze } from '../src/analyze.js';
import { buildPlan } from '../src/plan.js';
import { applyBaseline, saveBaseline } from '../src/baseline.js';
import { makeProject, fakeRegistry, FAKE_AWS_ID, FAKE_AWS_SECRET } from './helpers.js';

const NOW = new Date('2026-10-03T12:00:00Z');

function bareApp() {
  return makeProject({
    'package.json': {
      name: 'demo',
      dependencies: { 'react-native': '0.77.1', react: '18.3.1', 'react-native-fast-image': '^8.6.3', 'some-js-lib': '^1.0.0', '@babel/core': '^7.0.0' },
    },
    'node_modules/react-native/package.json': { version: '0.77.1' },
    'node_modules/react-native-fast-image/package.json': { version: '8.6.3' },
    'node_modules/react-native-fast-image/android/build.gradle': '',
    'node_modules/some-js-lib/package.json': { version: '1.2.0' },
    'android/gradle.properties': 'newArchEnabled=false\n',
    'android/build.gradle': 'ext {\n  targetSdkVersion = 34\n  compileSdkVersion = 34\n}\n',
    'ios/Podfile': "ENV['RCT_NEW_ARCH_ENABLED'] = '0'\n",
    'src/App.js': "import FastImage from 'react-native-fast-image';\nimport lib from 'some-js-lib';\n",
    'src/aws.js': `AWS.config.update({ accessKeyId: '${FAKE_AWS_ID}', secretAccessKey: '${FAKE_AWS_SECRET}' });\n`,
    'functions/admin.json': '{"private_key": "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"}',
  });
}

const registry = fakeRegistry({
  directory: {
    'react-native-fast-image': { ios: true, android: true, newArchitecture: false, unmaintained: true, alternatives: ['expo-image'] },
    'some-js-lib': { newArchitecture: true },
  },
  latest: { 'react-native-fast-image': '8.6.3', 'some-js-lib': '3.0.0' },
});

test('bare app: version, architecture, store, dependency and secret findings', async () => {
  const result = await analyze(loadProject(bareApp()), { get: registry, now: NOW });
  const ids = result.findings.map((f) => f.id);

  assert.ok(ids.includes('rn-unsupported'), 'flags unsupported React Native');
  assert.ok(ids.includes('new-arch-disabled'));
  assert.equal(result.findings.find((f) => f.id === 'new-arch-disabled').title, 'New Architecture is disabled (android + ios)');
  assert.ok(ids.includes('play-target-sdk-visibility'), 'targetSdk 34 is below the visibility minimum');
  assert.ok(ids.includes('dep-risk:react-native-fast-image'));
  assert.ok(ids.includes('dep-major:some-js-lib'));
  assert.ok(!ids.some((id) => id.includes('@babel')), 'build tooling is ignored');

  const bundled = result.findings.filter((f) => f.area === 'secret' && f.severity === 'critical');
  assert.equal(bundled.length, 2, 'AWS key id and secret in src are critical');
  assert.ok(!JSON.stringify(result).includes(FAKE_AWS_ID), 'secret values never appear in output');

  const server = result.findings.find((f) => f.id === 'secret:private-key:functions/admin.json');
  assert.equal(server.severity, 'high', 'server-side secrets are not reported as shipped in the app');

  assert.equal(result.findings[0].severity, 'critical', 'findings are sorted by severity');
  assert.equal(result.latest.reactNative, '0.87.1');
});

test('targetSdk between the visibility and update minimums blocks updates', async () => {
  const root = bareApp();
  fs.writeFileSync(path.join(root, 'android/build.gradle'), 'ext { targetSdkVersion = 35 }');
  const result = await analyze(loadProject(root), { get: registry, now: NOW });
  const ids = result.findings.map((f) => f.id);
  assert.ok(ids.includes('play-target-sdk-updates'));
  assert.ok(!ids.includes('play-target-sdk-visibility'));
});

test('no Google Play target SDK finding before the policy date', async () => {
  const result = await analyze(loadProject(bareApp()), { get: registry, now: new Date('2026-01-01') });
  assert.ok(!result.findings.some((f) => f.id.startsWith('play-target-sdk')));
});

test('expo managed app reads New Architecture from app.json and checks the SDK', async () => {
  const root = makeProject({
    'package.json': { name: 'expo-demo', dependencies: { expo: '~50.0.1', 'react-native': '0.73.6' } },
    'node_modules/react-native/package.json': { version: '0.73.6' },
    'node_modules/expo/package.json': { version: '50.0.1' },
    'app.json': { expo: { name: 'demo', newArchEnabled: false } },
  });
  const project = loadProject(root);
  assert.equal(project.managed, true);
  assert.deepEqual(project.newArch, { android: false, ios: false });

  const result = await analyze(project, { get: registry, now: NOW });
  assert.ok(result.findings.some((f) => f.id === 'expo-unsupported'));
  // React Native moves with the SDK: one problem, reported once.
  assert.ok(!result.findings.some((f) => f.id === 'rn-unsupported'));
  assert.equal(result.findings.find((f) => f.id === 'rn-via-expo').severity, 'info');
  const plan = buildPlan(result);
  assert.ok(!plan.phases.some((p) => p.title.startsWith('Upgrade React Native')), 'no manual React Native hops in an Expo app');
});

test('monorepo: packages hoisted to a parent node_modules are found', () => {
  const root = makeProject({
    'node_modules/react-native/package.json': { version: '0.86.2' },
    'apps/mobile/package.json': { name: 'mobile', dependencies: { 'react-native': '*' } },
  });
  const project = loadProject(path.join(root, 'apps/mobile'));
  assert.equal(project.rnVersion, '0.86.2');
  assert.equal(project.hasNodeModules, true);
});

test('react-native in devDependencies (monorepo style) is detected; only native dev deps are analyzed', async () => {
  const root = makeProject({
    'package.json': { name: 'm', dependencies: {}, devDependencies: { 'react-native': '0.77.1', 'react-native-fast-image': '8.6.3', eslint: '^8.0.0' } },
  });
  const project = loadProject(root);
  assert.equal(project.rnVersion, '0.77.1');
  const result = await analyze(project, { get: registry, now: NOW });
  assert.deepEqual(result.deps.map((d) => d.name), ['react-native-fast-image']);
  assert.ok(result.findings.some((f) => f.id === 'dep-risk:react-native-fast-image'));
});

test('missing node_modules produces a warning instead of guessing silently', async () => {
  const root = makeProject({ 'package.json': { name: 'x', dependencies: { 'react-native': '^0.86.0' } } });
  const result = await analyze(loadProject(root), { get: registry, now: NOW });
  assert.equal(result.project.reactNative, '0.86.0');
  assert.ok(result.warnings.some((w) => w.includes('node_modules not found')));
});

test('severity grows with distance: out of support is high, a year behind is critical', async () => {
  const severityFor = async (version) => {
    const root = makeProject({ 'package.json': { name: 'x', dependencies: { 'react-native': version } } });
    const result = await analyze(loadProject(root), { get: registry, now: NOW });
    const f = result.findings.find((x) => x.id === 'rn-unsupported' || x.id === 'rn-behind');
    return f && `${f.id}:${f.severity}`;
  };
  assert.equal(await severityFor('0.86.0'), 'rn-behind:info');
  assert.equal(await severityFor('0.83.0'), 'rn-unsupported:high');
  assert.equal(await severityFor('0.77.1'), 'rn-unsupported:critical');
});

test('unreleased SDK previews do not count as latest', async () => {
  const root = makeProject({ 'package.json': { name: 'x', dependencies: { expo: '52.0.0', 'react-native': '0.86.0' } } });
  const result = await analyze(loadProject(root), { get: registry, now: NOW });
  assert.ok(result.findings.some((f) => f.id === 'expo-behind'), 'SDK 52 is two behind 54, still supported');
  assert.ok(!result.findings.some((f) => f.id === 'expo-unsupported'));
});

test('offline run still reports local findings', async () => {
  const result = await analyze(loadProject(bareApp()), { get: async () => null, now: NOW });
  assert.equal(result.offline, true);
  assert.ok(result.findings.some((f) => f.area === 'secret'));
});

test('not a React Native project is a clear error', () => {
  const root = makeProject({ 'package.json': { name: 'web', dependencies: { next: '15.0.0' } } });
  assert.throws(() => loadProject(root), /does not look like a React Native app/);
});

test('baseline hides known findings and reports new and fixed ones', async () => {
  const root = bareApp();
  const first = await analyze(loadProject(root), { get: registry, now: NOW });
  const file = path.join(root, 'baseline.json');
  saveBaseline(file, first);

  const same = applyBaseline(file, await analyze(loadProject(root), { get: registry, now: NOW }));
  assert.equal(same.findings.filter((f) => f.severity !== 'info').length, 0);

  fs.writeFileSync(path.join(root, 'src/aws.js'), '// key removed\n');
  fs.writeFileSync(path.join(root, 'src/new.js'), "const t = 'ghp_" + 'a'.repeat(36) + "';\n");
  const later = applyBaseline(file, await analyze(loadProject(root), { get: registry, now: NOW }));
  assert.deepEqual(later.findings.map((f) => f.id), ['secret:github-token:src/new.js']);
  assert.ok(later.baseline.fixed.includes('secret:aws-access-key:src/aws.js'));
});

test('--offline makes zero network requests (checked by trapping fetch in a real CLI run)', () => {
  const trap = 'data:text/javascript,globalThis.fetch=(u)=>{process.stderr.write("NETWORK:"+u+"\\n");throw new Error("blocked")}';
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nativekeel.js');
  const root = bareApp();

  const offline = spawnSync(process.execPath, ['--import', trap, cli, root, '--offline'], { encoding: 'utf8' });
  assert.ok(!offline.stderr.includes('NETWORK:'), offline.stderr);
  assert.match(offline.stdout, /Offline mode: no network requests were made/);
  assert.match(offline.stdout, /AWS access key ID shipped inside the app/, 'local checks still run');

  // Sanity check that the trap works: a normal run does try the network.
  const online = spawnSync(process.execPath, ['--import', trap, cli, root], { encoding: 'utf8' });
  assert.ok(online.stderr.includes('NETWORK:'));
});

test('release recency: stale packages are flagged, revived "unmaintained" ones are not', async () => {
  const root = makeProject({
    'package.json': { name: 'r', dependencies: { 'react-native': '0.86.0', 'react-native-old-ui-kit': '3.4.3', 'revived-image': '8.29.0', 'fresh-lib': '2.0.0', 'base64-js': '1.5.1', 'ui-kit': '3.4.3' } },
  });
  const get = fakeRegistry({
    directory: {
      'revived-image': { ios: true, android: true, unmaintained: true, newArchitecture: true },
      'fresh-lib': { newArchitecture: true },
    },
    latest: { 'ui-kit': '3.4.3', 'react-native-old-ui-kit': '3.4.3', 'revived-image': '8.29.0', 'fresh-lib': '2.0.0' },
    published: { 'ui-kit': '2022-12-23', 'react-native-old-ui-kit': '2022-12-23', 'revived-image': '2026-10-02', 'base64-js': '2020-11-03' },
    rnPeers: ['ui-kit'],
  });
  const result = await analyze(loadProject(root), { get, now: NOW });
  const byId = Object.fromEntries(result.findings.map((f) => [f.id, f]));

  assert.match(byId['dep-risk:react-native-old-ui-kit'].title, /no release since 2022-12/, 'RN ecosystem package recognised by name');
  assert.equal(byId['dep-risk:react-native-old-ui-kit'].severity, 'low', 'tied to React Native by name only');
  assert.equal(byId['dep-risk:ui-kit'].severity, 'medium', 'peers on a react-native-* package');
  assert.equal(byId['dep-risk:revived-image'], undefined, 'a release yesterday overrides a stale unmaintained flag');
  assert.match(byId['dep-revived:revived-image'].title, /marked unmaintained, but 2026-10-02 saw a new release/);
  assert.equal(byId['dep-risk:fresh-lib'], undefined, 'packages the directory knows as maintained are not re-checked');
  assert.equal(byId['dep-risk:base64-js'], undefined, 'an old pure-JS utility that does not depend on React Native is fine');
});

test('linear-gradient: high only when a LinearGradient file also renders a Modal', async () => {
  const appWith = (screen) =>
    makeProject({
      'package.json': { name: 'g', dependencies: { 'react-native': '0.80.3', 'react-native-linear-gradient': '2.8.3' } },
      'node_modules/react-native/package.json': { version: '0.80.3' },
      'node_modules/react-native-linear-gradient/package.json': { version: '2.8.3' },
      'node_modules/react-native-linear-gradient/android/build.gradle': '',
      'android/gradle.properties': 'newArchEnabled=true\n',
      'src/Screen.js': screen,
    });
  const find = async (root) => (await analyze(loadProject(root), { get: registry, now: NOW })).findings.find((f) => f.id === 'known:linear-gradient-interop-unmount');

  const risky = await find(appWith("import LinearGradient from 'react-native-linear-gradient';\nimport {Modal} from 'react-native';\nexport default () => <LinearGradient colors={[]}><Modal visible /></LinearGradient>;\n"));
  assert.equal(risky.severity, 'high');
  assert.match(risky.detail, /Found in src\/Screen\.js/);

  const plain = await find(appWith("import LinearGradient from 'react-native-linear-gradient';\nexport default () => <LinearGradient colors={[]} />;\n"));
  assert.equal(plain.severity, 'low');
  assert.match(plain.title, /interop layer/);
});

test('pnpm and Bun catalogs resolve `catalog:` versions', () => {
  const pnpm = makeProject({
    'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\ncatalog:\n  "react-native": 0.81.6\n  react: 19.1.0 # comment\ncatalogs:\n  legacy:\n    "react-native-screens": "4.13.1"\n',
    'apps/mobile/package.json': { name: 'm', dependencies: { 'react-native': 'catalog:', react: 'catalog:default', 'react-native-screens': 'catalog:legacy' } },
  });
  const p = loadProject(path.join(pnpm, 'apps/mobile'));
  assert.equal(p.rnVersion, '0.81.6');
  assert.equal(p.deps.react, '19.1.0');
  assert.equal(p.deps['react-native-screens'], '4.13.1');

  const bun = makeProject({
    'package.json': { name: 'root', workspaces: { packages: ['apps/*'], catalog: { 'react-native': '0.80.2' } } },
    'apps/mobile/package.json': { name: 'm', dependencies: { 'react-native': 'catalog:' } },
  });
  assert.equal(loadProject(path.join(bun, 'apps/mobile')).rnVersion, '0.80.2');
});

test('React Native from a git fork: a clear warning instead of silence', async () => {
  const root = makeProject({ 'package.json': { name: 'z', dependencies: { 'react-native': 'zulip/react-native#b7b2f6c22', expo: '^45.0.0' } } });
  const result = await analyze(loadProject(root), { get: registry, now: NOW });
  assert.ok(result.warnings.some((w) => /declared as "zulip\/react-native#b7b2f6c22"/.test(w)));
});

test('Directory says no New Architecture, npm knows better', async () => {
  const project = (version) =>
    loadProject(
      makeProject({
        'package.json': { name: 'tp', dependencies: { 'react-native': '0.80.3', 'react-native-track-player': version } },
        'node_modules/react-native/package.json': { version: '0.80.3' },
        'node_modules/react-native-track-player/package.json': { version },
        'node_modules/react-native-track-player/ios/x.swift': '',
        'src/App.js': "import TrackPlayer from 'react-native-track-player';\n",
      }),
    );
  const get = fakeRegistry({
    directory: { 'react-native-track-player': { ios: true, android: true, newArchitecture: false } },
    latest: { 'react-native-track-player': '5.0.0' },
    manifests: {
      'react-native-track-player@latest': { version: '5.0.0', codegenConfig: { name: 'TrackPlayerSpec' } },
      'react-native-track-player@4.1.2': { version: '4.1.2' },
    },
  });
  const old = (await analyze(project('4.1.2'), { get, now: NOW })).findings.find((f) => f.id === 'dep-risk:react-native-track-player');
  assert.equal(old.severity, 'medium');
  assert.match(old.title, /New Architecture support needs 5\.0\.0/);
  assert.equal(old.fix.kind, 'bump-dep');

  const current = (await analyze(project('5.0.0'), { get, now: NOW })).findings.find((f) => f.id === 'dep-risk:react-native-track-player');
  assert.equal(current, undefined, 'the version in use already has a codegen spec');
});

test('without node_modules, pure JS packages are not counted as native', async () => {
  const root = makeProject({
    'package.json': { name: 'js', dependencies: { 'react-native': '0.80.3', 'react-native-progress': '5.0.0' } },
    'src/App.js': "import * as Progress from 'react-native-progress';\n",
  });
  const get = fakeRegistry({
    directory: { 'react-native-progress': { ios: true, android: true, unmaintained: true, github: { hasNativeCode: false } } },
  });
  const f = (await analyze(loadProject(root), { get, now: NOW })).findings.find((x) => x.id === 'dep-risk:react-native-progress');
  assert.equal(f.severity, 'medium', 'an abandoned JS package is not an upgrade blocker');
  assert.equal(f.fix.native, false);
});

test('a React Native library is recognised and store checks are skipped', async () => {
  const root = makeProject({
    'package.json': { name: 'react-native-thing', main: 'index.js', peerDependencies: { 'react-native': '*' }, devDependencies: { 'react-native': '0.80.3' } },
    'android/build.gradle': "apply plugin: 'com.android.library'\nandroid { defaultConfig { targetSdkVersion 30 } }\n",
    'ios/Thing.m': '',
  });
  const project = loadProject(root);
  assert.equal(project.isLibrary, true);
  const result = await analyze(project, { get: registry, now: NOW });
  assert.ok(result.warnings.some((w) => /looks like a React Native library/.test(w)));
  const ids = result.findings.map((f) => f.id);
  assert.ok(!ids.includes('ios-privacy-manifest'));
  assert.ok(!ids.some((i) => i.startsWith('play-target')));
});

test('Expo: a library version Expo pins for the SDK is not a compat problem', async () => {
  const app = (reanimated, withPins) =>
    makeProject({
      'package.json': { name: 'e', dependencies: { expo: '~46.0.0', 'react-native': '0.69.6', 'react-native-reanimated': reanimated } },
      'node_modules/react-native/package.json': { version: '0.69.6' },
      'node_modules/expo/package.json': { version: '46.0.21' },
      ...(withPins ? { 'node_modules/expo/bundledNativeModules.json': { 'react-native-reanimated': '~2.9.1' } } : {}),
      'node_modules/react-native-reanimated/package.json': { version: reanimated },
      'node_modules/react-native-reanimated/android/build.gradle': '',
      'src/App.js': "import Animated from 'react-native-reanimated';\n",
    });
  const compat = async (root) => (await analyze(loadProject(root), { get: registry, now: NOW })).findings.find((f) => f.id === 'compat:react-native-reanimated');
  assert.equal(await compat(app('2.9.1', true)), undefined, 'Expo SDK 46 ships Reanimated 2.9 with React Native 0.69');
  const mismatch = await compat(app('2.3.0', true));
  assert.match(mismatch.detail, /Expo SDK 46 expects ~2\.9\.1/);
  const unknown = await compat(app('2.9.1', false));
  assert.equal(unknown.severity, 'medium', 'without the pin list, Expo projects get a softer finding');
});

test('Expo range check', async () => {
  const { satisfiesExpoRange } = await import('../src/analyze.js');
  assert.equal(satisfiesExpoRange('2.9.1', '~2.9.1'), true);
  assert.equal(satisfiesExpoRange('2.10.0', '~2.9.1'), false);
  assert.equal(satisfiesExpoRange('3.4.0', '^3.1.0'), true);
  assert.equal(satisfiesExpoRange('2.9.0', '~2.9.1'), false);
});

test('fetchJson: retries rate limits, says nothing about 404, counts real failures', async () => {
  const { fetchJson } = await import('../src/registry.js');
  const realFetch = globalThis.fetch;
  const responses = [];
  globalThis.fetch = async () => responses.shift();
  const res = (status, body) => ({ ok: status === 200, status, headers: new Map(), json: async () => body });
  const noWait = { wait: async () => {} };
  try {
    const stats = { failed: 0 };
    responses.push(res(429), res(429), res(200, { version: '1.0.0' }));
    assert.deepEqual(await fetchJson('u', {}, stats, noWait), { version: '1.0.0' });
    responses.push(res(404));
    assert.equal(await fetchJson('u', {}, stats, noWait), null);
    assert.equal(stats.failed, 0, 'not found is an answer');
    responses.push(res(429), res(429), res(429), res(429));
    assert.equal(await fetchJson('u', {}, stats, noWait), null);
    assert.equal(stats.failed, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
