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
