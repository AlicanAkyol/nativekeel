import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { loadProject } from '../src/project.js';
import { nativeChecks } from '../src/native.js';
import { checkArchive, minLoadAlignment } from '../src/elf-align.js';
import { makeProject } from './helpers.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const ids = (findings) => findings.map((f) => f.id);
const check = (files, opts = {}) => nativeChecks(loadProject(makeProject(files)), { now: NOW, ...opts });

// Minimal 64-bit little-endian ELF with one PT_LOAD per alignment given.
function fakeElf(aligns) {
  const phoff = 64;
  const buf = Buffer.alloc(phoff + 56 * aligns.length);
  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // little-endian
  buf.writeBigUInt64LE(BigInt(phoff), 32);
  buf.writeUInt16LE(56, 54);
  buf.writeUInt16LE(aligns.length, 56);
  aligns.forEach((a, i) => {
    buf.writeUInt32LE(1, phoff + i * 56); // PT_LOAD
    buf.writeBigUInt64LE(BigInt(a), phoff + i * 56 + 48);
  });
  return buf;
}

// Minimal ZIP writer: method 0 (stored) or 8 (deflate), like real APKs mix.
function fakeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const rnApp = (version, extra = {}) => ({
  'package.json': { name: 'a', dependencies: { 'react-native': version } },
  'android/build.gradle': 'ext { targetSdkVersion = 36 }',
  ...extra,
});

test('ELF parser reads the smallest PT_LOAD alignment', () => {
  assert.equal(minLoadAlignment(fakeElf([16384, 16384])), 16384);
  assert.equal(minLoadAlignment(fakeElf([16384, 4096])), 4096);
  assert.equal(minLoadAlignment(Buffer.from('not an elf')), null);
});

test('APK check finds misaligned 64-bit libraries, stored or deflated, and ignores 32-bit ABIs', () => {
  const dir = makeProject({});
  const apk = path.join(dir, 'app-release.apk');
  fs.writeFileSync(apk, fakeZip([
    { name: 'lib/arm64-v8a/libgood.so', data: fakeElf([16384]) },
    { name: 'lib/arm64-v8a/libbad.so', data: fakeElf([4096]), deflate: true },
    { name: 'lib/armeabi-v7a/libold.so', data: fakeElf([4096]) },
    { name: 'classes.dex', data: Buffer.from('dex') },
  ]));
  const r = checkArchive(apk);
  assert.deepEqual(r.libs.map((l) => l.path).sort(), ['lib/arm64-v8a/libbad.so', 'lib/arm64-v8a/libgood.so']);
  assert.deepEqual(r.misaligned.map((l) => l.path), ['lib/arm64-v8a/libbad.so']);
});

test('built release artifact with a misaligned library is critical; debug-only libs are ignored in debug builds', () => {
  const release = check(rnApp('0.80.0', {
    'android/app/build/outputs/bundle/release/app-release.aab': '',
  }));
  assert.ok(!ids(release).includes('android-16kb-libs'), 'empty file is not a zip: no crash, no finding');

  const root = makeProject(rnApp('0.80.0'));
  const out = path.join(root, 'android/app/build/outputs/apk/release');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'app-release.apk'), fakeZip([{ name: 'lib/arm64-v8a/libvendor.so', data: fakeElf([4096]) }]));
  const f = nativeChecks(loadProject(root), { now: NOW }).find((x) => x.id === 'android-16kb-libs');
  assert.equal(f.severity, 'critical');
  assert.match(f.title, /1 native library is not 16 KB aligned/);

  const dbgRoot = makeProject(rnApp('0.80.0'));
  const dbg = path.join(dbgRoot, 'android/app/build/outputs/apk/debug');
  fs.mkdirSync(dbg, { recursive: true });
  fs.writeFileSync(path.join(dbg, 'app-debug.apk'), fakeZip([
    { name: 'lib/arm64-v8a/libflipper.so', data: fakeElf([4096]) },
    { name: 'lib/arm64-v8a/libreactnative.so', data: fakeElf([16384]) },
  ]));
  const ok = nativeChecks(loadProject(dbgRoot), { now: NOW }).find((x) => x.id === 'android-16kb-ok');
  assert.match(ok.title, /1 of 2 .* the other 1 are debug-only/, 'never claims "all aligned" when something was skipped');
});

test('React Native before 0.77 cannot ship 16 KB pages', () => {
  assert.ok(ids(check(rnApp('0.76.5'))).includes('android-16kb-rn'));
  assert.ok(!ids(check(rnApp('0.77.0'))).includes('android-16kb-rn'));
  assert.ok(!ids(check(rnApp('0.76.5'), { now: new Date('2025-06-01') })).includes('android-16kb-rn'), 'not before the policy date');
});

test('iOS privacy manifest', () => {
  assert.ok(ids(check(rnApp('0.80.0', { 'ios/Podfile': '' }))).includes('ios-privacy-manifest'));
  assert.ok(!ids(check(rnApp('0.80.0', { 'ios/Podfile': '', 'ios/App/PrivacyInfo.xcprivacy': '<plist/>' }))).includes('ios-privacy-manifest'));
  assert.ok(ids(check(rnApp('0.80.0', { 'ios/Podfile': '', 'ios/Pods/X/PrivacyInfo.xcprivacy': '' }))).includes('ios-privacy-manifest'), 'manifests inside Pods do not count');
});

test('Flipper and Hermes', () => {
  const found = ids(check(rnApp('0.73.0', {
    'android/gradle.properties': 'FLIPPER_VERSION=0.182.0\nhermesEnabled=false\n',
  })));
  assert.ok(found.includes('flipper'));
  assert.ok(found.includes('hermes-disabled'));
  assert.ok(!ids(check(rnApp('0.80.0', { 'android/gradle.properties': 'hermesEnabled=true\n' }))).includes('hermes-disabled'));
});

test('Android manifest and iOS ATS security settings', () => {
  const found = ids(check(rnApp('0.80.0', {
    'android/app/src/main/AndroidManifest.xml': '<application android:usesCleartextTraffic="true" android:debuggable="true"/>',
    'ios/Podfile': '',
    'ios/App/PrivacyInfo.xcprivacy': '',
    'ios/App/Info.plist': '<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key>\n<true/></dict>',
  })));
  assert.ok(found.includes('android-cleartext'));
  assert.ok(found.includes('android-debuggable'));
  assert.ok(found.includes('ios-ats:ios/App/Info.plist'));

  const clean = ids(check(rnApp('0.80.0', {
    'android/app/src/main/AndroidManifest.xml': '<application android:allowBackup="false"/>',
    'android/app/src/debug/AndroidManifest.xml': '<application android:usesCleartextTraffic="true"/>',
  })));
  assert.ok(!clean.includes('android-cleartext'), 'debug manifest is fine');
});

test('.env secrets are flagged only when a library compiles them into the bundle', () => {
  const env = 'API_URL=https://x.io\nSTRIPE_SECRET_KEY=sk_test_123\nDB_PASSWORD=\n';
  const withConfig = check({
    'package.json': { name: 'a', dependencies: { 'react-native': '0.80.0', 'react-native-config': '^1.5.0' } },
    '.env': env,
    '.env.example': 'STRIPE_SECRET_KEY=xxx',
  });
  const f = withConfig.find((x) => x.id === 'env-bundled:.env');
  assert.ok(f);
  assert.match(f.detail, /STRIPE_SECRET_KEY/);
  assert.doesNotMatch(f.detail, /DB_PASSWORD/, 'empty values are ignored');
  assert.doesNotMatch(f.detail, /sk_test_123/, 'values are never printed');
  assert.ok(!withConfig.some((x) => x.id === 'env-bundled:.env.example'));

  const plain = check({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.80.0' } }, '.env': env });
  assert.ok(!plain.some((x) => x.id.startsWith('env-bundled')), 'without an env-inlining library the file stays on the server side');

  const expo = check({
    'package.json': { name: 'a', dependencies: { expo: '54.0.0', 'react-native': '0.81.0' } },
    '.env': 'EXPO_PUBLIC_SUPABASE_SERVICE_ROLE=abc\nSUPABASE_SECRET=def\n',
  });
  const e = expo.find((x) => x.id === 'env-bundled:.env');
  assert.match(e.detail, /EXPO_PUBLIC_SUPABASE_SERVICE_ROLE/);
  assert.doesNotMatch(e.detail, /SUPABASE_SECRET\b/, 'Expo only inlines EXPO_PUBLIC_ variables');
});

test('platform minimums are reported only when an upgrade is ahead', () => {
  const files = rnApp('0.75.0', {
    'android/build.gradle': 'ext { minSdkVersion = 23\n targetSdkVersion = 36 }',
    'ios/Podfile': "platform :ios, '13.4'",
    'ios/App/PrivacyInfo.xcprivacy': '',
  });
  const found = ids(check(files, { rnLatest: '0.87.1' }));
  assert.ok(found.includes('android-min-sdk'));
  assert.ok(found.includes('ios-min-version'));
  assert.ok(!ids(check(files)).includes('android-min-sdk'), 'no latest version known, no claim');
});

test('signing material committed to git', () => {
  const root = makeProject(rnApp('0.80.0', {
    'android/gradle.properties': 'MYAPP_RELEASE_STORE_PASSWORD=hunter2\nMYAPP_RELEASE_KEY_PASSWORD=hunter2\nFROM_ENV_KEY_PASSWORD=${KEY_PW}\n',
    'android/app/build.gradle': "signingConfigs { debug { storePassword 'android'\n keyPassword 'android' } }",
    'android/app/debug.keystore': 'x',
    'android/app/release.keystore': 'x',
    'ios/AuthKey_ABC123XYZ9.p8': ['-----BEGIN ', 'PRIVATE KEY-----\nMIGT\n'].join(''),
    'ios/dist.p12': 'x',
    'ios/App/PrivacyInfo.xcprivacy': '',
  }));
  const git = (...args) => spawnSync('git', args, { cwd: root });
  git('init', '-q');
  git('add', '-A');
  const found = nativeChecks(loadProject(root), { now: NOW });
  const byId = Object.fromEntries(found.map((f) => [f.id, f]));
  assert.equal(byId['signing-keystore:android/app/release.keystore'].severity, 'high');
  assert.ok(!byId['signing-keystore:android/app/debug.keystore'], 'debug keystore is fine');
  assert.equal(byId['signing-asc-key:ios/AuthKey_ABC123XYZ9.p8'].severity, 'critical');
  assert.ok(byId['signing-p12:ios/dist.p12']);
  assert.match(byId['signing-password:android/gradle.properties'].detail, /MYAPP_RELEASE_STORE_PASSWORD, MYAPP_RELEASE_KEY_PASSWORD\./);
  assert.ok(!JSON.stringify(found).includes('hunter2'), 'passwords are never printed');
  assert.ok(!byId['signing-password:android/app/build.gradle'], "the public 'android' debug password is fine");
});

test('RCTAppDependencyProvider is required in AppDelegate from React Native 0.77', () => {
  const files = (version, delegate, gradle = 'newArchEnabled=true\n') => rnApp(version, {
    'ios/App/AppDelegate.h': '#import <RCTAppDelegate.h>\n@interface AppDelegate : RCTAppDelegate\n@end',
    'ios/App/AppDelegate.mm': delegate,
    'ios/App/PrivacyInfo.xcprivacy': '',
    'ios/Podfile': '',
    'android/gradle.properties': gradle,
  });
  const missing = '- (BOOL)application:(UIApplication *)a didFinishLaunchingWithOptions:(NSDictionary *)o {\n  self.moduleName = @"App";\n  return [super application:a didFinishLaunchingWithOptions:o];\n}';
  const present = `#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>\n${missing.replace('self.moduleName', 'self.dependencyProvider = [RCTAppDependencyProvider new];\n  self.moduleName')}`;

  const f = check(files('0.77.1', missing)).find((x) => x.id === 'ios-app-dependency-provider');
  assert.equal(f.severity, 'critical', 'New Architecture on by default on iOS');
  assert.ok(!check(files('0.77.1', present)).some((x) => x.id === 'ios-app-dependency-provider'));
  assert.ok(!check(files('0.76.5', missing)).some((x) => x.id === 'ios-app-dependency-provider'), 'not required before 0.77');

  const legacy = files('0.77.1', missing);
  legacy['ios/Podfile'] = "ENV['RCT_NEW_ARCH_ENABLED'] = '0'\n";
  assert.equal(check(legacy).find((x) => x.id === 'ios-app-dependency-provider').severity, 'high', 'latent while the New Architecture is off');
});

test('Podfile CLI require and deprecated RCTAppDelegate', () => {
  const files = (version) => rnApp(version, {
    'ios/Podfile': "require_relative '../node_modules/react-native/scripts/react_native_pods'\nrequire_relative '../node_modules/@react-native-community/cli-platform-ios/native_modules'\n",
    'ios/App/AppDelegate.h': '#import <RCTAppDelegate.h>\n@interface AppDelegate : RCTAppDelegate\n@end',
    'ios/App/AppDelegate.mm': '#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>\nself.dependencyProvider = [RCTAppDependencyProvider new];',
    'ios/App/PrivacyInfo.xcprivacy': '',
  });
  const on80 = check(files('0.80.3'));
  assert.equal(on80.find((f) => f.id === 'podfile-cli-native-modules').severity, 'high');
  assert.ok(on80.some((f) => f.id === 'ios-rctappdelegate-deprecated'));
  const on77 = check(files('0.77.1'));
  assert.equal(on77.find((f) => f.id === 'podfile-cli-native-modules').severity, 'medium');
  assert.ok(!on77.some((f) => f.id === 'ios-rctappdelegate-deprecated'), 'not flagged before it is deprecated');
});

test('patch-package patches: build output, version mismatch, review reminder', () => {
  const root = makeProject(rnApp('0.80.0', {
    'package.json': { name: 'a', dependencies: { 'react-native': '0.80.0', 'some-lib': '3.2.0', '@scope/other': '1.0.1' } },
    'node_modules/some-lib/package.json': { version: '3.2.0' },
    'node_modules/@scope/other/package.json': { version: '1.0.1' },
    'patches/some-lib+3.2.0.patch': 'diff --git a/node_modules/some-lib/android/src/X.kt b/node_modules/some-lib/android/src/X.kt\ndiff --git a/node_modules/some-lib/android/build/intermediates/R.txt b/node_modules/some-lib/android/build/intermediates/R.txt\n',
    'patches/@scope+other+1.0.0.patch': 'diff --git a/node_modules/@scope/other/index.js b/node_modules/@scope/other/index.js\n',
  }));
  const byId = Object.fromEntries(nativeChecks(loadProject(root), { now: NOW }).map((f) => [f.id, f]));
  assert.match(byId['patch-artifacts:some-lib+3.2.0.patch'].detail, /1 file\(s\) under android\/ios build folders/);
  assert.ok(!byId['patch-artifacts:@scope+other+1.0.0.patch']);
  assert.match(byId['patch-version:@scope+other+1.0.0.patch'].title, /@scope\/other 1.0.0 does not match the installed 1.0.1/);
  assert.match(byId['patches-present'].title, /2 patch-package patches: @scope\/other, some-lib/);
});

test('stale folly flags in the Xcode project break an Objective-C++ AppDelegate from RN 0.80', () => {
  const pbx = 'OTHER_CPLUSPLUSFLAGS = (\n"$(OTHER_CFLAGS)",\n"-DFOLLY_NO_CONFIG",\n"-DFOLLY_MOBILE=1",\n"-DFOLLY_USE_LIBCPP=1",\n);';
  const files = (version, extra = {}) => rnApp(version, {
    'ios/App.xcodeproj/project.pbxproj': pbx,
    'ios/App/AppDelegate.mm': '#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>',
    'ios/App/PrivacyInfo.xcprivacy': '',
    ...extra,
  });
  assert.equal(check(files('0.80.3')).find((f) => f.id === 'ios-folly-flags').severity, 'high');
  assert.equal(check(files('0.77.1'), { rnLatest: '0.87.1' }).find((f) => f.id === 'ios-folly-flags').severity, 'medium', 'flagged ahead of the upgrade');
  assert.ok(!check(files('0.77.1')).some((f) => f.id === 'ios-folly-flags'), 'no upgrade target known: no claim');
  const fixed = files('0.80.3', { 'ios/App.xcodeproj/project.pbxproj': pbx.replace('"-DFOLLY_USE_LIBCPP=1",', '"-DFOLLY_USE_LIBCPP=1",\n"-DFOLLY_CFG_NO_COROUTINES=1",') });
  assert.ok(!check(fixed).some((f) => f.id === 'ios-folly-flags'));
  const swift = files('0.80.3', { 'ios/App/AppDelegate.mm': undefined });
  delete swift['ios/App/AppDelegate.mm'];
  swift['ios/App/AppDelegate.swift'] = 'import React';
  assert.ok(!check(swift).some((f) => f.id === 'ios-folly-flags'), 'Swift AppDelegates do not compile these headers');
});

test('Java MainApplication two-argument getDefaultReactHost', () => {
  const src = (call) => rnApp('0.80.3', { 'android/app/src/main/java/com/a/MainApplication.java': `class A { ReactHost h() { return ${call}; } }` });
  assert.equal(check(src('DefaultReactHost.getDefaultReactHost(getApplicationContext(), mReactNativeHost)')).find((f) => f.id === 'android-default-react-host').severity, 'high');
  assert.ok(!check(src('DefaultReactHost.getDefaultReactHost(getApplicationContext(), mReactNativeHost, null)')).some((f) => f.id === 'android-default-react-host'));
});

test('empty signing placeholders are not reported', () => {
  const root = makeProject({ 'package.json': { name: 'x', dependencies: { 'react-native': '0.80.0' } }, 'ios/fastlane/AuthKey_ABC123.p8': '', 'android/app/release.keystore': '' });
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '-A'], { cwd: root });
  const ids = nativeChecks(loadProject(root), { rnLatest: '0.87.1', now: new Date('2026-10-04') }).map((f) => f.id);
  assert.ok(!ids.some((i) => i.startsWith('signing-')), ids.join(','));
});
