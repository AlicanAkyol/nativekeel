import test from 'node:test';
import assert from 'node:assert/strict';
import { storeReviewRules } from '../src/store-rules.js';
import { makeProject } from './helpers.js';

const ids = (files, deps = {}, extra = {}) => storeReviewRules({ root: makeProject({ 'package.json': '{}', ...files }), deps, ...extra }).map((f) => f.id);

test('account deletion: sign-up without deletion is reported; a deletion call or page link counts', () => {
  assert.deepEqual(ids({ 'src/auth.ts': 'await createUserWithEmailAndPassword(auth, email, password);' }), ['store-account-deletion']);
  assert.deepEqual(ids({ 'src/auth.ts': 'await supabase.auth.signUp({ email, password });', 'src/settings.ts': 'await api.deleteAccount();' }), []);
  assert.deepEqual(ids({ 'src/auth.ts': "await fetch('/api/auth/signup', opts);", 'src/help.ts': "Linking.openURL('https://example.com/account/delete');" }), []);
  assert.deepEqual(ids({ 'src/auth.ts': "Linking.openURL('https://accounts.pixiv.net/signup');" }), [], 'a third-party sign-up page is not an account the app creates');
  assert.deepEqual(ids({ 'src/push.ts': "await fetch(`${hub}/register`, opts);" }), [], 'device registration is not sign-up');
});

test('Sign in with Apple: social login on iOS without an equivalent', () => {
  const ios = { 'ios/App/Info.plist': '<plist/>' };
  assert.deepEqual(ids(ios, { '@react-native-google-signin/google-signin': '^13.0.0' }), ['store-sign-in-with-apple']);
  assert.deepEqual(ids(ios, { '@react-native-google-signin/google-signin': '^13.0.0', '@invertase/react-native-apple-authentication': '^2.4.0' }), []);
  assert.deepEqual(ids({}, { '@react-native-google-signin/google-signin': '^13.0.0' }), [], 'Android-only app');
  assert.deepEqual(ids({}, { 'react-native-fbsdk-next': '^13.0.0' }, { expoVersion: '54.0.0' }), ['store-sign-in-with-apple'], 'Expo apps ship to iOS');
});

test('iOS SDKs too old for a privacy manifest, named with the React Native package that pulls them in', async () => {
  const { iosSdkPrivacyManifests } = await import('../src/store-rules.js');
  const lock = (sdweb) => `PODS:\n  - RNFastImage (8.6.3):\n    - React-Core\n    - SDWebImage (~> ${sdweb})\n    - SDWebImageWebPCoder (~> 0.8.4)\n  - SDWebImage (${sdweb}):\n    - SDWebImage/Core (= ${sdweb})\n  - SDWebImage/Core (${sdweb})\n  - hermes-engine (0.72.6)\n\nDEPENDENCIES:\n  - RNFastImage\n`;
  const old = iosSdkPrivacyManifests(makeProject({ 'ios/Podfile.lock': lock('5.11.1') }));
  assert.equal(old[0].id, 'ios-sdk-privacy-manifest');
  assert.match(old[0].detail, /SDWebImage 5\.11\.1 \(manifest from 5\.18\.7, pulled in by RNFastImage\)/);
  assert.ok(!/hermes/.test(old[0].detail), "React Native's Hermes is not Apple's 'hermes'");
  assert.equal(iosSdkPrivacyManifests(makeProject({ 'ios/Podfile.lock': lock('5.19.0') })).length, 0);
  assert.match(iosSdkPrivacyManifests(makeProject({ 'ios/Podfile.lock': 'PODS:\n  - AFNetworking (2.7.0)\n\nDEPENDENCIES:\n' }))[0].detail, /no release has one/);
});

test('UIScene life cycle: needed to launch when built with the iOS 27 SDK', async () => {
  const { iosSceneLifecycle } = await import('../src/store-rules.js');
  const NOW = new Date('2026-10-09T12:00:00Z');
  const run = (files, project = {}, now = NOW) => iosSceneLifecycle({ root: makeProject({ 'package.json': '{}', ...files }), ...project }, now);
  const plist = (scene) => `<plist><dict><key>CFBundleExecutable</key><string>App</string>${scene === 'empty' ? '<key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/></dict>' : scene ? '<key>UIApplicationSceneManifest</key><dict><key>UISceneConfigurations</key><dict></dict></dict>' : ''}</dict></plist>`;
  const bare = (scene, delegate, extra = {}) => ({ 'ios/App/Info.plist': plist(scene), 'ios/App/AppDelegate.swift': delegate, ...extra });

  const old = run(bare(false, 'class AppDelegate: RCTAppDelegate {}'), { rnVersion: '0.85.3' });
  assert.equal(old[0].id, 'ios-uiscene-required');
  assert.equal(old[0].severity, 'high');
  assert.match(old[0].detail, /React Native 0\.88 is the first release/);
  assert.equal(run(bare(false, 'x'), { rnVersion: '0.85.3' }, new Date('2027-04-02'))[0].severity, 'critical', 'after the App Store deadline');
  assert.deepEqual(run(bare(true, 'class AppDelegate {}'), { rnVersion: '0.88.0' }), [], 'scene manifest present, no URL handlers');
  assert.equal(run(bare('empty', 'x'), { rnVersion: '0.81.0' })[0].id, 'ios-uiscene-required', 'a manifest without scene configurations (Notesnook)');

  const urls = run(bare(true, 'func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey : Any] = [:]) -> Bool { RCTLinkingManager.application(app, open: url, options: options) }'), { rnVersion: '0.88.0' });
  assert.equal(urls[0].id, 'ios-uiscene-url-handlers');
  assert.deepEqual(
    run(bare(true, 'func application(_ app: UIApplication, open url: URL) -> Bool { true }', { 'ios/App/SceneDelegate.swift': 'func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {}' }), { rnVersion: '0.88.0' }),
    [],
    'forwarded from SceneDelegate',
  );

  const blob = { deps: { 'react-native-blob-util': '0.25.1' }, rnVersion: '0.88.0' };
  const crash = run(bare(true, 'class AppDelegate: UIResponder, UIApplicationDelegate {}'), blob);
  assert.equal(crash[0].id, 'ios-scene-delegate-window', 'the 0.88 template AppDelegate has no window');
  assert.match(crash[0].detail, /unrecognized selector/);
  assert.deepEqual(run(bare(true, 'class AppDelegate: UIResponder, UIApplicationDelegate {\n  var window: UIWindow?\n}'), blob), [], 'window kept on the app delegate');
  assert.match(run(bare(false, 'x'), { ...blob, rnVersion: '0.85.0' })[0].detail, /react-native-blob-util reads the window/, 'a warning before the move');
  assert.match(run({}, { managed: true, expoVersion: '56.0.0' })[0].detail, /upgrade to SDK 57/);
  assert.match(run({}, { managed: true, expoVersion: '57.0.25' })[0].detail, /enableSceneSupport/);
  assert.deepEqual(run({ 'app.json': JSON.stringify({ expo: { plugins: [['expo-build-properties', { ios: { enableSceneSupport: true } }]] } }) }, { managed: true, expoVersion: '57.0.25' }), []);
  assert.deepEqual(run({}, { managed: true, expoVersion: '58.0.0' }), [], 'default from SDK 58');
});
