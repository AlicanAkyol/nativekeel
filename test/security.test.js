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
