import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mobileSecurity } from '../src/mobile-security.js';
import { makeProject } from './helpers.js';
const scan = files => { const root = makeProject(files); try { return mobileSecurity(root); } finally { fs.rmSync(root, { recursive: true }); } };
const js = text => scan({ 'src/app.tsx': text }).findings;
const ids = text => js(text).map(f => f.id.split(':')[0]);
const sentry = `import * as Sentry from '@sentry/react-native';\n`;
const webview = `import {WebView} from 'react-native-webview';\n`;
const sqlite = `import * as SQLite from 'expo-sqlite';\n`;
const auth = `import {useAuthRequest} from 'expo-auth-session';\n`;

test('credential telemetry: imported SDK, nested values and short const aliases', () => {
  const f = js(sentry + `function report(session) {\n const payload = { nested: { value: session.accessToken } };\n Sentry.setContext('diagnostic', payload);\n}`);
  assert.equal(f.length, 1); assert.match(f[0].id, /^credential-telemetry:/);
  assert.equal(f[0].evidence[0].line, 4); assert.ok(f[0].evidence.some(e => e.line === 3));
  assert.equal(f[0].attack.evidenceType, 'static-source'); assert.match(f[0].detail, /without redaction/);
});

test('telemetry: strings, keys, redaction helpers, booleans and unrelated functions are not credentials', () => {
  for (const code of [
    `Sentry.captureMessage('accessToken');`, `Sentry.setContext('x', { accessToken: true });`,
    `Sentry.setContext('x', { present: Boolean(session.accessToken) });`,
    `Sentry.setContext('x', redact(session.accessToken));`,
    `const value = 'safe'; Sentry.captureMessage(value);`,
    `track('login', {accessToken});`, `const payload = {token: accessToken}; function other(){ const payload = {}; Sentry.setContext('x', payload); }`,
    `// Sentry.captureMessage(accessToken);\n/* Sentry.captureMessage(refreshToken); */`,
    `const r = /Sentry.captureMessage(accessToken)/;`,
  ]) assert.deepEqual(ids(sentry + code), [], code);
});

test('credential URL: only transmitted first argument with a query, aliases and encoding', () => {
  const f = js(`const url = 'https://example.invalid/user?session=' + encodeURIComponent(session.accessToken);\nfetch(url);`);
  assert.equal(f.length, 1); assert.match(f[0].id, /^credential-url:/);
  assert.equal(ids('fetch(`https://example.invalid/?auth=${session.refreshToken}`);')[0], 'credential-url');
  for (const code of [
    `fetch('https://example.invalid/', { headers: { Authorization: accessToken }});`,
    `fetch('https://example.invalid/?token=public');`,
    `fetch('https://example.invalid/?count=' + accessToken.length);`,
    `const s = "fetch('https://x/?a=' + accessToken)";`,
    `const url = 'https://x/?q=' + accessToken; url = 'https://safe'; fetch(url);`,
  ]) assert.deepEqual(ids(code), [], code);
});

test('WebView message to eval or Function: direct and local aliases carry evidence', () => {
  for (const sink of ['eval(data)', 'new Function(data)()']) {
    const f = js(webview + `const onMessage = (event) => { const data = event.nativeEvent.data; ${sink}; };`);
    assert.equal(f.length, 1, sink); assert.match(f[0].id, /^webview-message-eval:/);
    assert.match(f[0].attack.prerequisite, /control content/);
  }
});

test('execution checks do not flag JSON parsing, fixed scripts, guards or unrelated eval', () => {
  for (const code of [
    `const onMessage = e => JSON.parse(e.nativeEvent.data);`,
    `const onMessage = e => eval('1 + 2');`,
    `const onMessage = e => eval(validateCommand(e.nativeEvent.data));`,
    `const onMessage = e => { const value = e.nativeEvent.data; }; function other(){ const value = 'fixed'; eval(value); }`,
    `const onMessage = e => { const x = e.nativeEvent.data; x = 'fixed'; eval(x); };`,
  ]) assert.deepEqual(ids(webview + code), [], code);
  assert.deepEqual(ids(`eval(event.nativeEvent.data);`), []);
});

test('remote response body to eval is traced, not guessed from a variable name', () => {
  const f = js(`async function load() {\nconst response = await fetch(endpoint);\nconst code = await response.text();\neval(code);\n}`);
  assert.equal(f.length, 1); assert.match(f[0].id, /^remote-code-eval:/);
  assert.deepEqual(ids(`const code = localScript(); eval(code);`), []);
  assert.deepEqual(ids(`async function f(){const response = await fetch(url); eval(response);}`), []);
});

test('SQL: traced external input affects query text, parameters and numeric conversion do not', () => {
  for (const query of ["'SELECT * FROM notes WHERE id = ' + route.params.id", '`SELECT * FROM notes WHERE id = ${route.params.id}`']) {
    const f = js(sqlite + `function read(route){ const sql = ${query}; db.getAllAsync(sql); }`);
    assert.equal(f.length, 1); assert.match(f[0].id, /^sqlite-input-query:/);
  }
  for (const code of [
    `db.getAllAsync('SELECT * FROM notes WHERE id = ?', route.params.id);`,
    `db.execAsync('PRAGMA user_version = ' + DATABASE_VERSION);`,
    `db.getAllAsync('SELECT * FROM notes WHERE id = ' + Number(route.params.id));`,
    `db.getAllAsync('SELECT * FROM notes WHERE id = ' + safeSql(route.params.id));`,
  ]) assert.deepEqual(ids(sqlite + code), [], code);
});

test('OAuth: only a used configuration with explicit PKCE off or implicit tokens', () => {
  assert.equal(ids(auth + `const config = {clientId:'public', usePKCE:false}; useAuthRequest(config);`)[0], 'oauth-pkce-disabled');
  assert.equal(ids(auth + `useAuthRequest({responseType: 'token'});`)[0], 'oauth-implicit-flow');
  for (const code of [
    `useAuthRequest({clientId:'public'});`, `useAuthRequest({usePKCE:true});`,
    `const unused = {usePKCE:false};`, `useAuthRequest({usePKCE:false, responseType: mode});`,
    `useAuthRequest({usePKCE:false, ...overrides});`,
    `useAuthRequest({usePKCE:false, usePKCE:true});`,
    `const text = 'usePKCE: false';`,
  ]) assert.deepEqual(ids(auth + code), [], code);
  assert.deepEqual(ids(`useAuthRequest({usePKCE:false});`), []);
});
const manifest = resource => `<manifest><application><provider android:name="androidx.core.content.FileProvider" android:exported="false"><meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/${resource}" /></provider></application></manifest>`;
test('FileProvider: require a manifest reference and broad configured path, explain grant prerequisite', () => {
  const r = scan({ 'android/app/src/main/AndroidManifest.xml': manifest('paths'), 'android/app/src/main/res/xml/paths.xml': '<paths>\n<root-path name="root" path="." />\n</paths>' });
  assert.equal(r.findings.length, 1); const f = r.findings[0];
  assert.equal(f.evidence[0].line, 2); assert.equal(f.severity, 'medium'); assert.match(f.attack.prerequisite, /URI grant/);
  for (const config of ['<paths><files-path path="shared/photos/" name="p" /></paths>', '<paths><!-- <root-path name="r" path="." /> --></paths>']) assert.equal(scan({ 'android/app/src/main/AndroidManifest.xml': manifest('paths'), 'android/app/src/main/res/xml/paths.xml': config }).findings.length, 0);
  assert.equal(scan({ 'android/app/src/main/res/xml/unreferenced.xml': '<paths><root-path name="r" path="." /></paths>' }).findings.length, 0);
});

test('coverage: skipped oversized and test files never masquerade as a clean full audit', () => {
  const r = scan({ 'src/huge.ts': ' '.repeat(512 * 1024 + 1), 'test/sample.ts': sentry + 'Sentry.captureMessage(accessToken);', 'src/app.ts': '// safe' });
  assert.equal(r.coverage.skipped.oversized, 1); assert.equal(r.coverage.filesRead, 1); assert.equal(r.findings.length, 0);
  assert.equal(r.coverage.rules.length, 10); assert.match(r.coverage.limits.join(' '), /Backend authorization/);
});

test('TextInput setter is linked to the SQL value; ordinary state and bound parameters are excluded', () => {
  const base = sqlite + `import {TextInput} from 'react-native'; import {useState} from 'react';\n`;
  const f = js(base + `function Search(){ const [query, setQuery] = useState(''); db.getAllAsync('SELECT * FROM notes WHERE text = ' + query); return <TextInput onChangeText={setQuery}/>; }`);
  assert.equal(f.length, 1); assert.match(f[0].id, /^sqlite-input-query:/);
  assert.deepEqual(ids(base + `function Search(){ const [query, setQuery] = useState(''); db.getAllAsync('SELECT * FROM notes WHERE text = ?', query); return <TextInput onChangeText={setQuery}/>; }`), []);
});

test('public map API tokens, server code and web variants are outside these mobile credential findings', () => {
  assert.deepEqual(ids('fetch(`https://api.mapbox.com/geocoding/v5/x?access_token=${mapboxgl.accessToken}`)'), []);
  const r = scan({ 'backend/auth.ts': `fetch('https://x/?token=' + accessToken);`, 'supabase/functions/login/index.ts': `fetch('https://x/?token=' + accessToken);`, 'app.web.tsx': `fetch('https://x/?token=' + accessToken);` });
  assert.equal(r.findings.length, 0);
});

test('nested templates, quoted call text and oversized syntax do not crash or manufacture findings', () => {
  assert.equal(ids('fetch(`https://x/?token=${`${session.accessToken}`}`)')[0], 'credential-url');
  assert.deepEqual(ids('const x = `fetch("https://x/?token=" + accessToken)`;'), []);
  const nested = '`x${'.repeat(70) + '1' + '}`'.repeat(70);
  const r = scan({ 'app.ts': 'const x = ' + nested + '; eval(x);' });
  assert.equal(r.coverage.skipped.syntax, 1); assert.deepEqual(r.findings, []);
});

test('FileProvider cache/external-only sharing is not treated as private-root exposure', () => {
  const r = scan({ 'android/app/src/main/AndroidManifest.xml': manifest('paths'), 'android/app/src/main/res/xml/paths.xml': '<paths><cache-path name="r" path="." /><external-path name="e" path="." /></paths>' });
  assert.equal(r.findings.length, 0);
});

test('map API exclusion does not hide a password or wallet private key in its URL', () => {
  assert.equal(ids('fetch(`https://api.mapbox.com/x?password=${password}`)')[0], 'credential-url');
  assert.equal(ids('fetch(`https://api.mapbox.com/x?key=${privateKey}`)')[0], 'credential-url');
});

import { analyze } from '../src/analyze.js';
import { loadProject } from '../src/project.js';
import { securityOnly } from '../src/security-review.js';
import { textReport } from '../src/report-text.js';
import { htmlReport } from '../src/report-html.js';
import { markdownReport } from '../src/report-md.js';
import { sarifReport } from '../src/report-sarif.js';
import { handle } from '../src/mcp.js';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

test('security command, reports and MCP retain evidence, prerequisites and coverage without upgrade noise', async () => {
  const root = makeProject({ 'package.json': { name: 'security-demo', dependencies: { 'react-native': '0.80.0' } }, 'app.tsx': sentry + `function report(session){ Sentry.setContext('x', { value: session.accessToken }); }` });
  try {
    const result = securityOnly(await analyze(loadProject(root), { offline: true, get: async () => null }));
    const finding = result.findings.find(f => f.id.startsWith('credential-telemetry'));
    assert.ok(finding); assert.equal(finding.masvs, 'STORAGE');
    assert.ok(result.findings.every(f => f.masvs || ['security', 'secret'].includes(f.area)));
    for (const report of [textReport(result, { color: false }), htmlReport(result), markdownReport(result)]) {
      assert.match(report, /security report/); assert.match(report, /Verify:/); assert.match(report, /not (?:a )?(?:proof|compliance)|not prove/);
      assert.ok(!report.includes('no issues')); assert.ok(!report.includes('groups checked'));
    }
    const sarif = sarifReport(result).runs[0].results.find(f => f.ruleId === 'credential-telemetry');
    assert.equal(sarif.locations[0].physicalLocation.artifactLocation.uri, 'app.tsx');
    assert.equal(sarif.locations[0].physicalLocation.region.startLine, 2);
    const response = await handle({ jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'security_audit', arguments:{path:root,offline:true}} }, {roots:[fs.realpathSync(root)],version:'test'});
    const content = response.result.structuredContent;
    assert.ok(content.findings.find(f => f.id.startsWith('credential-telemetry')).attack.validation);
    assert.equal(content.securityReview.flowCoverage.rules.length, 10);
    const cli = spawnSync(process.execPath, ['bin/nativekeel.js','security',root,'--offline','--json','--fail-on','high'], {encoding:'utf8'});
    assert.equal(cli.status, 1, cli.stderr); assert.equal(JSON.parse(cli.stdout).focus, 'security');
  } finally { fs.rmSync(root, {recursive:true}); }
});

test('security review with no matches explicitly leaves backend/runtime risks unverified', () => {
  const r = securityOnly({ findings:[], security:{AUTH:0}, offline:true });
  assert.match(r.securityReview.verdict, /not proof/);
  assert.match(r.securityReview.limitations.join(' '), /account A versus B/);
  assert.match(r.securityReview.limitations.join(' '), /advisory/);
});

test('local canary: page data evaluated as code changes app state; JSON parsing does not execute it', () => {
  // Only our synthetic literal is executed, never corpus/project source.
  const sandbox = { event: {nativeEvent:{data:'globalThis.canary = 73'}}, canary:0 };
  vm.runInNewContext('eval(event.nativeEvent.data)', sandbox, {timeout:100});
  assert.equal(sandbox.canary, 73);
  const safe = {event:{nativeEvent:{data:'{"message":"globalThis.canary = 73"}'}},canary:0};
  vm.runInNewContext('JSON.parse(event.nativeEvent.data)', safe, {timeout:100});
  assert.equal(safe.canary, 0);
});

test('shadowed eval and telemetry imports are not assumed to retain their library semantics', () => {
  assert.deepEqual(ids(webview + `function eval(x){ return x; } const onMessage = e => eval(e.nativeEvent.data);`), []);
  assert.deepEqual(ids(sentry + `function f(Sentry){ Sentry.setContext('x', accessToken); }`), []);
  assert.deepEqual(ids(sentry + `const Sentry = localLogger; Sentry.captureMessage(accessToken);`), []);
});

test('security overview caps finding references while retaining complete counts', () => {
  const findings = Array.from({length:200},(_,i)=>({id:`credential-url:app.ts:${i}`,area:'security',severity:'medium'}));
  const r=securityOnly({findings,security:{},offline:true});
  const group=r.securityReview.risks['Credentials and private data'];
  assert.equal(group.count,200);assert.equal(group.findings.length,5);
});

test('biometric prompt trusted as a yes/no is reported unless a secret is bound to biometrics in JS or native code', () => {
  const prompt = "import * as LocalAuthentication from 'expo-local-authentication';\n// LocalAuthentication.authenticateAsync() in a comment\nexport async function unlock() {\n  const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock' });\n  return r.success;\n}\n";
  const only = scan({ 'src/lock.ts': prompt }).findings.find((f) => f.id === 'biometric-prompt-only');
  assert.ok(only);
  assert.deepEqual(only.evidence, [{ file: 'src/lock.ts', line: 4 }]);
  assert.match(only.attack.prerequisite, /Physical access/);
  const boundJs = scan({ 'src/lock.ts': prompt, 'src/secret.ts': "import * as SecureStore from 'expo-secure-store';\nSecureStore.setItemAsync('k', v, { requireAuthentication: true });" }).findings;
  assert.equal(boundJs.some((f) => f.id === 'biometric-prompt-only'), false);
  const boundNative = scan({ 'src/lock.ts': prompt, 'ios/App/Vault.swift': 'let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .biometryCurrentSet, nil)' }).findings;
  assert.equal(boundNative.some((f) => f.id === 'biometric-prompt-only'), false);
  assert.equal(ids("import TouchID from 'react-native-touch-id';\n// TouchID.authenticate('x')\n").includes('biometric-prompt-only'), false);
});

test('iOS file sharing with an unencrypted store in Documents is reported; encrypted, relocated or unshared stores are not', () => {
  const plist = (inPlace) => `<plist><dict><key>UIFileSharingEnabled</key>\n<true/>${inPlace ? '<key>LSSupportsOpeningDocumentsInPlace</key><true/>' : ''}</dict></plist>`;
  const mmkv = "import { createMMKV } from 'react-native-mmkv';\nexport const storage = createMMKV();\n";
  const hit = scan({ 'ios/App/Info.plist': plist(true), 'ios/App/DevInfo.plist': plist(false), 'src/storage.ts': mmkv }).findings.find((f) => f.id.startsWith('ios-file-sharing-data'));
  assert.ok(hit);
  assert.equal(hit.id, 'ios-file-sharing-data:ios/App/Info.plist');
  assert.match(hit.detail, /Files app/);
  assert.deepEqual(hit.evidence[1], { file: 'src/storage.ts', line: 2 });
  const none = (files) => scan(files).findings.some((f) => f.id.startsWith('ios-file-sharing-data'));
  assert.equal(none({ 'ios/App/Info.plist': plist(true), 'src/storage.ts': "import { createMMKV } from 'react-native-mmkv';\nexport const s = createMMKV({ id: 'x', encryptionKey: key });" }), false);
  assert.equal(none({ 'ios/App/Info.plist': '<plist><dict></dict></plist>', 'src/storage.ts': mmkv }), false);
  assert.equal(none({ 'app.json': '{"expo":{"ios":{"infoPlist":{"UIFileSharingEnabled":true}}}}', 'src/db.ts': "import { openDatabaseSync } from 'expo-sqlite';\nconst db = openDatabaseSync('a.db', undefined, dir);" }), false);
  assert.equal(none({ 'app.json': '{"expo":{"ios":{"infoPlist":{"UIFileSharingEnabled":true}}}}', 'src/db.ts': "import { openDatabaseSync } from 'expo-sqlite';\nconst db = openDatabaseSync('a.db');" }), true);
});
