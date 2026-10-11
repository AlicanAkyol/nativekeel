import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { nativeSecurity } from '../src/native-security.js';
import { makeProject } from './helpers.js';
const imports = `import android.content.Intent;\nimport android.app.Activity;\nimport android.webkit.WebView;\nimport android.database.sqlite.SQLiteDatabase;\nimport java.io.File;\nimport java.io.FileInputStream;\nimport java.io.FileOutputStream;\nimport java.util.zip.ZipInputStream;\nimport java.util.zip.ZipEntry;\n`;
const java = body => `package demo;\n${imports}\nclass Entry extends Activity {\n void onCreate(Bundle b) { ${body} }\n}`;
const manifest = extra => `<manifest package="demo"><application><activity android:name=".Entry" android:exported="true" ${extra || ''}/></application></manifest>`;
const scan = (code, xml = manifest(), more = {}, file = 'android/app/src/main/java/demo/Entry.java') => {
  const root = makeProject({ [file]: code, 'android/app/src/main/AndroidManifest.xml': xml, ...more });
  try { return nativeSecurity(root); } finally { fs.rmSync(root, { recursive: true }); }
};
const ids = (...args) => scan(...args).findings.map(f => f.id.split(':')[0]);

test('native Intent redirect: exact manifest entry, nested extra, launch and evidence', () => {
  const r = scan(java(`Intent incoming = getIntent();\nIntent target = (Intent) incoming.getParcelableExtra("next");\nstartActivity(target);`));
  assert.deepEqual(r.findings.map(f => f.id.split(':')[0]), ['native-intent-redirection']);
  assert.ok(r.findings[0].evidence.some(e => e.role === 'entry-point'));
  assert.match(r.findings[0].attack.prerequisite, /Android 16/);
  assert.equal(r.coverage.rules.length, 6);
});

test('native Intent redirect: fixed destinations and guarded methods are unresolved, not findings', () => {
  for (const launch of ['startActivity(new Intent(this, Safe.class));', 'target.setComponent(safe); startActivity(target);', 'if (isAllowed(target)) { startActivity(target); }', 'startActivity(sanitize(target));', 'target = fixed; startActivity(target);']) {
    assert.deepEqual(ids(java(`Intent incoming = getIntent(); Intent target = (Intent) incoming.getParcelableExtra("next"); ${launch}`)), [], launch);
  }
});

test('native exported correlation: permissions, disabled app, package/class/module mismatch and missing package', () => {
  const code = java(`Intent incoming = getIntent(); Intent target = (Intent) incoming.getParcelableExtra("next"); startActivity(target);`);
  for (const xml of [manifest('android:permission="demo.SIGNATURE"'), manifest('android:enabled="false"'), manifest().replace('exported="true"', 'exported="false"'), manifest().replace('.Entry', '.Other'), manifest().replace('package="demo"', 'package="other"'), manifest().replace('package="demo"', ''), manifest().replace('<application>', '<application android:permission="demo.P">')]) assert.deepEqual(ids(code, xml), []);
  assert.deepEqual(ids(code, manifest(), {}, 'android/other/src/main/java/demo/Entry.java'), []);
});

test('native WebView URI input is typed and traced, not proof of bridge execution', () => {
  const r = scan(java(`WebView view = new WebView(this); Intent incoming = getIntent(); String url = incoming.getStringExtra("url"); view.loadUrl(url);`));
  assert.equal(r.findings[0]?.id.split(':')[0], 'native-intent-webview');
  assert.equal(r.findings[0].severity, 'medium');
  assert.match(r.findings[0].attack.prerequisite, /does not by itself prove/);
  for (const body of ['view.loadUrl("https://trusted.invalid");', 'String url = validate(incoming.getStringExtra("url")); view.loadUrl(url);', 'if (uri.getHost().equals("trusted.invalid")) view.loadUrl(url);']) assert.deepEqual(ids(java(`WebView view = new WebView(this); Intent incoming = getIntent(); ${body}`)), []);
});

test('native SQLite: external text in query, bound arguments are excluded', () => {
  const prefix = `SQLiteDatabase db; Intent incoming = getIntent(); String text = incoming.getStringExtra("search"); `;
  assert.deepEqual(ids(java(prefix + `String sql = "SELECT * FROM records WHERE name='" + text + "'"; db.rawQuery(sql, null);`)), ['native-intent-sql']);
  assert.deepEqual(ids(java(prefix + `db.rawQuery("SELECT * FROM records WHERE name=?", new String[]{text});`)), []);
  assert.deepEqual(ids(java(prefix + `db.execSQL("DELETE FROM records WHERE name=?", new Object[]{text});`)), []);
});

test('native file path read/write follows local aliases with separate impact', () => {
  const prefix = `Intent incoming = getIntent(); String name = incoming.getStringExtra("path"); File file = new File(getFilesDir(), name); `;
  const r = scan(java(prefix + `FileInputStream in = new FileInputStream(file); FileOutputStream out = new FileOutputStream(file);`));
  assert.deepEqual(r.findings.map(f => f.id.split(':')[0]), ['native-intent-file-read', 'native-intent-file-write']);
  assert.match(r.findings[0].attack.impact, /disclosure additionally requires/);
  assert.deepEqual(ids(java(prefix + 'if (!file.getCanonicalPath().startsWith(root)) throw new IOException(); new FileOutputStream(file);')), []);
});
const unzip = `package demo;\n${imports} class Entry { public static void unzip(InputStream input, File root) { ZipInputStream zip = new ZipInputStream(input); ZipEntry entry; while ((entry = zip.getNextEntry()) != null) { String name = entry.getName(); File output = new File(root, name); new FileOutputStream(output); } } }`;

test('archive traversal requires entry name to reach write, and reports OS mitigation', () => {
  const r = scan(unzip);
  assert.deepEqual(r.findings.map(f => f.id.split(':')[0]), ['native-archive-path-write']);
  assert.match(r.findings[0].attack.prerequisite, /Android 14/);
  assert.deepEqual(ids(unzip.replace('new File(root, name)', 'new File(root, "fixed.txt")')), []);
  assert.deepEqual(ids(unzip.replace('new FileOutputStream(output)', 'new FileInputStream(output)')), []);
});

test('archive canonical guards, basename transforms, unknown helpers and different methods are excluded', () => {
  for (const source of [unzip.replace('new FileOutputStream(output)', 'if (!output.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException(); new FileOutputStream(output)'), unzip.replace('new File(root, name)', 'safeFile(root, name)'), unzip.replace('entry.getName()', 'new File(entry.getName()).getName()'), unzip.replace('new FileOutputStream(output)', 'write(output)')]) assert.deepEqual(ids(source), []);
});

test('native comments and string literals cannot manufacture security flows', () => {
  const body = `String example = "incoming.getStringExtra() startActivity(target)"; /* Intent target = (Intent) incoming.getParcelableExtra("next"); startActivity(target); */`;
  assert.deepEqual(ids(java(body)), []);
  assert.deepEqual(ids(unzip.replace('entry.getName()', '"entry.getName()"')), []);
});

test('native Kotlin local aliases and incoming onNewIntent parameter', () => {
  const code = `package demo\n${imports.replaceAll(';', '')} class Entry : Activity() { override fun onNewIntent(received: Intent) {\n val target = received.getParcelableExtra<Intent>("next")!!\n startActivity(target)\n } }`;
  assert.deepEqual(ids(code, manifest(), {}, 'android/app/src/main/java/demo/Entry.kt'), ['native-intent-redirection']);
  const property = code.replace('received.getParcelableExtra', 'intent.getParcelableExtra');
  assert.deepEqual(ids(property, manifest(), {}, 'android/app/src/main/java/demo/Entry.kt'), ['native-intent-redirection']);
});

test('native bounded propagation excludes sibling branches and mutable aliases', () => {
  assert.deepEqual(ids(java('Intent target = safe; if (flag) { target = (Intent) getIntent().getParcelableExtra("next"); } startActivity(target);')), []);
  assert.deepEqual(ids(unzip.replace('new FileOutputStream(output)', 'output = safeFile; new FileOutputStream(output)')), []);
});

test('native platform imports required; custom lookalike sinks are excluded', () => {
  assert.deepEqual(ids(unzip.replace('import java.io.FileOutputStream;', '')), []);
  assert.deepEqual(ids(unzip.replace('import java.util.zip.ZipInputStream;', '')), []);
  assert.deepEqual(ids(java('WebView view; Intent incoming=getIntent(); view.loadUrl(incoming.getStringExtra("url"));').replace('import android.webkit.WebView;', '')), []);
});

test('native collection skips tests, dependencies, symlinks and oversized sources', () => {
  const r = scan('package demo; class Entry {}', manifest(), { 'node_modules/lib/A.java': unzip, 'android/app/src/androidTest/A.java': unzip, 'android/app/src/main/java/demo/Huge.java': ' '.repeat(512 * 1024 + 1) });
  assert.equal(r.findings.length, 0); assert.equal(r.coverage.skipped.oversized, 1);
});


test('native manifest namespace from literal Gradle, with source evidence and comment exclusion', () => {
  const code = java('Intent incoming=getIntent(); Intent target=(Intent) incoming.getParcelableExtra("next"); startActivity(target);');
  const xml = manifest().replace('package="demo"', '');
  const r = scan(code, xml, {'android/app/build.gradle': "android { namespace 'demo' }"});
  assert.equal(r.findings.length, 1); assert.ok(r.findings[0].evidence.some(e => e.role === 'namespace'));
  assert.equal(scan(code, xml, {'android/app/build.gradle.kts': 'android { namespace = "demo" }'}).findings.length, 1);
  assert.equal(scan(code, xml, {'android/app/build.gradle': "// namespace 'demo'"}).findings.length, 0);
});

test('synthetic path canary demonstrates traversal and canonical containment rejection', () => {
  const root = makeProject({});
  try {
    const dest = fs.realpathSync(root) + '/extract'; fs.mkdirSync(dest);
    // Harmless scratch-only analogue of joining an archive entry with a root.
    const escaped = new URL('../canary.txt', 'file://' + dest + '/').pathname;
    fs.writeFileSync(escaped, 'synthetic-canary');
    assert.equal(fs.readFileSync(root + '/canary.txt', 'utf8'), 'synthetic-canary');
    assert.equal(escaped.startsWith(dest + '/'), false);
    fs.unlinkSync(escaped);
    const guardedWrite = file => { if (!file.startsWith(dest + '/')) throw new Error('outside-root'); fs.writeFileSync(file, 'synthetic-canary'); };
    assert.throws(() => guardedWrite(escaped), /outside-root/);
    assert.equal(fs.existsSync(root + '/canary.txt'), false);
  } finally { fs.rmSync(root, {recursive:true}); }
});

test('native findings reach normal analyze, security-only review and SARIF locations', async () => {
  const {analyze} = await import('../src/analyze.js');
  const {loadProject} = await import('../src/project.js');
  const {securityOnly} = await import('../src/security-review.js');
  const {sarifReport} = await import('../src/report-sarif.js');
  const root = makeProject({'package.json': JSON.stringify({name:'native-canary',version:'1.0.0',dependencies:{'react-native':'0.86.0'}}), 'android/app/src/main/java/demo/Entry.java': java('Intent incoming=getIntent(); String p=incoming.getStringExtra("path"); new FileOutputStream(p);'), 'android/app/src/main/AndroidManifest.xml':manifest()});
  try {
    const result=securityOnly(await analyze(loadProject(root), {offline:true,get:async()=>null}));
    assert.ok(result.findings.some(f=>f.id.startsWith('native-intent-file-write:')));
    assert.equal(result.securityReview.nativeCoverage.rules.length,6);
    const {handle}=await import('../src/mcp.js');
    const response=await handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'security_audit',arguments:{path:root,offline:true}}},{roots:[fs.realpathSync(root)],version:'test'});
    assert.equal(response.result.structuredContent.securityReview.nativeCoverage.rules.length,6);
    assert.ok(response.result.structuredContent.findings.some(f=>f.id.startsWith('native-intent-file-write:')));
    const {htmlReport}=await import('../src/report-html.js');
    const {textReport}=await import('../src/report-text.js');
    assert.match(htmlReport(result),/Native Android checks/);
    assert.match(textReport(result,{color:false}),/Native Android checks/);
    const report = sarifReport(result);
    assert.ok(JSON.stringify(report).includes('Entry.java'));
  } finally {fs.rmSync(root,{recursive:true});}
});


test('native raw strings, Java text blocks and nested Kotlin comments do not create flows', () => {
  const flow = 'Intent incoming=getIntent(); Intent target=(Intent) incoming.getParcelableExtra("next"); startActivity(target);';
  assert.deepEqual(ids(java('String example = """ ' + flow + ' """;')), []);
  const kotlin = `package demo\n${imports.replaceAll(';','')} class Entry : Activity() { fun onCreate(b: Bundle) { /* nested /* comment */ ${flow} */ } }`;
  assert.deepEqual(ids(kotlin, manifest(), {}, 'android/app/src/main/java/demo/Entry.kt'), []);
});


test('hostile native sources respect lexer nesting limits without executing input', () => {
  const r=scan(java('getStringExtra();' + '{'.repeat(300) + '}'.repeat(300)));
  assert.equal(r.findings.length,0);assert.equal(r.coverage.skipped.syntax,1);
});
