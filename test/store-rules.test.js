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
