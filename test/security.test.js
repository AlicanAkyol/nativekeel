import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordLeaks, webViewRisks, androidBackup, vulnerableDependencies } from '../src/security.js';
import { lockedVersions } from '../src/lockfile.js';
import { createRegistry } from '../src/registry.js';
import { makeProject } from './helpers.js';

const leaks = (src) => passwordLeaks(makeProject({ 'package.json': '{}', 'src/a.js': src })).map((f) => f.severity);

test('password into a crash log through intermediate variables (seen in a real app)', () => {
  const src = [
    'try { await signUp(email, password); } catch (error) {',
    '  const errorData =',
    "    email.toString() + '-1-1-1-1-1-' + password.toString();",
    '  const crash = {',
    '    name: errorData,',
    '    message: error.toString(),',
    '  };',
    '  sendCrash(crash);',
    '}',
  ].join('\n');
  assert.deepEqual(leaks(src), ['high']);
});

test('password in AsyncStorage is medium; console.log alone is not reported', () => {
  assert.deepEqual(leaks("AsyncStorage.setItem('@userPassword', password);"), ['medium']);
  assert.deepEqual(leaks("console.log('login', password);"), []);
});

test('results of calls that take the password are not the password', () => {
  const src = [
    'const result = await fetch(url, { body: `user=${email}&pw=${password}` });',
    'Sentry.captureMessage(`status ${result.status}`);',
    'const token = await auth().signInWithEmailAndPassword(email, password).catch(() => null);',
    "AsyncStorage.setItem('token', token);",
    'const encrypted = JSON.stringify(encrypt(privateKey, password));',
    "AsyncStorage.setItem('key', encrypted);",
  ].join('\n');
  assert.deepEqual(leaks(src), []);
});

test('a password on a nearby line of an unrelated call is not a leak', () => {
  assert.deepEqual(leaks("track(Events.IMPORT);\nif (!valid(password)) { setError('x'); }"), []);
});

test('WebView file access and mixed content', () => {
  const root = makeProject({ 'package.json': '{}', 'src/W.js': "import { WebView } from 'react-native-webview';\n<WebView allowUniversalAccessFromFileURLs={true} mixedContentMode=\"always\" />" });
  assert.deepEqual(webViewRisks(root).map((f) => f.severity).sort(), ['high', 'medium']);
});

test('Android backups: flagged only without backup rules', () => {
  const manifest = (attrs) => makeProject({ 'android/app/src/main/AndroidManifest.xml': `<manifest><application android:name=".App" ${attrs}></application></manifest>` });
  assert.equal(androidBackup(manifest('android:allowBackup="true"')).length, 1);
  assert.equal(androidBackup(manifest('android:allowBackup="false"')).length, 0);
  assert.equal(androidBackup(manifest('android:allowBackup="true" android:dataExtractionRules="@xml/rules"')).length, 0);
});

test('vulnerable dependencies: exact versions, highest severity, fixed version', async () => {
  const registry = createRegistry(async (url, headers, body) => {
    assert.ok(url.endsWith('/security/advisories/bulk'));
    assert.deepEqual(JSON.parse(body), { axios: ['0.21.0'] });
    return {
      axios: [
        { title: 'SSRF', severity: 'high', vulnerable_versions: '<0.30.0', url: 'https://github.com/advisories/1' },
        { title: 'ReDoS', severity: 'moderate', vulnerable_versions: '<0.21.2', url: 'https://github.com/advisories/2' },
        { title: 'Old', severity: 'critical', vulnerable_versions: '<0.10.0', url: 'https://github.com/advisories/3' },
      ],
    };
  });
  const [f] = await vulnerableDependencies(registry, { axios: '0.21.0' });
  assert.equal(f.severity, 'high', 'the critical one does not apply to 0.21.0');
  assert.match(f.title, /axios 0\.21\.0: 2 known vulnerabilities/);
  assert.equal(f.fix.to, '0.30.0');
});

test('lockfiles: npm, yarn 1, yarn berry, pnpm (several YAML documents)', () => {
  const declared = { axios: '^1.0.0', lodash: '~4.17.0' };
  const npm = makeProject({ 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/axios': { version: '1.6.0' }, 'node_modules/lodash': { version: '4.17.21' } } }) });
  assert.deepEqual(lockedVersions(npm, declared), { axios: '1.6.0', lodash: '4.17.21' });
  const yarn1 = makeProject({ 'yarn.lock': '"axios@^1.0.0", axios@^1.2.0:\n  version "1.6.1"\n\nlodash@~4.17.0:\n  version "4.17.20"\n' });
  assert.deepEqual(lockedVersions(yarn1, declared), { axios: '1.6.1', lodash: '4.17.20' });
  const berry = makeProject({ 'yarn.lock': '__metadata:\n  version: 8\n\n"axios@npm:^1.0.0":\n  version: 1.7.0\n  resolution: "axios@npm:1.7.0"\n' });
  assert.deepEqual(lockedVersions(berry, declared), { axios: '1.7.0' });
  const pnpm = makeProject({
    'apps/mobile/package.json': '{}',
    'pnpm-lock.yaml': "---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n\n---\nlockfileVersion: '9.0'\n\nimporters:\n\n  apps/mobile:\n    dependencies:\n      axios:\n        specifier: ^1.0.0\n        version: 1.8.0(debug@4.0.0)\n\npackages:\n",
  });
  assert.deepEqual(lockedVersions(`${pnpm}/apps/mobile`, declared), { axios: '1.8.0' });
});

test('Node.js-only advisories do not raise the severity of a mobile dependency', async () => {
  const registry = createRegistry(async () => ({ axios: [{ title: 'Credential leak in Axios Node.js HTTP Adapter', severity: 'high', vulnerable_versions: '<1.8.0' }] }));
  const [f] = await vulnerableDependencies(registry, { axios: '1.6.0' });
  assert.equal(f.severity, 'low');
  assert.match(f.detail, /Node\.js\/server use only/);
});

test('exported components: widgets and system-broadcast receivers are fine, an open service is not', async () => {
  const { exportedComponents } = await import('../src/security.js');
  const manifest = `<manifest><application>
    <receiver android:name=".PriceWidget" android:exported="true"><intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE"/><action android:name="android.intent.action.SCREEN_ON"/></intent-filter><meta-data android:name="android.appwidget.provider" android:resource="@xml/w"/></receiver>
    <receiver android:name=".Boot" android:exported="true"><intent-filter><action android:name="android.intent.action.BOOT_COMPLETED"/></intent-filter></receiver>
    <service android:name=".Messaging" android:exported="true"><intent-filter><action android:name="com.google.firebase.MESSAGING_EVENT"/></intent-filter></service>
    <service android:name=".Protected" android:exported="true" android:permission="android.permission.BIND_JOB_SERVICE"/>
  </application></manifest>`;
  const [f] = exportedComponents(makeProject({ 'android/app/src/main/AndroidManifest.xml': manifest }));
  assert.match(f.title, /^1 Android component/);
  assert.match(f.detail, /service \.Messaging/);
});

test('plain HTTP API calls: real hosts only', async () => {
  const { plainHttpCalls } = await import('../src/security.js');
  const root = makeProject({
    'src/api.js': "const api = axios.create({ baseURL: 'http://api.example-shop.com' });\nfetch('http://10.0.2.2:3000/x');\nconst u = new URL(path, 'http://dummy');\nLinking.openURL('http://help.example-shop.com');",
  });
  const [f] = plainHttpCalls(root);
  assert.match(f.title, /1 host/);
  assert.match(f.detail, /api\.example-shop\.com/);
});

test('Firebase rules: open writes, whole-database reads, test mode; public folders are fine', async () => {
  const { cloudRules } = await import('../src/security.js');
  const now = new Date('2026-10-05');
  const ids = (files) => cloudRules(makeProject({ 'package.json': '{}', ...files }), {}, now).map((f) => `${f.id}:${f.severity}`);
  assert.deepEqual(ids({ 'database.rules.json': '{"rules":{".read":true,".write":true}}' }), ['firebase-rtdb-open:critical']);
  assert.deepEqual(ids({ 'database.rules.json': '{"rules":{".read":"auth != null",".write":"auth != null"}}' }), ['firebase-rtdb-any-user:medium']);
  assert.deepEqual(ids({ 'firestore.rules': "service cloud.firestore {\n match /databases/{db}/documents {\n  match /{document=**} {\n   allow read, write: if request.time < timestamp.date(2027, 1, 1);\n  }\n }\n}" }), ['firebase-firestore-test-mode:critical']);
  assert.deepEqual(ids({ 'firestore.rules': "service cloud.firestore {\n match /databases/{db}/documents {\n  match /posts/{id} {\n   allow write: if true;\n  }\n }\n}" }), ['firebase-firestore-open-write:critical']);
  assert.deepEqual(ids({ 'storage.rules': "service firebase.storage {\n match /b/{bucket}/o {\n  match /{allPaths=**} {\n   allow read;\n  }\n }\n}" }), ['firebase-storage-open-read:high']);
  assert.deepEqual(
    ids({ 'storage.rules': "service firebase.storage {\n match /b/{bucket}/o {\n  match /events/{id}/{file=**} {\n   allow read: if true;\n   allow write: if request.auth != null;\n  }\n  match /{allPaths=**} {\n   allow read, write: if false;\n  }\n }\n}" }),
    [],
    'public event images, everything else closed',
  );
  const used = cloudRules(makeProject({ 'package.json': '{}' }), { '@react-native-firebase/database': '22.0.0' }, now);
  assert.equal(used[0].id, 'firebase-rules-not-in-repo');
});
