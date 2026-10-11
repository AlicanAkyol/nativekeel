import { lex, split, values, calls, sourceFiles } from './security-source.js';

export const NATIVE_SECURITY_RULES = ['native-archive-path-write', 'native-intent-redirection', 'native-intent-webview', 'native-intent-sql', 'native-intent-file-read', 'native-intent-file-write'];
const docs = 'https://developer.android.com/privacy-and-security/risks/';
const cleanXml = text => text.replace(/<!--[\s\S]*?-->/g, s => s.replace(/[^\n]/g, ' '));
const attrs = text => Object.fromEntries([...text.matchAll(/([\w:.-]+)\s*=\s*(['"])(.*?)\2/g)].map(m => [m[1], m[3]]));
const last = name => name.split('.').at(-1);
const ancestor = (a, b) => a === b || b.startsWith(a + '/');
function nativeTokens(text, kotlin = false) {
  // Java text blocks / Kotlin raw strings and nested Kotlin comments must not create calls.
  const chars = text.split(''); let i = 0;
  const erase = (start, end) => { for (let n = start; n < end; n++) if (chars[n] !== '\n' && chars[n] !== '\r') chars[n] = ' '; };
  while (i < text.length) {
    if (text.startsWith('"""', i)) { const start = i, end = text.indexOf('"""', i + 3); i = end < 0 ? text.length : end + 3; erase(start, i); }
    else if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i++; }
    else if (text.startsWith('/*', i)) {
      const start = i; i += 2; let depth = 1;
      while (i < text.length && depth) { if (kotlin && text.startsWith('/*', i)) { depth++; i += 2; } else if (text.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      erase(start, i);
    } else if (['"', "'"].includes(text[i])) { const quote = text[i++]; while (i < text.length) { if (text[i] === '\\') i += 2; else if (text[i++] === quote) break; } }
    else i++;
  }
  return lex(chars.join(''));
}
function exported(files) {
  const result = [];
  for (const f of files.filter(f => /(?:^|\/)src\/(?:main|release)\/AndroidManifest\.xml$/.test(f.file))) {
    const text = cleanXml(f.text); let pkg = attrs(text.match(/<manifest\b([^>]+)>/)?.[1] || '').package;
    let namespaceEvidence;
    if (!pkg) {
      const module = f.file.slice(0, f.file.indexOf('/src/'));
      const gradle = files.find(g => g.file === module + '/build.gradle' || g.file === module + '/build.gradle.kts');
      if (gradle) {
        const ts = nativeTokens(gradle.text, gradle.file.endsWith('.kts')), names = ts.filter(t => t.kind === 'id' && t.value === 'namespace').map(t => ({ t, value: ts[t.index + (ts[t.index + 1]?.value === '=' ? 2 : 1)] })).filter(x => x.value?.kind === 'string' && /^[\w.]+$/.test(x.value.value));
        if (names.length === 1) { pkg = names[0].value.value; namespaceEvidence = { file: gradle.file, line: names[0].t.line, role: 'namespace' }; }
      }
    }
    const app = attrs(text.match(/<application\b([^>]+)>/)?.[1] || '');
    if (app['android:enabled'] === 'false' || app['android:permission']) continue;
    for (const m of text.matchAll(/<(activity|service|receiver)\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/\1\s*>)/g)) {
      const a = attrs(m[2]);
      // Do not guess manifest merger defaults, implicit export, resource permissions or aliases.
      if (a['android:exported'] !== 'true' || a['android:enabled'] === 'false' || a['android:permission'] || !a['android:name']) continue;
      const name = a['android:name'];
      const fq = name.startsWith('.') ? pkg && pkg + name : name.includes('.') ? name : pkg && pkg + '.' + name;
      result.push({ fq, name, file: f.file, line: text.slice(0, m.index).split('\n').length, namespaceEvidence, prefix: f.file.slice(0, f.file.indexOf('/src/') + 5) });
    }
  }
  return result;
}
function methods(tokens) {
  const out = [], controls = new Set(['if', 'while', 'for', 'switch', 'catch', 'when', 'synchronized']);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== '(' || tokens[i].kind !== 'punct' || tokens[i].match === undefined || tokens[i - 1]?.kind !== 'id' || controls.has(tokens[i - 1].value)) continue;
    const end = tokens[i].match; let b = end + 1;
    // Java throws / Kotlin return type; bounded to the next opening body.
    while (b < Math.min(end + 18, tokens.length) && !['{', ';', '=', ')', '}'].includes(tokens[b].value)) b++;
    if (tokens[b]?.value !== '{' || tokens[b].match === undefined) continue;
    const header = tokens.slice(Math.max(0, i - 8), i);
    if (!header.some(t => ['fun', 'void', 'String', 'boolean', 'File', 'Intent'].includes(t.value)) && !header.some(t => ['public', 'private', 'protected', 'static'].includes(t.value))) continue;
    out.push({ name: tokens[i - 1].value, params: tokens.slice(i + 1, end), body: tokens.slice(b + 1, tokens[b].match), block: [...tokens[b].block.split('/').filter(Boolean), String(b)].join('/') });
    i = tokens[b].match;
  }
  return out;
}
function assignments(tokens) {
  const out = [];
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].value !== '=' || tokens[i - 1].kind !== 'id' || ['.', '?.'].includes(tokens[i - 2]?.value)) continue;
    const name = tokens[i - 1]; let end = i + 1;
    while (end < tokens.length) {
      const t = tokens[end];
      if ([';', ',', ')', '}', '{'].includes(t.value) && t.kind === 'punct') break;
      if (end > i + 1 && t.line > tokens[end - 1].line && !['.', '?.', '+'].includes(t.value) && !['=', '+', '.'].includes(tokens[end - 1].value)) break;
      if (t.match !== undefined && t.match > t.index) { const n = tokens.findIndex(x => x.index === t.match); if (n < 0) break; end = n + 1; } else end++;
    }
    out.push({ name: name.value, token: name, expr: tokens.slice(i + 1, end) });
  }
  return out;
}
function unwrap(expr) {
  if (expr[0]?.value === 'new') expr = expr.slice(1);
  if (expr[0]?.value === '(' && expr[0].match === expr.at(-1)?.index) return unwrap(expr.slice(1, -1));
  // Supported Java casts only; unknown calls/conversions are not treated as identity.
  if (expr[0]?.value === '(' && ['Intent', 'String'].includes(expr[1]?.value) && expr[2]?.value === ')') return unwrap(expr.slice(3));
  return expr;
}
function resolved(expr, ctx, before, depth = 0) {
  if (!expr?.length || depth > 10) return expr || [];
  expr = unwrap(expr);
  if (expr.length !== 1 || expr[0].kind !== 'id') return expr;
  const d = ctx.defs.filter(d => d.name === expr[0].value && d.token.index < before.index && ancestor(d.token.block, before.block)).at(-1);
  return d ? resolved(d.expr, ctx, d.token, depth + 1) : expr;
}
function trace(expr, ctx, before, depth = 0) {
  if (!expr?.length || depth > 10) return [];
  expr = unwrap(expr);
  while (expr.at(-1)?.value === '!') expr = expr.slice(0, -1);
  // Exact Kotlin Intent generic only, retaining original token indices for call matching.
  expr = expr.filter((t, i, a) => !(t.value === '<' && a[i - 1]?.value === 'getParcelableExtra' && a[i + 1]?.value === 'Intent' && a[i + 2]?.value === '>') && !(t.value === 'Intent' && a[i - 1]?.value === '<' && a[i - 2]?.value === 'getParcelableExtra' && a[i + 1]?.value === '>') && !(t.value === '>' && a[i - 1]?.value === 'Intent' && a[i - 2]?.value === '<' && a[i - 3]?.value === 'getParcelableExtra'));
  if (expr.length === 1 && expr[0].kind === 'id') {
    const defs = ctx.defs.filter(d => d.name === expr[0].value && d.token.index < before.index && ancestor(d.token.block, before.block));
    const d = defs.at(-1);
    if (d) {
      // Sibling branch assignments, compound mutations and ambiguous shadowing stop propagation.
      if (ctx.tokens.some((t, i) => t.index > d.token.index && t.index < before.index && t.value === d.name && ['=', '+=', '-=', '++', '--'].includes(ctx.tokens[i + 1]?.value) && t.index !== d.token.index)) return [];
      return trace(d.expr, ctx, d.token, depth + 1);
    }
    if ((expr[0].value === 'intent' && ctx.activity) || ctx.incoming.has(expr[0].value)) return [{ kind: 'intent', line: expr[0].line }];
    return [];
  }
  const plus = split(expr, '+');
  if (plus.length > 1) return plus.flatMap(e => trace(e, ctx, before, depth + 1));
  const name = values(expr);
  if (name === 'intent' && ctx.activity && !ctx.defs.some(d => d.name === 'intent' && d.token.index < before.index)) return [{ kind: 'intent', line: expr[0].line }];
  if (/^[\w$]+\.(?:name|nextEntry)$/.test(name)) {
    const receiver = expr.slice(0, 1), prop = last(name);
    if (prop === 'nextEntry' && ctx.typed(receiver[0].value, /^(?:ZipInputStream|TarArchiveInputStream)$/)) return [{ kind: 'entry', line: expr[0].line }];
    if (prop === 'name' && trace(receiver, ctx, before, depth + 1).some(t => t.kind === 'entry')) return [{ kind: 'archive', line: expr[0].line }];
  }
  const c = calls(expr).find(c => c.token.index === expr[0]?.index && c.open.match === expr.at(-1)?.index);
  if (!c) return [];
  const receiver = expr.slice(0, 1), method = last(c.name);
  if (c.name === 'getIntent' && ctx.activity) return [{ kind: 'intent', line: c.token.line }];
  if (/^[\w$]+\.(?:getNextEntry|getNextTarEntry)$/.test(c.name) && ctx.typed(receiver[0].value, /^(?:ZipInputStream|TarArchiveInputStream)$/)) return [{ kind: 'entry', line: c.token.line }];
  const input = trace(receiver, ctx, before, depth + 1);
  if (method === 'getName' && input.some(t => t.kind === 'entry')) return [{ kind: 'archive', line: c.token.line }];
  if (['getStringExtra', 'getDataString'].includes(method) && input.some(t => t.kind === 'intent')) return [{ kind: 'external', line: c.token.line }];
  if (method === 'getParcelableExtra' && input.some(t => t.kind === 'intent')) return [{ kind: 'nested', line: c.token.line }];
  if (c.name === 'Intent.parseUri' && trace(c.args[0], ctx, before, depth + 1).some(t => t.kind === 'external')) return [{ kind: 'nested', line: c.token.line }];
  if (c.name === 'File' && ctx.typed('File', /^File$/)) return c.args.flatMap(e => trace(e, ctx, before, depth + 1)).filter(t => ['archive', 'external'].includes(t.kind));
  return [];
}
function finding(rule, file, call, input, manifest, data) {
  return { id: `${rule}:${file}:${call.token.line}`, severity: data.severity || 'high', area: 'security', confidence: 'medium', masvs: data.masvs,
    title: `${data.title} (${file}:${call.token.line})`,
    evidence: [{ file, line: call.token.line, role: 'sink' }, ...input.map(t => ({ file, line: t.line, role: 'source' })), ...(manifest ? [{ file: manifest.file, line: manifest.line, role: 'entry-point' }, ...(manifest.namespaceEvidence ? [manifest.namespaceEvidence] : [])] : [])].filter((v, i, a) => a.findIndex(x => x.file === v.file && x.line === v.line && x.role === v.role) === i),
    attack: { impact: data.impact, prerequisite: data.prerequisite, validation: data.validation, evidenceType: 'static-source' },
    detail: `${data.impact} ${data.prerequisite} Static source candidate: merged manifests, callers, OS protections and runtime reachability require verification. Source: ${docs}${data.doc}`,
    fix: { kind: 'security', file, line: call.token.line, step: data.fix } };
}
export function nativeSecurity(root) {
  const { files, skipped } = sourceFiles(root, /\.(?:java|kt|xml|gradle|gradle\.kts)$/);
  const entries = exported(files), findings = []; let guarded = 0, methodsRead = 0, candidateFiles = 0, matchedEntryPoints = 0;
  skipped.syntax = 0;
  for (const f of files.filter(f => /\.(?:java|kt)$/.test(f.file))) {
    if (!/getStringExtra|getDataString|getParcelableExtra|getNextEntry|getNextTarEntry|nextEntry/.test(f.text)) continue;
    candidateFiles++;
    try {
      const tokens = nativeTokens(f.text, f.file.endsWith('.kt'));
      const pkgStart = tokens.findIndex(t => t.value === 'package' && t.kind === 'id' && t.block === '');
      let pkg = '';
      for (let i = pkgStart + 1; pkgStart >= 0 && i < tokens.length && (tokens[i].kind === 'id' || tokens[i].value === '.') && tokens[i].line === tokens[pkgStart].line; i++) pkg += tokens[i].value;
      // Correlate an exact single top-level class and manifest module, never filename alone.
      const classes = tokens.filter((t, i) => t.value === 'class' && t.kind === 'id' && t.block === '' && tokens[i + 1]?.kind === 'id').map(t => tokens[t.index + 1].value);
      const fq = classes.length === 1 && pkg ? pkg + '.' + classes[0] : null;
      const manifest = entries.find(e => fq && e.fq === fq && f.file.startsWith(e.prefix));
      if (manifest) matchedEntryPoints++;
      const imported = (type, namespace) => {
        const length = namespace.split('.').length * 2 - 1;
        const at = tokens.findIndex((t, i) => t.value === 'import' && values(tokens.slice(i + 1, i + 1 + length)) === namespace && !['.', 'as'].includes(tokens[i + 1 + length]?.value));
        return at >= 0 && !tokens.some((t, i) => t.value === type && tokens[i + 1]?.value === '(' && ['fun', 'void', 'String', 'class'].includes(tokens[i - 1]?.value));
      };
      const activity = [['Activity', 'android.app.Activity'], ['AppCompatActivity', 'androidx.appcompat.app.AppCompatActivity'], ['ReactActivity', 'com.facebook.react.ReactActivity'], ['FragmentActivity', 'androidx.fragment.app.FragmentActivity']].some(([type, ns]) => imported(type, ns) && tokens.some((t, i) => t.value === type && ['extends', ':'].includes(tokens[i - 1]?.value)));
      const trusted = new Set([['File', 'java.io.File'], ['FileInputStream', 'java.io.FileInputStream'], ['FileOutputStream', 'java.io.FileOutputStream'], ['WebView', 'android.webkit.WebView'], ['SQLiteDatabase', 'android.database.sqlite.SQLiteDatabase'], ['ZipInputStream', 'java.util.zip.ZipInputStream'], ['TarArchiveInputStream', 'org.apache.commons.compress.archivers.tar.TarArchiveInputStream']].filter(([type, ns]) => imported(type, ns)).map(([type]) => type));
      for (const m of methods(tokens)) {
        methodsRead++; const defs = assignments(m.body), types = new Map();
        for (let i = 0; i < tokens.length - 1; i++) {
          const t = tokens[i];
          if ((ancestor(t.block, m.block) || (t.index >= m.body[0]?.index && t.index <= m.body.at(-1)?.index)) && trusted.has(t.value) && tokens[i + 1].kind === 'id') types.set(tokens[i + 1].value, t.value);
        }
        for (const d of defs) { const e = unwrap(d.expr); if (['File', 'WebView', 'ZipInputStream', 'TarArchiveInputStream'].includes(e[0]?.value) && e[1]?.value === '(') types.set(d.name, trusted.has(e[0].value) ? e[0].value : ''); }
        for (let i = 0; i < m.params.length - 2; i++) if (m.params[i + 1].value === ':' && m.params[i].kind === 'id') types.set(m.params[i].value, trusted.has(m.params[i + 2].value) ? m.params[i + 2].value : '');
        const incoming = new Set();
        // Activity incoming property or actual platform callback parameter only.
        if (manifest && activity && m.name === 'onNewIntent') for (let i = 0; i < m.params.length - 1; i++) {
          if (m.params[i].value === 'Intent' && m.params[i + 1].kind === 'id') incoming.add(m.params[i + 1].value);
          if (m.params[i].kind === 'id' && m.params[i + 1].value === ':' && m.params[i + 2]?.value === 'Intent') incoming.add(m.params[i].value);
        }
        const ctx = { tokens: m.body, defs, incoming, activity: !!manifest && activity, typed: (name, re) => re.test((name === 'File' && trusted.has('File') ? 'File' : types.get(name)) || '') };
        const bodyValues = values(m.body);
        // Validators, conditionals and unknown control transfers need a real parser/call graph.
        // Suppression means unreviewed, never that the method is safe.
        const intentGuard = m.body.some(t => t.kind === 'id' && ['if', 'when', 'switch', 'require', 'check', 'return', 'throw'].includes(t.value)) || /IntentSanitizer|resolveActivity|setComponent|setClass|setPackage|\.component=/.test(bodyValues);
        const archiveGuard = /getCanonicalPath|canonicalPath|normalize|toRealPath|startsWith|sanitize|validate|isValid|checkEntry/i.test(bodyValues);
        for (const c of calls(m.body).filter(c => ['FileOutputStream', 'FileInputStream', 'startActivity', 'startService', 'bindService', 'loadUrl', 'rawQuery', 'execSQL'].includes(last(c.name)))) {
          const method = last(c.name), input = trace(c.args[0], ctx, c.token), archive = input.filter(t => t.kind === 'archive'), external = input.filter(t => t.kind === 'external'), nested = input.filter(t => t.kind === 'nested');
          if ((archive.length || (manifest && (external.length || nested.length))) && (archive.length ? archiveGuard : intentGuard)) { guarded++; continue; }
          if (c.name === 'FileOutputStream' && archive.length && trusted.has('FileOutputStream')) findings.push(finding('native-archive-path-write', f.file, c, archive, null, {
            title: 'Archive entry name reaches a file write', masvs: 'STORAGE', doc: 'zip-path-traversal',
            impact: 'A traversal entry can select a file outside the extraction directory and overwrite app-accessible data.',
            prerequisite: 'An attacker must control the archive and reach this extraction path. Android 14+ rejects traversal names in java.util.zip when targetSdk is 34+ unless validation is disabled; older supported devices and TAR parsers need separate checks.',
            validation: 'In an isolated scratch directory, use a harmless ../canary entry; assert extraction rejects it and no file is created outside the destination. Test supported OS/parser combinations.',
            fix: 'Before every write, compare the destination canonical path against the extraction root canonical path plus a separator. Reject escapes; keep the root app-private and verify archive provenance.' }));
          if (!manifest) continue;
          if (['startActivity', 'startService', 'bindService'].includes(method) && nested.length) findings.push(finding('native-intent-redirection', f.file, c, nested, manifest, {
            title: 'Exported component launches an incoming nested Intent', masvs: 'PLATFORM', doc: 'intent-redirection',
            impact: 'A caller-controlled nested Intent can make the app launch an unintended component using its privileges or URI grants.',
            prerequisite: 'Another app must reach this exported component and control the nested Intent. Android 16 adds default launch protection; older supported devices and explicit opt-outs must be tested.',
            validation: 'Use a local test sender and a harmless private test component; verify disallowed destinations and URI grant flags are rejected on each supported Android version.',
            fix: 'Prefer a fixed explicit destination. Otherwise use IntentSanitizer with a narrow component/data allowlist and strip unwanted URI grants; keep Android launch protection enabled.' }));
          if (method === 'loadUrl' && ctx.typed(c.name.split('.')[0], /^WebView$/) && external.length) findings.push(finding('native-intent-webview', f.file, c, external, manifest, {
            severity: 'medium', title: 'Exported component loads an incoming URL in WebView', masvs: 'PLATFORM', doc: 'unsafe-uri-loading',
            impact: 'Another app can select the page shown inside this app. Damage depends on trusted UI, cookies, enabled scripts and exposed bridges.',
            prerequisite: 'The exported component must be reachable with the supplied URL. This does not by itself prove script execution, credential theft or access to a native bridge.',
            validation: 'Supply an untrusted HTTPS host and unsupported schemes in a local test; confirm they are rejected before loading. Inspect redirects and bridge exposure separately.',
            fix: 'Allowlist the parsed HTTPS scheme and exact trusted hosts before loading; handle untrusted links in the system browser and keep native bridges away from untrusted content.' }));
          if (['rawQuery', 'execSQL'].includes(method) && ctx.typed(c.name.split('.')[0], /^SQLiteDatabase$/) && external.length && resolved(c.args[0], ctx, c.token)?.some(t => t.kind === 'string' && /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b/i.test(t.value))) findings.push(finding('native-intent-sql', f.file, c, external, manifest, {
            title: 'Incoming Intent text is concatenated into native SQL', masvs: 'CODE', doc: 'sql-injection',
            impact: 'A crafted Intent value can alter a local database query and expose or modify app records.',
            prerequisite: 'Another app must reach the exported component and control the traced field. This is a local SQLite candidate, not proof of backend SQL injection.',
            validation: 'In a disposable local database, use quote characters as data; confirm the query cannot read or change unrelated rows.',
            fix: 'Use placeholders and selectionArgs/bindArgs, keep SQL structure fixed, and restrict exported entry points to their intended callers.' }));
          if (['FileInputStream', 'FileOutputStream'].includes(c.name) && trusted.has(c.name) && external.length) {
            const write = c.name === 'FileOutputStream';
            findings.push(finding(write ? 'native-intent-file-write' : 'native-intent-file-read', f.file, c, external, manifest, {
              title: `Incoming Intent selects a file ${write ? 'write' : 'read'} path`, masvs: 'STORAGE', doc: 'path-traversal',
              impact: write ? 'A caller can choose an app-accessible path to create or overwrite a file.' : 'A caller can choose which app-accessible file is read; disclosure additionally requires the data to leave the app.',
              prerequisite: 'Another app must reach the exported component and supply the traced path. Sandbox permissions still limit accessible files; data exfiltration is not established by a read alone.',
              validation: 'Use only a disposable app-private canary file; verify absolute paths and traversal outside the intended directory are refused.',
              fix: 'Accept an allowlisted identifier instead of an arbitrary filesystem path. Resolve inside a fixed app-private root, verify canonical containment and enforce caller permissions.' }));
          }
        }
      }
    } catch { skipped.syntax++; }
  }
  return { findings: findings.filter((f, i, a) => a.findIndex(x => x.id === f.id) === i), coverage: {
    rules: NATIVE_SECURITY_RULES, filesRead: files.length, candidateFiles, matchedEntryPoints, methodsRead, guardedOrUnresolved: guarded, skipped,
    method: 'Bounded Java/Kotlin local source flows and exact explicit-export manifest correlation; no app execution.',
    limits: ['Not a Java/Kotlin parser, manifest merger or interprocedural call graph.', 'Conditionals, validators, unknown transforms, Kotlin interpolation and cross-method flows may be skipped; suppression is not a passed control.', 'Only explicit exported components without declared permissions are input entry points; iOS flows, binary SDKs and native dependency code are outside these six checks.', 'OS mitigations and runtime reachability need testing on supported devices.'] } };
}
