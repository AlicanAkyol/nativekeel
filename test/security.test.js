import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { passwordLeaks, webViewRisks, androidBackup, vulnerableDependencies, tokenStorage } from '../src/security.js';
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
  const root = makeProject({ 'package.json': '{}', 'src/W.js': "import { WebView } from 'react-native-webview';\n<WebView source={{ uri: 'file://' + dir + '/page.html' }} allowUniversalAccessFromFileURLs={true} mixedContentMode=\"always\" />" });
  assert.deepEqual(webViewRisks(root).map((f) => f.severity).sort(), ['high', 'medium']);
});

test('file-URL flags on a WebView that only loads web URLs do nothing today', () => {
  const remote = makeProject({ 'package.json': '{}', 'src/W.js': "import { WebView } from 'react-native-webview';\nconst P = ({ originWhitelist = ['file://*', 'https://*'] }) => <WebView allowUniversalAccessFromFileURLs originWhitelist={originWhitelist} source={{ uri: partnerUrl }} />;" });
  assert.deepEqual(webViewRisks(remote).map((f) => f.severity), ['low'], 'Edge partner pages; originWhitelist is not a page');
  const inline = makeProject({ 'package.json': '{}', 'src/W.js': "import { WebView } from 'react-native-webview';\n<WebView allowFileAccessFromFileURLs source={{ html: content }} />" });
  assert.deepEqual(webViewRisks(inline).map((f) => f.severity), ['high']);
  const imported = makeProject({
    'package.json': '{}',
    'src/source.ts': "export const EDITOR_URI = Platform.OS === 'android' ? 'file:///android_asset/index.html' : 'build.bundle/index.html';",
    'src/Editor.tsx': "import { WebView } from 'react-native-webview';\nimport { EDITOR_URI } from './source';\n<WebView allowUniversalAccessFromFileURLs source={{ uri: EDITOR_URI }} />",
  });
  assert.deepEqual(webViewRisks(imported).map((f) => f.severity), ['high'], 'Notesnook: the local address is in an imported file');
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
        { title: 'Prototype pollution', severity: 'high', vulnerable_versions: '<0.30.0', url: 'https://github.com/advisories/1' },
        { title: 'ReDoS', severity: 'moderate', vulnerable_versions: '<0.21.2', url: 'https://github.com/advisories/2' },
        { title: 'Old', severity: 'critical', vulnerable_versions: '<0.10.0', url: 'https://github.com/advisories/3' },
        { title: 'Axios: no_proxy bypass via IP alias allows SSRF', severity: 'high', vulnerable_versions: '<0.30.0', url: 'https://github.com/advisories/4' },
      ],
    };
  });
  const [f] = await vulnerableDependencies(registry, { axios: '0.21.0' });
  assert.equal(f.severity, 'high', 'the critical one does not apply to 0.21.0');
  assert.match(f.title, /axios 0\.21\.0: 2 known vulnerabilities \(\+1 for Node\.js only\)/, 'the proxy advisory cannot reach a React Native app');
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
  const proxies = createRegistry(async () => ({ axios: [
    { title: 'Axios: NO_PROXY hostname normalization bypass leads to SSRF', severity: 'high', vulnerable_versions: '>=1.0.0 <1.15.0' },
    { title: 'Axios: HTTP/2 adapter bypasses configured DNS lookup', severity: 'high', vulnerable_versions: '>=1.13.0 <1.20.0' },
  ] }));
  assert.equal((await vulnerableDependencies(proxies, { axios: '1.13.2' }))[0].severity, 'low');
});

test('fixed version: the highest bound wins, and "<=" ranges count (seen with axios 1.13.2)', async () => {
  const registry = createRegistry(async () => ({ axios: [
    { title: 'DoS via __proto__ key', severity: 'high', vulnerable_versions: '>=1.0.0 <=1.13.4' },
    { title: 'Header injection', severity: 'moderate', vulnerable_versions: '>=1.0.0 <1.20.0' },
  ] }));
  const [f] = await vulnerableDependencies(registry, { axios: '1.13.2' });
  assert.equal(f.fix.to, '1.20.0');
  assert.match(f.title, /\(fixed in 1\.20\.0\)/);
  const only = createRegistry(async () => ({ axios: [{ title: 'DoS via __proto__ key', severity: 'high', vulnerable_versions: '>=1.0.0 <=1.13.4' }] }));
  assert.equal((await vulnerableDependencies(only, { axios: '1.13.2' }))[0].fix.to, 'a release after 1.13.4');
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

test('TLS bypasses: unconditional is critical, behind a setting is high; user CAs only in release', async () => {
  const { insecureTls } = await import('../src/security.js');
  const trustAll = 'object : X509TrustManager {\n  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}\n}';
  const always = insecureTls(makeProject({ 'android/app/src/main/java/a/Main.kt': `class Main { val tm = ${trustAll} }` }));
  assert.equal(always[0].severity, 'critical');
  const optIn = insecureTls(makeProject({ 'android/app/src/main/java/a/Client.kt': `fun socket(validateCertificates: Boolean) {\n  if (!validateCertificates) {\n    val tm = ${trustAll}\n  }\n}` }));
  assert.equal(optIn[0].severity, 'high');
  assert.equal(insecureTls(makeProject({ 'android/app/src/main/java/a/Ok.kt': 'override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) { delegate.checkServerTrusted(chain, authType) }' })).length, 0);
  const nsc = (body) => insecureTls(makeProject({ 'android/app/src/main/res/xml/network_security_config.xml': `<network-security-config>${body}</network-security-config>` }));
  assert.equal(nsc('<base-config><trust-anchors><certificates src="user"/></trust-anchors></base-config>').length, 1);
  assert.equal(nsc('<debug-overrides><trust-anchors><certificates src="user"/></trust-anchors></debug-overrides>').length, 0);
});

test('weak crypto: real uses, not comments or non-security randomness', async () => {
  const { weakCrypto } = await import('../src/security.js');
  const ids = (src) => weakCrypto(makeProject({ 'package.json': '{}', 'src/a.js': src })).map((f) => f.id);
  assert.deepEqual(ids("const enc = CryptoJS.AES.encrypt(data, 'my-secret-key');"), ['crypto-hardcoded-key']);
  assert.deepEqual(ids('const body = { password: md5(passWord) };'), ['crypto-weak-password-hash']);
  assert.deepEqual(ids('// D1 = MD5( password || salt )\n/* sha1(password) */'), []);
  assert.deepEqual(ids('const nonce = Math.random().toString(16);'), ['crypto-insecure-random']);
  assert.deepEqual(ids('// Dummy response for the test server\nconst ts = Date.now();\nconst nonce = `nonce_${Math.random().toString(36)}`;'), [], 'a nonce in a dummy response protects nothing');
  assert.deepEqual(ids('const token = Math.floor(Math.random() * 1e9); // cache bust'), []);
});

test('auth tokens in AsyncStorage are a low finding', async () => {
  const { tokenStorage } = await import('../src/security.js');
  const [f] = tokenStorage(makeProject({ 'src/a.js': "await AsyncStorage.setItem('accessToken', token);\nawait AsyncStorage.setItem('theme', 'dark');" }));
  assert.equal(f.severity, 'low');
  assert.match(f.detail, /accessToken/);
});

test('dependencies from git are never matched against npm advisories', async () => {
  const { analyze } = await import('../src/analyze.js');
  const { loadProject } = await import('../src/project.js');
  const { fakeRegistry } = await import('./helpers.js');
  const root = makeProject({
    'package.json': { name: 'g', dependencies: { 'react-native': '0.80.0', 'react-native-blue-crypto': 'github:Owner/react-native-blue-crypto#3cb5442' } },
    'node_modules/react-native/package.json': { version: '0.80.0' },
    'node_modules/react-native-blue-crypto/package.json': { version: '1.0.0' },
  });
  const get = fakeRegistry({ advisories: { 'react-native-blue-crypto': [{ title: 'Malware in react-native-blue-crypto', severity: 'critical', vulnerable_versions: '>=0' }] } });
  const result = await analyze(loadProject(root), { get, now: new Date('2026-10-05') });
  assert.ok(!result.findings.some((f) => f.id === 'vuln:react-native-blue-crypto'));
});

test('reverse engineering: source maps in the app, and an easy-to-read release build', async () => {
  const { reverseEngineering } = await import('../src/security.js');
  const project = { managed: false };
  const map = reverseEngineering(makeProject({ 'android/app/src/main/assets/index.android.bundle.map': '{}' }), project);
  assert.equal(map[0].id, 'sourcemap-in-app');
  assert.equal(map[0].severity, 'high');
  const easy = reverseEngineering(makeProject({ 'android/app/build.gradle': 'def enableProguardInReleaseBuilds = false', 'android/gradle.properties': 'hermesEnabled=false' }), project);
  assert.equal(easy[0].id, 'easy-reverse-engineering');
  assert.match(easy[0].detail, /Hermes is off.*R8\/ProGuard is off/);
  assert.equal(reverseEngineering(makeProject({ 'android/app/build.gradle': 'def enableProguardInReleaseBuilds = true' }), project).length, 0);
});

test('Expo config secrets: extra and EXPO_PUBLIC_ ship, eas.json env is committed, public SDK keys are fine', async () => {
  const { expoConfigSecrets } = await import('../src/security.js');
  const tok = ['sntrys', '_eyJpYXQiOjE3', 'MDAwMDAwMDB9'].join('');
  const root = makeProject({
    'app.json': JSON.stringify({ expo: { extra: { stripeSecretKey: 'sk_test_abcdefghijklmnop', apiUrl: 'https://api.example-shop.com' } } }),
    'eas.json': JSON.stringify({ build: { production: { env: { SENTRY_AUTH_TOKEN: tok, EXPO_PUBLIC_RC_ANDROID_API_KEY: 'goog_abcdefghijklmnop' } } } }),
  });
  const found = expoConfigSecrets(root);
  assert.deepEqual(found.map((f) => f.id).sort(), ['expo-secret-committed', 'expo-secret-shipped']);
  assert.ok(!JSON.stringify(found).includes(tok), 'values are masked');
  assert.ok(!JSON.stringify(found).includes('RC_ANDROID_API_KEY'), 'public SDK keys are not reported');
});

test('deep links: unverified web links, autoVerify anywhere verifies all hosts, template scheme', async () => {
  const { deepLinks } = await import('../src/security.js');
  const filter = (attrs, data) => `<intent-filter ${attrs}><action android:name="android.intent.action.VIEW" /><category android:name="android.intent.category.DEFAULT" /><category android:name="android.intent.category.BROWSABLE" />${data}</intent-filter>`;
  const manifest = (...filters) => ({ 'android/app/src/main/AndroidManifest.xml': `<manifest><application><activity android:name=".MainActivity">${filters.join('')}</activity></application></manifest>` });

  const invite = deepLinks(makeProject(manifest(filter('', '<data android:scheme="https" android:host="invite.example.org" />'))));
  assert.deepEqual(invite.map((f) => [f.id, f.severity]), [['deeplink-unverified', 'medium']]);
  const plain = deepLinks(makeProject(manifest(filter('', '<data android:scheme="https" android:host="www.example.org" />'))));
  assert.equal(plain[0].severity, 'low');
  const verifiedElsewhere = manifest(filter('android:autoVerify="true"', '<data android:scheme="https" android:host="a.example.org" />'), filter('', '<data android:scheme="https" android:host="b.example.org" />'));
  assert.equal(deepLinks(makeProject(verifiedElsewhere)).length, 0);
  assert.equal(deepLinks(makeProject(manifest(filter('', '<data android:scheme="https" />')))).length, 0, 'catch-all browser filters have no host to verify');

  const expo = (scheme) => makeProject({ 'app.json': JSON.stringify({ expo: { scheme } }) });
  assert.deepEqual(deepLinks(expo('myapp')).map((f) => [f.id, f.severity]), [['deeplink-template-scheme', 'low']]);
  assert.equal(deepLinks(expo('myapp'), { 'expo-auth-session': '~6.0.0' })[0].severity, 'medium');
  assert.equal(deepLinks(expo('com.acme.shop')).length, 0);
});

test('no fixed release: "<=" up to the latest published version (expr-eval 2.0.2)', async () => {
  const registry = createRegistry(async () => ({ 'expr-eval': [{ title: 'Code execution', severity: 'critical', vulnerable_versions: '<=2.0.2' }], lodash: [{ title: 'Code injection via _.template', severity: 'high', vulnerable_versions: '>=4.0.0 <=4.17.23' }] }));
  const found = await vulnerableDependencies(registry, { 'expr-eval': '2.0.2', lodash: '4.17.21' }, { 'expr-eval': '2.0.2', lodash: '4.18.1' });
  const byName = Object.fromEntries(found.map((f) => [f.fix.name, f]));
  assert.ok(byName['expr-eval'].fix.noFix);
  assert.match(byName['expr-eval'].title, /no fixed release/);
  assert.match(byName['expr-eval'].detail, /the latest is 2\.0\.2/);
  assert.equal(byName.lodash.fix.to, '4.18.1');
});

test('token storage by value: constant keys and objects with a token; push tokens are fine', async () => {
  const { tokenStorage } = await import('../src/security.js');
  const hits = (code) => { const [f] = tokenStorage(makeProject({ 'src/a.js': code })); return f ? f.detail : ''; };
  assert.match(hits('await AsyncStorage.setItem(TOKEN_KEY, token);'), /TOKEN_KEY \(src\/a\.js:1\)/);
  assert.match(hits("await AsyncStorage.setItem('authState', JSON.stringify({ token, expiresIn }));"), /'authState'/);
  assert.equal(hits("await AsyncStorage.setItem('pushToken', expoPushToken);"), '');
  assert.equal(hits("await AsyncStorage.setItem('fcm', token);"), '');
  assert.equal(hits("await AsyncStorage.setItem('theme', 'dark');"), '');
});

test('token storage: web-only files are skipped', async () => {
  const { tokenStorage } = await import('../src/security.js');
  assert.equal(tokenStorage(makeProject({ 'src/keychain.web.ts': 'await AsyncStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);' })).length, 0);
});

test('false alarms from the October corpus: key placeholders, Subsonic tokens', async () => {
  const { weakCrypto } = await import('../src/security.js');
  const { scanSecrets } = await import('../src/secrets.js');
  const header = ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----'].join('');
  const placeholders = makeProject({
    'package.json': '{}',
    'src/Form.tsx': `<TextInput placeholder={"${header}\\nPaste your private key here...\\n-----END OPENSSH PRIVATE KEY-----"} />\nconst sample = '${header}\\n...\\n';\n`,
  });
  assert.equal(scanSecrets(placeholders).length, 0, 'placeholders and elided samples are not keys');
  const sub = weakCrypto(makeProject({ 'src/subsonic.ts': '// Subsonic API auth\nexport const token = (password, salt) => md5(password + salt);' }));
  assert.equal(sub[0].severity, 'low');
  assert.match(sub[0].title, /required by the Subsonic API/);
  const plain = weakCrypto(makeProject({ 'src/auth.ts': 'const h = md5(password);' }));
  assert.equal(plain[0].severity, 'high');
});

test('Supabase: public tables without RLS (a commented-out enable does not count); other schemas and RLS loops are fine', async () => {
  const { supabaseRls } = await import('../src/security.js');
  const mig = (sql) => supabaseRls(makeProject({ 'package.json': '{}', 'supabase/migrations/1_init.sql': sql }));
  const open = mig('create table todos (id bigint primary key);\n-- alter table todos enable row level security;\ncreate table public.profiles (id uuid);\nalter table public.profiles enable row level security;');
  assert.equal(open[0].id, 'supabase-rls-off');
  assert.match(open[0].title, /1 Supabase table without row level security \(todos\)/);
  assert.equal(mig('create table app.cats (id int);').length, 0, 'not in the public schema');
  assert.equal(mig("create table todos (id int);\ndo $$ begin execute format('alter table %I.%I enable row level security', s, t); end $$;").length, 0);
  assert.equal(supabaseRls(makeProject({ 'package.json': '{}', 'db/schema.sql': 'create table customers (id int);' })).length, 0, 'SQL outside supabase/ may be another database');
});

test('Google Play restricted permissions: removed ones do not count; photo access next to a picker is high', async () => {
  const { playRestrictedPermissions } = await import('../src/security.js');
  const manifest = (perms) => ({ 'android/app/src/main/AndroidManifest.xml': `<manifest>${perms}<application/></manifest>` });
  const f = playRestrictedPermissions(makeProject(manifest('<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" /><uses-permission android:name="android.permission.CAMERA" />')), { 'expo-image-picker': '~16.0.0' });
  assert.equal(f[0].severity, 'high');
  assert.match(f[0].title, /READ_MEDIA_IMAGES/);
  assert.equal(playRestrictedPermissions(makeProject(manifest('<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" tools:node="remove" />'))).length, 0);
  assert.equal(playRestrictedPermissions(makeProject(manifest('<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />')))[0].severity, 'medium');
  const expo = playRestrictedPermissions(makeProject({ 'app.json': JSON.stringify({ expo: { android: { permissions: ['android.permission.MANAGE_EXTERNAL_STORAGE', 'READ_MEDIA_VIDEO'], blockedPermissions: ['android.permission.READ_MEDIA_VIDEO'] } } }) }));
  assert.match(expo[0].title, /\(MANAGE_EXTERNAL_STORAGE\)/);
});

test('react-native-blob-util trust manager: unused, behind a setting, or always on', async () => {
  const { insecureTls } = await import('../src/security.js');
  const kt = "class MainApplication { override fun onCreate() {\n ReactNativeBlobUtilUtils.sharedTrustManager = object : X509TrustManager {\n override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}\n } } }";
  const app = (js) => insecureTls(makeProject({ 'android/app/src/main/java/com/a/MainApplication.kt': kt, ...(js ? { 'src/api.ts': js } : {}) }));
  assert.equal(app(null).length, 0, 'never used by any request');
  assert.equal(app('ReactNativeBlobUtil.config({ trusty: !certVerification }).fetch("GET", url);')[0].severity, 'high');
  assert.equal(app('ReactNativeBlobUtil.config({ trusty: true }).fetch("GET", url);')[0].severity, 'critical');
});

test('AI provider keys read from build-time variables ship inside the app', async () => {
  const { aiKeysInBundle } = await import('../src/security.js');
  const run = (files, deps) => aiKeysInBundle(makeProject({ 'package.json': '{}', ...files }), deps);
  const groq = run({ 'utils/ai/client.ts': "const key = () => process.env.EXPO_PUBLIC_GROQ_API_KEY || '';\nfetch('https://api.groq.com/openai/v1/chat/completions', { headers: { Authorization: `Bearer ${key()}` } });" }, { expo: '~54.0.0' });
  assert.equal(groq.length, 1);
  assert.equal(groq[0].severity, 'high');
  assert.match(groq[0].title, /^Groq API key ships inside the app \(utils\/ai\/client\.ts:1\)/);
  assert.match(groq[0].detail, /calls Groq directly/);
  assert.equal(run({ 'src/a.ts': 'const k = process.env.EXPO_PUBLIC_OPENAI_API_KEY;' }, {}).length, 0, 'not an Expo app: nothing inlines it');
  assert.equal(run({ 'server/ai.ts': 'const k = process.env.EXPO_PUBLIC_OPENAI_API_KEY;', 'app/chat+api.ts': 'const k = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;' }, { expo: '~54.0.0' }).length, 0, 'server code and Expo API routes stay on the server');
  assert.equal(run({ 'src/a.ts': '// const k = process.env.EXPO_PUBLIC_OPENAI_API_KEY;\nconst m = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;' }, { expo: '~54.0.0' }).length, 0, 'comments and non-AI keys');
  const dotenv = run({ 'services/t.js': "import { OPENAI_API_KEY, API_URL } from '@env';" }, { 'react-native-dotenv': '^3.4.0' });
  assert.match(dotenv[0].detail, /react-native-dotenv/);
  const config = run({ 'src/api.ts': "import Config from 'react-native-config';\nconst k = Config.GEMINI_API_KEY;" }, { 'react-native-config': '^1.5.0' });
  assert.match(config[0].title, /^Google Gemini API key/);
});

test('wallet secrets copied to the clipboard', async () => {
  const { clipboardSecrets } = await import('../src/security.js');
  const run = (src) => clipboardSecrets(makeProject({ 'package.json': '{}', 'src/a.tsx': src }));
  assert.equal(run("import Clipboard from '@react-native-clipboard/clipboard';\nClipboard.setString(seed.join(' '));").length, 1);
  assert.equal(run("import * as Clipboard from 'expo-clipboard';\nawait Clipboard.setStringAsync(type === 'privateKey' ? privateKey : publicKey);").length, 1, 'a private key next to a public one');
  assert.equal(run("Clipboard.setString(displayPublicSeed);").length, 0, 'a public seed');
  assert.equal(run("Clipboard.setString(address);").length, 0);
  assert.equal(run("Clipboard.setString(mnemonic);\ntimer.current = setTimeout(() => { Clipboard.setString(''); }, 60000);").length, 0, 'cleared again after a minute');
  assert.equal(run("// Clipboard.setString(mnemonic);").length, 0, 'comments');
});

test('keychain items readable while the device is locked', async () => {
  const { keychainAccessibility } = await import('../src/security.js');
  const run = (files) => keychainAccessibility(makeProject({ 'package.json': '{}', ...files }));
  assert.equal(run({ 'src/store.ts': "await Keychain.setGenericPassword('u', pw, { accessible: Keychain.ACCESSIBLE.ALWAYS });" }).length, 1);
  assert.equal(run({ 'src/keys.ts': 'await SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.ALWAYS_THIS_DEVICE_ONLY });' }).length, 1);
  assert.equal(run({ 'ios/App/Store.swift': 'let q: [String: Any] = [kSecAttrAccessible as String: kSecAttrAccessibleAlways]' }).length, 1);
  assert.equal(run({ 'src/store.ts': 'await Keychain.setGenericPassword(u, pw, { accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });' }).length, 0);
  assert.equal(run({ 'packages/react-native-keychain-9/src/index.ts': 'ACCESSIBLE.ALWAYS' }).length, 0, "a vendored library's own table");
  assert.equal(run({ 'ios/Lib/SecureStorage.m': '@"AccessibleAlways": (__bridge NSString *)kSecAttrAccessibleAlways,' }).length, 0, 'a name-to-constant table');
  assert.equal(run({ 'config/test/native.ts': "ACCESSIBLE: { ALWAYS_THIS_DEVICE_ONLY: 'x' }, use(ACCESSIBLE.ALWAYS)" }).length, 0, 'test config');
});

test('token storage: auth tokens are reported; push and invitation tokens behind constants are not', () => {
  const root = makeProject({
    'package.json': { name: 'x', dependencies: { 'react-native': '0.80.0' } },
    'src/auth.ts': "import AsyncStorage from '@react-native-async-storage/async-storage';\nconst KEY = 'session';\nexport const save = (accessToken) => AsyncStorage.setItem(KEY, accessToken);",
    'src/services/pushRegistration.ts': "import AsyncStorage from '@react-native-async-storage/async-storage';\nconst SYNCED_KEY = 'AppPushTokenSynced';\nexport const mark = (reg) => AsyncStorage.setItem(SYNCED_KEY, reg.token);",
    'src/invites.ts': "import AsyncStorage from '@react-native-async-storage/async-storage';\nconst PENDING = 'app:pendingInvitationToken';\nexport const keep = (token) => AsyncStorage.setItem(PENDING, token);",
  });
  try {
    const [f] = tokenStorage(root);
    assert.match(f.detail, /^KEY \(src\/auth\.ts:3\)\. /);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('redux-persist keeping the auth slice in AsyncStorage', () => {
  const store = (src) => tokenStorage(makeProject({ 'package.json': '{}', 'src/store.ts': src })).map((f) => f.detail);
  const [d] = store("import AsyncStorage from '@react-native-async-storage/async-storage';\nimport { persistReducer } from 'redux-persist';\nexport const r = persistReducer({ key: 'root', storage: AsyncStorage, whitelist: ['auth', 'settings'] }, root);");
  assert.match(d, /redux-persist "auth" slice \(src\/store\.ts:3\)/);
  assert.deepEqual(store("import AsyncStorage from '@react-native-async-storage/async-storage';\nimport { persistReducer } from 'redux-persist';\nexport const r = persistReducer({ key: 'root', storage: AsyncStorage, whitelist: ['settings', 'theme'] }, root);"), []);
});

test('plain HTTP API constants and exported activities without an intent filter', async () => {
  const { plainHttpCalls, exportedComponents } = await import('../src/security.js');
  const http = (src) => plainHttpCalls(makeProject({ 'src/api.ts': src })).map((f) => f.detail);
  assert.match(http("const API_BASE = 'http://api.shop.io/v2';\nexport const get = () => fetch(`${API_BASE}/x`);")[0] || '', /api\.shop\.io/);
  assert.match(http("export const BASE: string = 'http://api.shop.io';")[0] || '', /api\.shop\.io/);
  assert.deepEqual(http("const PRIVACY_URL = 'http://shop.io/privacy';\nconst DOCS = 'http://docs.shop.io';"), []);
  const xml = (app) => exportedComponents(makeProject({ 'android/app/src/main/AndroidManifest.xml': `<manifest><application>${app}</application></manifest>` })).map((f) => f.detail);
  assert.match(xml('<activity android:name=".AdminActivity" android:exported="true" />')[0] || '', /activity \.AdminActivity/);
  assert.deepEqual(xml('<activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN" /></intent-filter></activity><activity android:name=".Secure" android:exported="true" android:permission="x.P" /><activity android:name=".Inner" android:exported="false" />'), []);
});

test('credentials logged in release builds; development-only and stripped logs are not', async () => {
  const { sensitiveLogs } = await import('../src/security.js');
  const run = (files) => sensitiveLogs(makeProject({ 'package.json': '{}', ...files })).map((f) => f.detail);
  assert.match(run({ 'src/a.ts': "export const ok = (res) => { console.log('login ok', res.accessToken); };" })[0] || '', /src\/a\.ts:1 \(`accessToken`\)/);
  assert.match(run({ 'src/a.ts': 'console.log(`token=${token}`);' })[0] || '', /`token`/);
  assert.match(run({ 'src/api/auth.ts': "console.log('session', accessToken);" })[0] || '', /src\/api\/auth\.ts/, 'client API code inside the app');
  assert.match(run({ 'src/a.ts': "console.log('refresh', accessToken.refresh_token);" })[0] || '', /`refresh_token`/, 'the token property of a token object');
  assert.match(run({ 'apps/mobile/package.json': '{"dependencies":{"react-native":"0.80.0"}}', 'apps/mobile/src/a.ts': 'console.log(password);' })[0] || '', /apps\/mobile/, 'a nested React Native app is still checked');
  for (const files of [
    { 'src/a.ts': "if (__DEV__) console.log('t', token);" },
    { 'src/a.ts': "__DEV__ && console.log('t', token);" },
    { 'src/a.ts': "console.log('token refreshed');" },
    { 'src/a.ts': "console.log('push', expoPushToken);" },
    { 'src/a.ts': 'console.warn(`Unexpected token type ${token.type} in markdown parser.`);' },
    { 'src/a.ts': "console.log('API Key:', apiKey ? 'Present' : 'Missing');" },
    { 'src/a.ts': 'console.log(`client, token: ${Boolean(token)}`);' },
    { 'src/a.ts': "console.log('Error downloading metadata of token', token);" },
    { 'src/a.ts': "console.log('params', { hasUrl: !!url, hasAccessToken: !!access_token });" },
    { 'src/a.ts': "console.error('missing', { hasApiKey: !!apiKey, token: !!token });" },
    { 'src/a.ts': "console.log('ok', { hasToken: !!response.data.token, n: Boolean(res?.accessToken) });" },
    { 'src/a.ts': "console.log('mapbox', { tokenLength: token?.length || 0 });" },
    { 'admin/package.json': '{"dependencies":{"bcrypt":"5.0.0"}}', 'admin/src/hash.js': 'console.log(password);' },
    { 'src/a.ts': "console.log('ExpoPushToken:', token);" },
    { 'src/notifications/register.ts': 'console.log(token);' },
    { 'backend/server.js': 'console.log(apiKey);' },
    { 'scripts/seed.js': 'console.log(secret);' },
    { 'packages/api/src/auth.ts': 'console.log(accessToken);' },
    { 'src/a.ts': "console.log('has token', !!token, token.length);" },
    { 'src/a.ts': "// console.log(token)\nconsole.log('x');" },
    { 'src/a.ts': "console.log(token);", 'babel.config.js': "module.exports = { env: { production: { plugins: ['transform-remove-console'] } } };" },
  ]) assert.deepEqual(run(files), [], JSON.stringify(files));
});

test('server secrets read by app code: provider names and generic *_SECRET; SDK secrets made for the app are not', async () => {
  const { backendAdminInBundle } = await import('../src/security.js');
  const run = (code, deps = { expo: '58.0.0' }) => backendAdminInBundle(makeProject({ 'package.json': '{}', 'src/a.ts': code }), deps).map((f) => f.title);
  assert.match(run('const s = process.env.EXPO_PUBLIC_CLOUDINARY_API_SECRET;')[0] || '', /^Cloudinary API secret ships/);
  assert.match(run("import { AWS_SECRET_ACCESS_KEY } from '@env';", { 'react-native-dotenv': '3.0.0' })[0] || '', /^AWS secret access key ships/);
  assert.match(run('const s = process.env.EXPO_PUBLIC_FATSECRET_CLIENT_SECRET;')[0] || '', /^Server secret ships/);
  assert.match(run('const s = process.env.EXPO_PUBLIC_API_SHARED_SECRET;')[0] || '', /^Server secret ships/);
  for (const code of ['const s = process.env.EXPO_PUBLIC_SINGULAR_SDK_SECRET;', 'const a = process.env.EXPO_PUBLIC_ADJUST_APP_SECRET;', 'const k = process.env.EXPO_PUBLIC_RAINBOW_MASTER_KEY;', 'const k = process.env.EXPO_PUBLIC_SECRET_SANTA_URL;']) assert.deepEqual(run(code), [], code);
});

test('reads open to any signed-in user on people and private records; public buckets with private names; people tables readable by everyone', async () => {
  const { firebaseBroadWrites, supabaseBroadPolicies } = await import('../src/authorization.js');
  const fb = (files) => firebaseBroadWrites(makeProject(files)).filter((f) => f.id.startsWith('firebase-auth-only-read')).map((f) => f.title);
  const rules = "service cloud.firestore {\n  match /databases/{database}/documents {\n    match /users/{userId} {\n      allow read: if request.auth != null;\n    }\n    match /products/{id} {\n      allow read: if request.auth != null;\n    }\n  }\n}";
  assert.deepEqual(fb({ 'firestore.rules': rules }), ['Any signed-in user can read every users document (firestore.rules:4)']);
  assert.equal(fb({ 'storage.rules': 'service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read: if request.auth != null; } } }' }).length, 1);
  assert.deepEqual(fb({ 'storage.rules': 'service firebase.storage { match /b/{bucket}/o { match /User/{uid}/icon/{allPaths=**} { allow read: if request.auth != null; } } }' }), []);
  const sb = (sql) => supabaseBroadPolicies(makeProject({ 'supabase/migrations/0001.sql': sql })).filter((f) => /broad-read|private-bucket/.test(f.id)).map((f) => f.title);
  const profiles = 'create table public.profiles (id uuid primary key, email text, display_name text);\nalter table public.profiles enable row level security;\ncreate policy "read all" on public.profiles for select to anon using (true);';
  assert.match(sb(profiles)[0] || '', /^Anyone can read every row of public\.profiles, which holds email/);
  assert.deepEqual(sb(profiles.replace(/profiles/g, 'hospitals')), [], 'a hospital phone/email is public on purpose');
  assert.match(sb("insert into storage.buckets (id, name, public) values ('receipts', 'receipts', true);")[0] || '', /Storage bucket "receipts" is public/);
  assert.deepEqual(sb("insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);"), []);
});

test('moment: the ReDoS applies, the server-only locale path traversal is counted as Node.js only', async () => {
  const registry = { advisories: async () => ({ moment: [
    { title: 'Moment.js vulnerable to Inefficient Regular Expression Complexity', severity: 'high', vulnerable_versions: '>=2.18.0 <2.29.4', url: 'https://github.com/advisories/GHSA-wc69-rhjr-hc9g' },
    { title: 'moment vulnerable to Path Traversal via crafted non-string locale name', severity: 'moderate', vulnerable_versions: '>=2.29.2 <2.31.0', url: 'https://github.com/advisories/GHSA-4p3w-j4w9-5jqw' },
  ] }) };
  const [f] = await vulnerableDependencies(registry, { moment: '2.29.3' });
  assert.equal(f.severity, 'high');
  assert.match(f.title, /moment 2\.29\.3: 1 known vulnerability \(\+1 for Node\.js only\)/);
});

test('Supabase: harmless statements no longer hide the policies; risky ones still do', async () => {
  const { supabaseBroadPolicies } = await import('../src/authorization.js');
  const titles = (sql) => supabaseBroadPolicies(makeProject({ 'supabase/migrations/0001.sql': sql })).map((f) => f.title);
  const base = 'create table public.profiles (id uuid primary key, email text);\nalter table public.profiles enable row level security;\n';
  const open = 'create policy "all" on public.profiles for select to anon using (true);\n';
  assert.equal(titles(`SET search_path = public;\nselect cron.schedule('x', '* * * * *', 'select 1');\n${base}alter table public.profiles add column phone text;\n${open}`).length, 1, 'session settings, a cron call and a new column');
  assert.equal(titles(`${base}DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'all') THEN\n${open}END IF; END $$;`).length, 1, 'policy created inside DO … IF NOT EXISTS');
  assert.deepEqual(titles(`${base}${open}DO $$ BEGIN EXECUTE format('drop policy %I on public.profiles', 'all'); END $$;`), [], 'dynamic SQL in a DO block');
  assert.deepEqual(titles(`${base}${open}alter table public.profiles rename to people;`), [], 'a rename');
  assert.deepEqual(titles(`create function public.fix() returns void language plpgsql as $$ begin drop policy "all" on public.profiles; end $$;\n${base}${open}select public.fix();`), [], 'a SELECT that calls a function which drops the policy');
});
