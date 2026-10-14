import fs from './read-boundary.js';
import path from 'node:path';
import { lex, split, values, calls, objectProperties, declarations, resolveLocal, sourceFiles } from './security-source.js';

export const MOBILE_SECURITY_RULES = [
  'credential-telemetry', 'credential-url', 'webview-message-eval', 'remote-code-eval',
  'sqlite-input-query', 'oauth-pkce-disabled', 'oauth-implicit-flow', 'android-fileprovider-broad',
  'biometric-prompt-only', 'ios-file-sharing-data',
];

// iOS file sharing (UIFileSharingEnabled) shows the app's Documents folder in Finder and, with
// LSSupportsOpeningDocumentsInPlace, in the Files app. react-native-mmkv, expo-sqlite and Realm
// keep their data in Documents by default on iOS (checked in each library's source). Reported
// only when such a store is opened without encryption and without a custom location.
const DOC_STORES = [
  { lib: 'react-native-mmkv', open: /\b(?:new\s+MMKV|createMMKV)\s*\(/, custom: /\b(?:path|encryptionKey)\s*:/ },
  { lib: 'expo-sqlite', open: /\bopenDatabase(?:Sync|Async)?\s*\(/, custom: /\bopenDatabase(?:Sync|Async)?\s*\([^)]*,[^)]*,|defaultDatabaseDirectory|SQLCipher|PRAGMA\s+key/i },
  { lib: 'realm', open: /\b(?:new\s+Realm|Realm\.open)\s*\(|<RealmProvider\b/, custom: /\b(?:path|encryptionKey)\s*[:=]/ },
];
function fileSharingChecks(root, files) {
  // The app's own Info.plist first, then variants such as DevInfo.plist.
  const plists = sourceFiles(root, /Info\.plist$/).files.filter((f) => !/(?:^|\/)Pods\//.test(f.file))
    .sort((a, b) => Number(path.basename(b.file) === 'Info.plist') - Number(path.basename(a.file) === 'Info.plist'));
  const shares = plists.find((f) => /<key>UIFileSharingEnabled<\/key>\s*<true\s*\/>/.test(f.text));
  let config = null, configInPlace = false;
  for (const name of ['app.json', 'app.config.json']) {
    try {
      const t = fs.readFileSync(path.join(root, name), 'utf8');
      if (/"UIFileSharingEnabled"\s*:\s*true/.test(t)) { config = name; configInPlace = /"LSSupportsOpeningDocumentsInPlace"\s*:\s*true/.test(t); }
    } catch { /* none */ }
  }
  const where = shares ? shares.file : config;
  if (!where) return [];
  const inPlace = shares ? plists.some((f) => /<key>LSSupportsOpeningDocumentsInPlace<\/key>\s*<true\s*\/>/.test(f.text)) : configInPlace;
  const stores = [];
  for (const store of DOC_STORES) {
    const users = files.filter((f) => !f.file.endsWith('.xml') && new RegExp(`['"]${store.lib}['"]`).test(f.text));
    if (!users.length || users.some((f) => store.custom.test(f.text))) continue;
    const opener = users.find((f) => store.open.test(f.text));
    if (!opener) continue;
    stores.push({ lib: store.lib, file: opener.file, line: opener.text.slice(0, opener.text.search(store.open)).split('\n').length });
  }
  if (!stores.length) return [];
  return [{
    id: `ios-file-sharing-data:${where}`, severity: 'low', area: 'security', confidence: 'medium', masvs: 'STORAGE',
    title: `iOS file sharing exposes unencrypted app data (${stores.map((s) => s.lib).join(', ')})`,
    detail: `${where} turns on UIFileSharingEnabled${inPlace ? ' and LSSupportsOpeningDocumentsInPlace' : ''}, so the app's Documents folder is visible ${inPlace ? 'in the Files app and ' : ''}in Finder on a connected Mac. ${stores.map((s) => `${s.lib} (${s.file}:${s.line})`).join(', ')} keeps its data in Documents by default on iOS, here without encryption or a custom location, so the database file can be copied out. If the app shares Documents on purpose (exports, downloads), move the database out of it.`,
    evidence: [{ file: where }, ...stores.map((s) => ({ file: s.file, line: s.line }))],
    attack: { impact: 'Someone with the unlocked device, or a computer the device trusts, can copy the app\'s database files and read their contents.', prerequisite: 'Physical access to the unlocked device or a trusted computer. Not exploitable remotely.', validation: 'Install a test build, add sample data, then open the app\'s folder in the Files app or in Finder; after the fix the database files must not be there (or must be encrypted).', evidenceType: 'static-source' },
    fix: { kind: 'security', file: where, step: 'Store the database outside Documents (Library/Application Support: react-native-mmkv `path`, expo-sqlite directory argument, Realm `path`) or encrypt it (`encryptionKey`), or turn off UIFileSharingEnabled if the app does not need to share files.' },
  }];
}

// Biometric prompts whose only result is a yes/no in JavaScript (OWASP MASTG local authentication,
// "event-bound"): with physical access to a jailbroken or rooted device, instrumentation can make
// the prompt report success. Not reported when the app binds a secret to biometrics anywhere: a
// keychain/keystore item or key behind biometric access control, in JavaScript or native code.
const BIOMETRIC_PROMPT = /\b(?:LocalAuthentication\.authenticateAsync|authenticateAsync|simplePrompt|TouchID\.authenticate|FingerprintScanner\.authenticate)\s*\(/;
const BIOMETRIC_LIBS = /from\s*['"](?:expo-local-authentication|react-native-biometrics|@sbaiahmed1\/react-native-biometrics|react-native-touch-id|react-native-fingerprint-scanner)['"]|require\(\s*['"](?:expo-local-authentication|react-native-biometrics|react-native-touch-id|react-native-fingerprint-scanner)['"]/;
const BIOMETRIC_BOUND_JS = /\b(?:createSignature|createKeys|ACCESS_CONTROL\.BIOMETRY\w*|AccessControl\.BIOMETRY\w*|requireAuthentication\s*:\s*true|authenticationPrompt\s*:)/;
const BIOMETRIC_BOUND_NATIVE = /SecAccessControlCreateWithFlags|kSecAttrAccessControl|\.biometryCurrentSet|\.biometryAny|setUserAuthenticationRequired|BiometricPrompt\.CryptoObject/;
function biometricChecks(root, files) {
  // Blank comments out but keep their line breaks, so reported line numbers stay right.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
  const prompts = [];
  for (const f of files) {
    if (f.file.endsWith('.xml') || !BIOMETRIC_LIBS.test(f.text)) continue;
    const code = strip(f.text);
    if (BIOMETRIC_BOUND_JS.test(code)) return [];
    const m = code.match(BIOMETRIC_PROMPT);
    if (m) prompts.push({ file: f.file, line: code.slice(0, m.index).split('\n').length });
  }
  if (!prompts.length) return [];
  for (const f of files) if (!f.file.endsWith('.xml') && BIOMETRIC_BOUND_JS.test(strip(f.text))) return [];
  for (const f of sourceFiles(root, /\.(?:swift|m|mm|kt|java)$/).files) if (BIOMETRIC_BOUND_NATIVE.test(f.text)) return [];
  const at = `${prompts[0].file}:${prompts[0].line}`;
  return [{
    id: 'biometric-prompt-only', severity: 'low', area: 'security', confidence: 'medium', masvs: 'AUTH',
    title: `Biometric check is only a yes/no answer in JavaScript (${at}${prompts.length > 1 ? ` and ${prompts.length - 1} more` : ''})`,
    detail: 'The app asks for Face ID, Touch ID or a fingerprint and trusts the success result, but no secret or key in the app is bound to biometrics (no keychain/keystore item behind biometric access control was found in JavaScript or native code). The prompt then guards the screen, not the data: secrets the app stores stay readable whenever the device is unlocked. For an app lock on non-sensitive data this can be acceptable; for money, health or credentials, bind the secret to biometrics.',
    evidence: prompts.slice(0, 10),
    attack: { impact: 'Someone holding the device can get past the biometric gate, or read the stored secrets directly, without the owner\'s face or finger.', prerequisite: 'Physical access to the device, and a jailbroken or rooted device with runtime instrumentation (for example Frida). Not exploitable remotely.', validation: 'On a jailbroken or rooted test device, hook the biometric API to return success and check whether protected screens and secrets become available; after the fix, the secret must stay unreadable until a real biometric match.', evidenceType: 'static-source' },
    fix: { kind: 'security', file: prompts[0].file, line: prompts[0].line, step: 'Store the secret behind biometric access control and read it as the proof of authentication: react-native-keychain with accessControl BIOMETRY_CURRENT_SET, expo-secure-store with requireAuthentication: true, or react-native-biometrics createSignature verified by your server.' },
  }];
}
const DOCS = {
  credentials: 'https://reactnative.dev/docs/security',
  webview: 'https://github.com/react-native-webview/react-native-webview/blob/master/docs/Guide.md#communicating-between-js-and-native',
  sql: 'https://docs.expo.dev/versions/latest/sdk/sqlite/#usage',
  oauth: 'https://www.rfc-editor.org/rfc/rfc8252#section-8.1',
  files: 'https://developer.android.com/privacy-and-security/risks/file-providers',
};
const SENSITIVE = /^(?:access_?token|refresh_?token|id_?token|auth_?token|session_?token|private_?key|mnemonic|seed_?phrase)$/i;
const PASSWORD = /^(?:password|passwd|passcode)$/i;
const unwrap = expr => {
  if (expr[0]?.value === 'await') expr = expr.slice(1);
  while (expr[0]?.value === '(' && expr[0].match === expr.at(-1)?.index) expr = expr.slice(1, -1);
  return expr;
};

// Short, same-block const propagation. Unknown calls, mutable aliases, cross-function
// flows and validators are not guessed. No literal credential values enter findings.
function flow(expr, context, before, depth = 0) {
  if (!expr?.length || depth > 8) return [];
  expr = unwrap(expr);
  const resolved = resolveLocal(expr, context.tokens, context.decls, before);
  if (resolved !== expr) return flow(resolved, context, before, depth + 1);
  if (expr[0]?.kind === 'string' || expr[0]?.kind === 'number') {
    // A concatenation can start with a literal; an isolated literal is not an input.
    if (expr.length === 1) return [];
  }
  if (expr[0]?.value === '`' && expr.at(-1)?.value === '`') {
    const found = [];
    for (let i = 1; i < expr.length - 1; i++) if (expr[i].value === '${' && expr[i].kind === 'punct') {
      const end = expr.findIndex((t, n) => n > i && t.index === expr[i].match);
      if (end < 0) return []; found.push(...flow(expr.slice(i + 1, end), context, before, depth + 1)); i = end;
    }
    return found;
  }
  const plus = split(expr, '+');
  if (plus.length > 1) return plus.flatMap(p => flow(p, context, before, depth + 1));
  const props = objectProperties(expr);
  if (props) return [...props.values()].flatMap(p => flow(p, context, before, depth + 1));
  if (expr[0]?.value === '[' && expr.at(-1)?.value === ']') return split(expr.slice(1, -1)).flatMap(p => flow(p, context, before, depth + 1));
  const name = values(expr);
  if (/^[\w$]+(?:\??\.[\w$]+)*$/.test(name)) {
    const parts = name.split(/\??\./); const last = parts.at(-1);
    if (context.inputs?.some(x => x.name === name && x.block === before.block)) return [{ kind: 'input', line: expr[0].line }];
    if (SENSITIVE.test(last)) return [{ kind: 'credential', name: last, line: expr[0].line }];
    if (PASSWORD.test(last)) return [{ kind: 'password', line: expr[0].line }];
    if (context.webview && /\.nativeEvent\.data(?:\.|$)/.test(name)) return [{ kind: 'webview', line: expr[0].line }];
    if (/^(?:props\.)?route\.params\.[\w$]+/.test(name)) return [{ kind: 'navigation', line: expr[0].line }];
    return [];
  }
  const call = calls(expr).find(c => c.token.index === expr[0]?.index && c.open.match === expr.at(-1)?.index);
  if (!call) return [];
  if (['JSON.stringify', 'JSON.parse', 'String', 'encodeURIComponent'].includes(call.name)) return flow(call.args[0], context, before, depth + 1);
  if (call.name === 'fetch') return [{ kind: 'response', line: call.token.line }];
  if (/^[\w$]+\.(?:text|json)$/.test(call.name) && !call.args[0]?.length) {
    const receiver = expr.slice(0, 1);
    if (flow(receiver, context, before, depth + 1).some(f => f.kind === 'response')) return [{ kind: 'network', line: call.token.line }];
  }
  return [];
}
const importNames = (tokens, module) => {
  const result = new Set();
  for (let i = 0; i < tokens.length; i++) if (tokens[i].value === 'import' && tokens[i].kind === 'id') {
    const end = tokens.findIndex((t, n) => n > i && t.kind === 'string');
    if (end < 0 || !module.test(tokens[end].value)) continue;
    for (let n = i + 1; n < end; n++) if (tokens[n].kind === 'id' && !['from', 'as', 'type'].includes(tokens[n].value)) result.add(tokens[n].value);
  }
  return result;
};
function jsChecks(file, text) {
  const tokens = lex(text), decls = declarations(tokens), found = [];
  const imports = tokens.filter(t => t.kind === 'string').map(t => t.value);
  const inputs = [];
  // TextInput -> useState value: link the setter rather than guessing from names like query.
  const rn = importNames(tokens, /^react-native$/);
  const react = importNames(tokens, /^react$/);
  if (rn.has('TextInput')) for (let i = 0; i < tokens.length - 10; i++) {
    if (tokens[i].value !== 'const' || values(tokens.slice(i + 1, i + 2)) !== '[' || tokens[i + 2].kind !== 'id' || tokens[i + 3].value !== ',' || tokens[i + 4].kind !== 'id' || tokens[i + 5].value !== ']' || tokens[i + 6].value !== '=') continue;
    const stateCall = calls(tokens.slice(i + 7, i + 14))[0];
    if (!stateCall || !/^(?:React\.)?useState$/.test(stateCall.name) || !react.has(stateCall.name.split('.')[0])) continue;
    const setter = tokens[i + 4].value;
    if (tokens.some((t, j) => t.value === 'onChangeText' && values(tokens.slice(j + 1, j + 5)) === '={' + setter + '}' && t.block === tokens[i].block)) inputs.push({ name: tokens[i + 2].value, block: tokens[i].block });
  }
  const context = { tokens, decls, inputs, webview: imports.includes('react-native-webview') && tokens.some(t => t.kind === 'id' && t.value === 'onMessage') };
  const telemetry = importNames(tokens, /^(?:@sentry\/react-native|@react-native-firebase\/(?:analytics|crashlytics)|@amplitude\/analytics-react-native|@segment\/analytics-react-native|mixpanel-react-native)$/);
  const oauth = importNames(tokens, /^(?:expo-auth-session(?:\/providers\/[^/]+)?|react-native-app-auth)$/);
  const sqlite = imports.some(s => /^(?:expo-sqlite(?:\/legacy)?|react-native-sqlite-storage|@op-engineering\/op-sqlite|react-native-quick-sqlite)$/.test(s));
  const add = (rule, c, data, traces = []) => {
    const evidence = [{ file, line: c.token.line, role: 'sink' }, ...traces.filter(t => t.line !== c.token.line).map(t => ({ file, line: t.line, role: 'source' }))];
    const distinct = evidence.filter((v, n, a) => a.findIndex(x => x.line === v.line && x.role === v.role) === n);
    found.push({ id: `${rule}:${file}:${c.token.line}`, severity: data.severity || 'medium', area: 'security', confidence: 'medium',
      title: `${data.title} (${file}:${c.token.line})`, evidence: distinct, masvs: data.masvs,
      attack: { impact: data.impact, prerequisite: data.prerequisite, validation: data.validation, evidenceType: 'static-source' },
      detail: `${data.impact} ${data.prerequisite} Static source evidence; runtime reachability and deployment are not verified. Source: ${data.source}`,
      fix: { kind: 'security', file, line: c.token.line, step: data.fix },
    });
  };
  const shadowCache = new Map();
  const shadowed = name => {
    if (shadowCache.has(name)) return shadowCache.get(name);
    const yes = tokens.some((t, i) => t.kind === 'id' && t.value === name && (
    ['const', 'let', 'var', 'function', 'class'].includes(tokens[i - 1]?.value) ||
    tokens[i + 1]?.value === '=' ||
    (['(', ','].includes(tokens[i - 1]?.value) && [',', ')', ':'].includes(tokens[i + 1]?.value) && tokens.slice(i + 1, i + 20).some((x, n, a) => x.value === ')' && ['=>', '{'].includes(a[n + 1]?.value)))
  ));
    shadowCache.set(name, yes); return yes;
  };
  for (const c of calls(tokens)) {
    const traces = c.args.flatMap(a => flow(a, context, c.token));
    const credentials = traces.filter(t => t.kind === 'credential');
    const root = c.name.split('.')[0];
    // Imported SDK calls only: a local function called track() is not assumed to be analytics.
    if (telemetry.has(root) && !shadowed(root) && /(?:^|\.)(?:captureException|captureMessage|setContext|setExtra|setExtras|setAttributes|setAttribute|logEvent|track|identify|log|recordError)$/.test(c.name) && credentials.length) {
      add('credential-telemetry', c, {
        severity: 'high', masvs: 'STORAGE', title: 'Credential value passed to telemetry',
        impact: 'An authentication token or wallet secret can enter crash reports or analytics, where readers could reuse it.',
        prerequisite: 'This requires the call to run with a real credential and the SDK to transmit it without redaction.',
        validation: 'Use a synthetic canary credential in a local test; inspect the SDK payload and confirm it is removed before transmission.',
        fix: 'Remove credential fields from telemetry payloads. Keep error codes and non-sensitive event IDs; review retention and revoke exposed credentials if transmission occurred.', source: DOCS.credentials,
      }, credentials);
    }
    if (['fetch', 'Linking.openURL'].includes(c.name) || /^axios\.(?:get|post|put|delete|patch)$/.test(c.name)) {
      const expr = resolveLocal(c.args[0] || [], tokens, decls, c.token);
      const leaks = flow(expr, context, c.token).filter(t => ['credential', 'password'].includes(t.kind));
      const publicMapToken = expr[0]?.kind === 'string' && /^https:\/\/(?:api\.mapbox\.com|api\.maptiler\.com)\//.test(expr[0].value) || expr[0]?.value === '`' && expr[1]?.kind === 'string' && /^https:\/\/(?:api\.mapbox\.com|api\.maptiler\.com)\//.test(expr[1].value);
      if (leaks.length && !(publicMapToken && leaks.every(t => /^access_?token$/i.test(t.name || ''))) && expr.some(t => t.kind === 'string' && /[?&][\w.-]+=/.test(t.value))) add('credential-url', c, {
        masvs: 'NETWORK', title: 'Credential embedded in a request URL',
        impact: 'A credential in the URL can be retained in request logs, monitoring or browser history even when HTTPS is used.',
        prerequisite: 'Someone must gain access to a retained URL while the credential remains valid. Intentional one-time, narrowly scoped links need separate review.',
        validation: 'With a synthetic credential, inspect the outgoing URL and server/proxy logs; verify expiry, scope and logging policy.',
        fix: 'Send reusable session credentials in an authorization header over HTTPS, not a query parameter. Use short-lived, single-use codes for browser handoffs.', source: DOCS.credentials,
      }, leaks);
    }
    if (['eval', 'Function'].includes(c.name) && !shadowed(c.name) && !['.', '?.', '>'].includes(tokens[c.token.index - 1]?.value)) {
      const executable = c.name === 'Function' ? c.args.at(-1) : c.args[0];
      const input = flow(executable, context, c.token).filter(t => ['webview', 'network'].includes(t.kind));
      if (input.length) {
        const webview = input.some(t => t.kind === 'webview');
        add(webview ? 'webview-message-eval' : 'remote-code-eval', c, {
          severity: 'high', masvs: 'CODE', title: webview ? 'WebView message reaches JavaScript execution' : 'Network response reaches JavaScript execution',
          impact: 'Data is treated as executable JavaScript in the app runtime, where it may access app state and exposed native APIs.',
          prerequisite: webview ? 'An attacker must control content in the messaging WebView, for example through an untrusted page or page injection.' : 'An attacker must control the fetched response, its server, or an unprotected transport path; HTTPS alone does not make remote code safe.',
          validation: 'In an isolated local fixture, supply a harmless canary message/response and assert it is handled as data, never evaluated.',
          fix: 'Replace eval/Function with a fixed command allowlist and validated JSON data. Do not execute page messages or fetched text in the app runtime.', source: webview ? DOCS.webview : DOCS.credentials,
        }, input);
      }
    }
    if (sqlite && /\.(?:executeSql|execAsync|execSync|runAsync|runSync|getAllAsync|getFirstAsync)$/.test(c.name)) {
      const query = resolveLocal(c.args[0] || [], tokens, decls, c.token);
      const input = flow(query, context, c.token).filter(t => ['webview', 'navigation', 'network', 'input'].includes(t.kind));
      if (input.length && query.some(t => t.kind === 'string' && /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE)\b/i.test(t.value))) add('sqlite-input-query', c, {
        severity: 'high', masvs: 'CODE', title: 'External input is concatenated into SQL',
        impact: 'Input can change the local SQL query structure and may expose or modify records in the app database.',
        prerequisite: 'An attacker must control the traced text input, navigation parameter, WebView message or network response. This is a local database risk, not proof of backend SQL injection.',
        validation: 'Test locally with quote characters in the input and verify they are stored/queried as literal data while unrelated rows remain inaccessible.',
        fix: 'Use SQL placeholders and bound parameters. Keep identifiers fixed or allowlisted; execAsync/execSync do not bind input.', source: DOCS.sql,
      }, input);
    }
    if (oauth.has(root) && !shadowed(root) && /(?:^|\.)(?:useAuthRequest|AuthRequest|authorize)$/.test(c.name)) {
      const props = objectProperties(resolveLocal(c.args[0] || [], tokens, decls, c.token));
      if (!props) continue;
      const type = values(props.get('responseType') || []);
      const implicit = ['"token"', 'ResponseType.Token', 'AuthSession.ResponseType.Token', '"id_token"'].includes(type);
      const pkceOff = values(props.get('usePKCE') || []) === 'false';
      if (implicit || (pkceOff && (!type || ['"code"', 'ResponseType.Code', 'AuthSession.ResponseType.Code'].includes(type)))) add(implicit ? 'oauth-implicit-flow' : 'oauth-pkce-disabled', c, {
        masvs: 'AUTH', title: implicit ? 'OAuth requests tokens through the redirect' : 'OAuth code flow explicitly disables PKCE',
        impact: implicit ? 'Tokens returned directly through redirects can be exposed to a redirect interceptor.' : 'An intercepted authorization code may be redeemable without the app-specific code verifier.',
        prerequisite: 'An attacker must intercept the redirect, and server-side protections must permit redemption/use. A backend-mediated exchange may change the threat model.',
        validation: 'Review the actual authorization request and server exchange; verify code_challenge_method=S256 and rejection of an incorrect code_verifier in a test tenant.',
        fix: 'Use authorization code flow with PKCE (S256). Keep the library default usePKCE=true; document and test any backend-mediated exception.', source: DOCS.oauth,
      });
    }
  }
  return found.filter((f, i, a) => a.findIndex(x => x.id === f.id) === i);
}
const xmlClean = text => text.replace(/<!--[\s\S]*?-->/g, s => s.replace(/[^\n]/g, ' '));
const attrs = text => Object.fromEntries([...text.matchAll(/([\w:.-]+)\s*=\s*(['"])(.*?)\2/g)].map(m => [m[1], m[3]]));
function fileProviderChecks(files) {
  const found = [];
  for (const manifest of files.filter(f => /(?:^|\/)android\/app\/src\/(?:main|release)\/AndroidManifest\.xml$/.test(f.file))) {
    for (const provider of xmlClean(manifest.text).matchAll(/<provider\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/provider\s*>)/g)) {
      const a = attrs(provider[1]);
      if (!/FileProvider$/.test(a['android:name'] || '') || a['android:enabled'] === 'false') continue;
      for (const meta of (provider[2] || '').matchAll(/<meta-data\b([^>]+)>/g)) {
        const m = attrs(meta[1]);
        if (m['android:name'] !== 'android.support.FILE_PROVIDER_PATHS' || !/^@xml\/[\w]+$/.test(m['android:resource'] || '')) continue;
        const name = m['android:resource'].slice(5);
        const prefix = manifest.file.slice(0, manifest.file.lastIndexOf('/src/') + 5);
        for (const config of files.filter(f => f.file.startsWith(prefix) && new RegExp(`/(?:main|release)/res/xml(?:-[^/]+)?/${name}\\.xml$`).test('/' + f.file))) {
          for (const entry of xmlClean(config.text).matchAll(/<(root-path|files-path)\b([^>]+)>/g)) {
            const p = attrs(entry[2]).path;
            if (p === undefined || !['', '.', './', '/'].includes(p)) continue;
            const line = config.text.slice(0, entry.index).split('\n').length;
            found.push({ id: `android-fileprovider-broad:${config.file}:${line}`, severity: 'medium', area: 'security', confidence: 'high', masvs: 'STORAGE',
              title: `FileProvider shares a broad ${entry[1]} (${config.file}:${line})`,
              evidence: [{ file: config.file, line }, { file: manifest.file, line: manifest.text.slice(0, provider.index).split('\n').length }],
              attack: { impact: 'A URI grant can expose unintended private files or allow modification.', prerequisite: 'A caller must obtain a URI grant or reach an unsafe sharing path; this configuration alone does not let every app read files.', validation: 'In a local test, request a URI outside the intended share subdirectory and assert that the app refuses both read and write access.', evidenceType: 'static-source' },
              detail: `A declared FileProvider references this broad path. An unsafe URI grant could expose unintended files. exported=false alone does not prevent granted access; no unsafe grant or live exploit is proven. Source: ${DOCS.files}`,
              fix: { kind: 'security', file: config.file, line, step: 'Share only a dedicated narrow subdirectory; remove broad root paths and validate the file and read/write flags before granting a content URI.' },
            });
          }
        }
      }
    }
  }
  return found.filter((f, i, a) => a.findIndex(x => x.id === f.id) === i);
}
export function mobileSecurity(root) {
  const { files, skipped } = sourceFiles(root);
  skipped.syntax = 0;
  const findings = [];
  for (const f of files) {
    if (f.file.endsWith('.xml') || !/captureException|captureMessage|setContext|setExtra|setAttributes|setAttribute|logEvent|track|identify|recordError|fetch|openURL|axios|eval|Function|executeSql|execAsync|execSync|runAsync|runSync|getAllAsync|getFirstAsync|usePKCE|responseType/.test(f.text)) continue;
    try { findings.push(...jsChecks(f.file, f.text)); } catch { skipped.syntax++; }
  }
  findings.push(...fileProviderChecks(files));
  findings.push(...biometricChecks(root, files));
  findings.push(...fileSharingChecks(root, files));
  return { findings, coverage: { rules: MOBILE_SECURITY_RULES, filesRead: files.length, skipped,
    method: 'Bounded static source analysis with same-block const propagation; no project execution.',
    limits: ['Not a full JavaScript/TypeScript parser or call graph.', 'Cross-file flows, dynamic configuration and complex validation are not resolved.', 'Excluded: dependencies, build outputs, tests, examples, known server/web folders, .web files, symlinks and files over 512 KiB.', 'Backend authorization, deployed rules and runtime exploitability require separate verification.'] } };
}
