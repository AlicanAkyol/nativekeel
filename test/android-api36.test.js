import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeChecks } from '../src/native.js';
import { loadProject } from '../src/project.js';
import { makeProject } from './helpers.js';

const find = (files) => nativeChecks(loadProject(makeProject({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.81.0' } }, ...files }))).find((f) => f.id === 'android-api36-behavior');
const gradle = (t) => ({ 'android/build.gradle': `buildscript { ext { targetSdkVersion = ${t}\n compileSdkVersion = ${t} } }` });
const manifest = (activity, app = '') => ({ 'android/app/src/main/AndroidManifest.xml': `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application ${app}><activity android:name=".MainActivity" ${activity}/></application></manifest>` });

test('API 36: the edge-to-edge opt-out stops working (medium), orientation locks are a note', () => {
  const opt = find({ ...gradle(36), ...manifest(''), 'android/app/src/main/res/values/styles.xml': '<resources><style name="AppTheme"><item name="android:windowOptOutEdgeToEdgeEnforcement">true</item></style></resources>' });
  assert.equal(opt.severity, 'medium');
  assert.match(opt.title, /changes apply to this app/);
  const lock = find({ ...gradle(35), ...manifest('android:screenOrientation="portrait"') });
  assert.equal(lock.severity, 'info');
  assert.match(lock.title, /What changes when the app targets Android 16/);
  assert.match(lock.detail, /the app targets 35/);
  assert.match(lock.detail, /MainActivity screenOrientation="portrait"/);
});

test('API 36: games are exempt; the temporary opt-out is mentioned; nothing to say otherwise', () => {
  assert.equal(find({ ...gradle(36), ...manifest('android:screenOrientation="landscape"', 'android:appCategory="game"') }), undefined);
  const withProperty = find({ ...gradle(36), 'android/app/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><property android:name="android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY" android:value="true" /><activity android:name=".MainActivity" android:resizeableActivity="false"/></application></manifest>' });
  assert.match(withProperty.detail, /stops working when you target API 37/);
  assert.equal(find({ ...gradle(36), ...manifest('') }), undefined);
});
