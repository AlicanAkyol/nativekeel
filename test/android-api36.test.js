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

test('API 36: expo-camera brings a portrait-locked scanner activity into the merged manifest', () => {
  const cam = (v, files = {}) => nativeChecks(loadProject(makeProject({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.81.0', expo: '~54.0.0', 'expo-camera': v } }, ...gradle(36), ...manifest(''), ...files }))).find((f) => f.id === 'android-api36-behavior');
  const f = cam('~57.0.6');
  assert.equal(f.severity, 'info');
  assert.match(f.detail, /\(GmsBarcodeScanningDelegateActivity\) into the merged manifest/);
  assert.doesNotMatch(f.detail, /GmsDocumentScanningDelegateActivity/);
  assert.match(f.detail, /barcode-scanner-enabled=false/);
  assert.match(cam('58.0.14').detail, /GmsDocumentScanningDelegateActivity/);
  assert.equal(cam('~16.0.18'), undefined);
  assert.equal(cam('~57.0.6', { 'android/gradle.properties': 'expo.camera.barcode-scanner-enabled=false\n' }), undefined);
  const removed = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools"><application><activity android:name=".MainActivity"/><activity android:name="com.google.mlkit.vision.codescanner.internal.GmsBarcodeScanningDelegateActivity" tools:remove="android:screenOrientation"/></application></manifest>';
  assert.equal(cam('~57.0.6', { 'android/app/src/main/AndroidManifest.xml': removed }), undefined);
});

test('API 36: managed Expo with expo-camera and barcodeScannerEnabled: false says nothing', () => {
  const managed = (plugin) => nativeChecks(loadProject(makeProject({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.81.0', expo: '~57.0.0', 'expo-camera': '~57.0.6' } }, 'app.json': { expo: { plugins: [plugin] } } }))).find((f) => f.id === 'android-api36-behavior');
  assert.match(managed('expo-camera').detail, /GmsBarcodeScanningDelegateActivity/);
  assert.equal(managed(['expo-camera', { barcodeScannerEnabled: false }]), undefined);
});

test('API 36: expo-camera scanner property set through expo-build-properties in app.json', () => {
  const f = nativeChecks(loadProject(makeProject({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.81.0', expo: '~58.0.0', 'expo-camera': '~58.0.11' } }, 'app.json': { expo: { plugins: ['expo-camera', ['expo-build-properties', { android: { gradleProperties: { 'expo.camera.document-scanner-enabled': 'false' } } }]] } } }))).find((x) => x.id === 'android-api36-behavior');
  assert.match(f.detail, /GmsBarcodeScanningDelegateActivity/);
  assert.doesNotMatch(f.detail, /GmsDocumentScanningDelegateActivity/);
});

test('API 36: expo-camera lock alone names the right property and skips the portrait-layout advice', () => {
  const f = nativeChecks(loadProject(makeProject({ 'package.json': { name: 'a', dependencies: { 'react-native': '0.81.0', 'expo-camera': '58.0.14' } }, ...gradle(36), ...manifest(''), 'android/gradle.properties': 'expo.camera.barcode-scanner-enabled=false\n' }))).find((x) => x.id === 'android-api36-behavior');
  assert.match(f.detail, /expo\.camera\.document-scanner-enabled=false/);
  assert.doesNotMatch(f.detail, /barcode-scanner-enabled=false|GmsBarcode|layouts that assume portrait/);
});
