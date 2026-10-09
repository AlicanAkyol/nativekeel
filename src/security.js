import fs from 'node:fs';
import path from 'node:path';
import { compareVersions } from './known-issues.js';

// Security checks beyond leaked keys: known vulnerabilities in shipped dependencies, passwords
// that flow into logs or remote writes, unsafe WebView settings, and Android backups.

const SKIP_DIRS = new Set(['node_modules', '.git', 'Pods', 'build', '.gradle', 'DerivedData', '.expo', 'dist', 'coverage', 'vendor', '__tests__', '__mocks__', 'e2e']);
const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;
const MAX_FILE_BYTES = 512 * 1024;

function* jsFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) yield* jsFiles(path.join(dir, e.name));
    } else if (JS_EXT.test(e.name) && !/\.(test|spec)[._]/.test(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

const read = (file) => {
  try {
    return fs.statSync(file).size > MAX_FILE_BYTES ? '' : fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const SERVER_ONLY = /node\.?js|server[- ]side|\bhttp adapter\b|\bhttp\/2\b|\bssr\b|\bssrf\b|no_proxy|proxy-authorization|config\.proxy|\bproxy is re-evaluated|cloud metadata|formDataToStream/i;
const SEVERITY = { critical: 'critical', high: 'high', moderate: 'medium', low: 'low', info: 'low' };
const RANK = ['low', 'medium', 'high', 'critical'];

// Advisories for the exact versions of runtime dependencies (devDependencies never ship).
export async function vulnerableDependencies(registry, versions, latestOf = {}) {
  const names = Object.keys(versions);
  if (!names.length) return [];
  const advisories = await registry.advisories(versions);
  if (!advisories) return null; // request failed: the caller says the check did not run
  const findings = [];
  for (const [name, list] of Object.entries(advisories)) {
    const version = versions[name];
    if (!version || !Array.isArray(list)) continue; // only what we asked about
    // The endpoint answers for the versions we sent; double-check the range where it is simple.
    const relevant = list.filter((a) => applies(version, a.vulnerable_versions));
    if (!relevant.length) continue;
    // Advisories about Node.js-only code paths (axios' HTTP adapter, server rendering) do not
    // reach a React Native app: keep them visible, but at low severity.
    const sevOf = (a) => (SERVER_ONLY.test(a.title || '') ? 'low' : SEVERITY[a.severity] || 'low');
    const severity = relevant.map(sevOf).sort((a, b) => RANK.indexOf(b) - RANK.indexOf(a))[0];
    const serverOnly = relevant.filter((a) => SERVER_ONLY.test(a.title || '')).length;
    let fixedIn = minimumFixed(relevant);
    // Compare with what is published: "<=2.0.2" when 2.0.2 is the latest release means no fix exists.
    const newest = latestOf[name];
    let noFix = false;
    if (fixedIn && newest) {
      const after = fixedIn.startsWith('a release after ') ? fixedIn.slice('a release after '.length) : null;
      if (after) {
        if (compareVersions(newest, after) > 0) fixedIn = newest;
        else noFix = true;
      } else if (compareVersions(newest, fixedIn) < 0) noFix = true;
      if (noFix) fixedIn = null;
    }
    const top = relevant
      .slice()
      .sort((a, b) => RANK.indexOf(sevOf(b)) - RANK.indexOf(sevOf(a)))
      .slice(0, 3)
      .map((a) => `${a.title}${a.url ? ` (${a.url})` : ''}`);
    findings.push({
      id: `vuln:${name}`,
      severity,
      area: 'security',
      title: `${name} ${version}: ${relevant.length - serverOnly || relevant.length} known vulnerabilit${(relevant.length - serverOnly || relevant.length) === 1 ? 'y' : 'ies'}${serverOnly && serverOnly < relevant.length ? ` (+${serverOnly} for Node.js only)` : ''}${fixedIn ? ` (fixed in ${fixedIn})` : noFix ? ' (no fixed release)' : ''}`,
      detail: `${top.join('; ')}${relevant.length > 3 ? `; and ${relevant.length - 3} more` : ''}. ${fixedIn ? `Fixed in ${fixedIn}${fixedIn.startsWith('a release') ? '' : ' or later'}.` : noFix ? `No fixed release exists yet (the latest is ${newest}): replace it, or make sure it never handles untrusted input.` : 'Check the advisories for a fixed version.'}${serverOnly ? ` ${serverOnly} of them concern Node.js/server use only and are counted as low.` : ''} Source: GitHub Advisory Database (via npm).`,
      fix: { kind: 'vuln-dep', name, from: version, to: fixedIn, noFix, latest: newest || null, severity },
    });
  }
  return findings;
}

// "<1.2.3", ">=1.0.0 <1.2.3", "<=1.2.2" and "||" lists. Unknown syntax: trust the endpoint.
function applies(version, range) {
  if (!range) return true;
  return range.split('||').some((part) => {
    const conds = part.trim().split(/\s+/).filter(Boolean);
    return conds.every((c) => {
      const m = c.match(/^(<=|>=|<|>|=)?(\d+\.\d+\.\d+)/);
      if (!m) return true;
      const cmp = compareVersions(version, m[2]);
      return { '<': cmp < 0, '<=': cmp <= 0, '>': cmp > 0, '>=': cmp >= 0, '=': cmp === 0, undefined: cmp === 0 }[m[1]];
    });
  });
}

// The lowest version outside every advisory's range. "<1.2.3" is fixed in 1.2.3; "<=1.2.2" only
// says "after 1.2.2", which counts when it is the highest bound.
function minimumFixed(advisories) {
  let fixed = null;
  for (const a of advisories) {
    const bounds = [...String(a.vulnerable_versions || '').matchAll(/<(=?)\s*(\d+\.\d+\.\d+)/g)].map((m) => ({ v: m[2], after: m[1] === '=' }));
    if (!bounds.length) return null; // an advisory without a fixed version
    const hi = bounds.sort((x, y) => compareVersions(x.v, y.v) || (x.after ? 1 : -1)).at(-1);
    if (!fixed || compareVersions(hi.v, fixed.v) > 0 || (compareVersions(hi.v, fixed.v) === 0 && hi.after)) fixed = hi;
  }
  return fixed && (fixed.after ? `a release after ${fixed.v}` : fixed.v);
}

// A password (or the variables built from it) passed to a log, crash report, analytics event,
// remote database write or plain AsyncStorage. Seen in a real app: failed sign-ups were
// logged to the database as "email-…-password".
const PASSWORD = /\b(?:password|passwd|pwd|passcode|pin)\b/i;
const SINKS = [
  { re: /\b(?:crashlytics\(\)\.(?:log|recordError)|Sentry\.capture\w*|Bugsnag\.notify|captureException|captureMessage|sendCrash|recordError|logEvent|analytics\(\)\.\w+|mixpanel\.\w+|amplitude\.\w+|track)\s*\(/, what: 'crash reports or analytics', severity: 'high' },
  { re: /\b(?:database\(\)|firestore\(\)|ref\([^)]*\)|collection\([^)]*\)|doc\([^)]*\))[\s\S]{0,80}?\.(?:set|push|update|add)\s*\(/, what: 'a remote database', severity: 'high' },
  { re: /\bAsyncStorage\.(?:setItem|multiSet|mergeItem)\s*\(/, what: 'unencrypted AsyncStorage', severity: 'medium' },
  { re: /\bconsole\.(?:log|info|warn|error|debug)\s*\(/, what: 'the device log', severity: 'low' },
];

export function passwordLeaks(root) {
  const findings = [];
  for (const file of jsFiles(root)) {
    const text = read(file);
    if (!text || !PASSWORD.test(text)) continue;
    const lines = text.split('\n');
    // Taint: identifiers that hold a password, or were built from one.
    const tainted = new Set();
    const hits = [];
    lines.forEach((line, i) => {
      if (/secureTextEntry|placeholder|label|title|Text>|i18n|\bt\(|localiz/i.test(line)) return;
      const assign = line.match(/\b(?:const|let|var)\s+(?:\{[^}]*\}|([A-Za-z_$][\w$]*))\s*=(?!=)\s*(.*)/);
      if (assign && assign[1]) {
        // The whole right-hand side: objects and calls often span several lines.
        const rhs = balanced(`${assign[2]}\n${lines.slice(i + 1, i + 12).join('\n')}`);
        // A call's result (a login response, an encrypted value, a hash) is not the password.
        // Concatenations and templates that include the password are still the password.
        const unwrapped = rhs.replace(/^\s*(?:JSON\.stringify|String)\s*\(/, '');
        const isCallResult = wholeCall(unwrapped);
        if (!isCallResult && PASSWORD.test(rhs.replace(/['"`][^'"`\n]*['"`]/g, '')) || [...tainted].some((t) => new RegExp(`\\b${t}\\b`).test(rhs))) tainted.add(assign[1]);
      }
      for (const sink of SINKS) {
        if (!sink.re.test(line)) continue;
        // Exactly the call's arguments, up to the matching parenthesis (they can span lines).
        const args = callArguments(lines.slice(i, i + 12).join('\n'), sink.re);
        const direct = /\bpassword\b|\bpasswd\b|\bpwd\b/i.test(args.replace(/['"`][^'"`]*['"`]/g, ''));
        const viaVar = [...tainted].some((t) => new RegExp(`\\b${t}\\b`).test(args));
        if (direct || viaVar) hits.push({ line: i + 1, sink });
      }
    });
    const worst = hits.sort((a, b) => RANK.indexOf(b.sink.severity) - RANK.indexOf(a.sink.severity))[0];
    if (!worst || worst.sink.severity === 'low') continue; // console.log alone: not reported
    const rel = path.relative(root, file);
    findings.push({
      id: `password-leak:${rel}`,
      severity: worst.sink.severity,
      area: 'security',
      title: `A password may be sent to ${worst.sink.what} (${rel}:${worst.line})`,
      detail: `${hits.length} place${hits.length === 1 ? '' : 's'} in this file pass a password, or a value built from one, to ${[...new Set(hits.map((h) => h.sink.what))].join(', ')}. Anyone with access to those logs or that data can read users' passwords. Log the error code only; never store passwords in AsyncStorage (use the Keychain/Keystore).`,
      fix: { kind: 'security', step: `In \`${rel}\`, stop passing the password (or values built from it) to ${worst.sink.what}; log only error codes. Then delete the records already written.` },
    });
  }
  return findings;
}

// From the start of `text` up to the end of the first statement: stops at a newline or ';' once
// all brackets opened so far are closed.
function balanced(text) {
  let depth = 0;
  const start = text.search(/\S/);
  if (start < 0) return '';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    else if ((c === '\n' || c === ';') && depth <= 0) return text.slice(start, i);
  }
  return text.slice(start);
}

// True when `text` is a single call expression (`await f(...)`, `a.b(...)`), with nothing but
// closing brackets or a semicolon after it: e.g. not `a.toString() + password`.
function wholeCall(text) {
  const m = text.match(/^\s*(?:await\s+)?(?:new\s+)?[\w$.]+\s*\(/);
  if (!m) return false;
  let i = m[0].length;
  for (;;) {
    let depth = 1;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    // Chained calls (`.then(...)`, `.catch(...)`) keep it a call result.
    const chain = text.slice(i).match(/^\s*\??\.\s*[\w$]+\s*\(/);
    if (!chain) break;
    i += chain[0].length;
  }
  return /^[\s);,]*$/.test(text.slice(i));
}

// Text between the opening parenthesis of the first `re` match and its matching close.
function callArguments(text, re) {
  const m = text.match(re);
  if (!m) return '';
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
  }
  return text.slice(start, i - 1);
}

// WebView settings that let page content read local files or mix HTTP into HTTPS pages.
export function webViewRisks(root) {
  const findings = [];
  for (const file of jsFiles(root)) {
    const text = read(file);
    if (!text || !/react-native-webview|<WebView\b/.test(text)) continue;
    const rel = path.relative(root, file);
    const lineOf = (re) => text.slice(0, text.search(re)).split('\n').length;
    const universal = /allowUniversalAccessFromFileURLs\s*(?:=\s*\{\s*true\s*\}|(?=[\s/>]))/;
    const fileAccess = /allowFileAccessFromFileURLs\s*(?:=\s*\{\s*true\s*\}|(?=[\s/>]))/;
    if (universal.test(text) || fileAccess.test(text)) {
      const re = universal.test(text) ? universal : fileAccess;
      // The flags only apply to pages with a file:// origin. A WebView that loads https URLs
      // (Edge's partner pages) cannot be steered to file:// by its page: Chromium blocks that
      // navigation. Local content: file:// URLs, bundled or downloaded HTML, inline html sources.
      // The address often comes from another file (Notesnook: file:///android_asset in source.ts),
      // so files this one imports by relative path are read too.
      const localRe = /file:\/\/|android_asset|\bhtml\s*:|require\([^)]*\.html|DocumentDirectory|documentDirectory|cacheDirectory|CachesDirectory|Paths\.(?:document|cache|bundle)|baseUrl/;
      const hasLocal = (t) => localRe.test(t.replace(/originWhitelist\s*=?\s*\{?\s*\[[^\]]*\]/g, '').replace(/^\s*originWhitelist\s*[:=][^\n]*$/gm, ''));
      const imported = [...text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => {
        const base = path.resolve(path.dirname(file), m[1]);
        for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
          const t = fs.existsSync(base + ext) && fs.statSync(base + ext).isFile() ? read(base + ext) : null;
          if (t) return t;
        }
        return '';
      });
      const local = hasLocal(text) || imported.some(hasLocal);
      if (!local) {
        findings.push({
          id: `webview-file-access:${rel}`,
          severity: 'low',
          area: 'security',
          title: `WebView has file-URL access flags it does not need (${rel}:${lineOf(re)})`,
          detail: 'allowUniversalAccessFromFileURLs / allowFileAccessFromFileURLs only affect pages loaded from file://, and this file loads web URLs, so today they do nothing. If a local HTML page is ever shown here, its scripts could read app files and call any origin: remove them now.',
          fix: { kind: 'security', step: `In \`${rel}\`, remove \`allowUniversalAccessFromFileURLs\` / \`allowFileAccessFromFileURLs\` from the WebView.` },
        });
      } else findings.push({
        id: `webview-file-access:${rel}`,
        severity: 'high',
        area: 'security',
        title: `WebView lets page scripts read local files (${rel}:${lineOf(re)})`,
        detail: 'allowUniversalAccessFromFileURLs / allowFileAccessFromFileURLs let JavaScript in a file:// page read other files and call any origin. Combined with any injected or remote content this exposes app data. Remove them unless you load only your own bundled files.',
        fix: { kind: 'security', step: `In \`${rel}\`, remove \`allowUniversalAccessFromFileURLs\` / \`allowFileAccessFromFileURLs\` from the WebView.` },
      });
    }
    if (/mixedContentMode\s*=\s*\{?\s*['"]always['"]/.test(text)) {
      findings.push({
        id: `webview-mixed-content:${rel}`,
        severity: 'medium',
        area: 'security',
        title: `WebView allows HTTP content inside HTTPS pages (${rel}:${lineOf(/mixedContentMode/)})`,
        detail: 'mixedContentMode="always" lets insecure scripts and frames load into secure pages on Android, where a network attacker can change them. Use "never", or "compatibility" if a legacy page needs it.',
        fix: { kind: 'security', step: `In \`${rel}\`, set \`mixedContentMode="never"\`.` },
      });
    }
  }
  return findings;
}

// android:allowBackup="true" without backup rules: app data (tokens in SharedPreferences,
// AsyncStorage, databases) can be copied off the device with adb or restored to another one.
export function androidBackup(root) {
  const file = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const text = read(file);
  if (!text) return [];
  const app = text.match(/<application\b[^>]*>/s);
  if (!app || !/android:allowBackup\s*=\s*"true"/.test(app[0])) return [];
  if (/android:(?:dataExtractionRules|fullBackupContent)\s*=\s*"@/.test(app[0])) return [];
  return [
    {
      id: 'android-allow-backup',
      severity: 'medium',
      area: 'security',
      title: 'Android backups include all app data (allowBackup="true")',
      detail: 'Without backup rules, tokens and databases are copied by device and cloud backups and can be restored on another device. The React Native template sets allowBackup="false"; set it back, or add dataExtractionRules that exclude credentials.',
      fix: { kind: 'security', step: 'Set `android:allowBackup="false"` in `android/app/src/main/AndroidManifest.xml`, or add `dataExtractionRules` that exclude credentials.' },
    },
  ];
}

const SYSTEM_ACTIONS = new Set([
  'android.appwidget.action.APPWIDGET_UPDATE',
  'android.intent.action.BOOT_COMPLETED',
  'android.intent.action.LOCKED_BOOT_COMPLETED',
  'android.intent.action.QUICKBOOT_POWERON',
  'com.htc.intent.action.QUICKBOOT_POWERON',
  'android.intent.action.MY_PACKAGE_REPLACED',
  'android.intent.action.PACKAGE_REPLACED',
  'android.intent.action.DOWNLOAD_COMPLETE',
  'android.intent.action.REBOOT',
]);

// Services, receivers and providers in the app's own manifest that other apps can start or
// query: exported without a permission. (Launcher activities are meant to be exported.)
export function exportedComponents(root) {
  const file = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const text = read(file);
  if (!text) return [];
  const open = [];
  for (const m of text.matchAll(/<(service|receiver|provider)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const attrs = m[2];
    if (!/android:exported\s*=\s*"true"/.test(attrs) || /android:(?:permission|readPermission|writePermission)\s*=/.test(attrs)) continue;
    // Widgets and receivers for system broadcasts (boot, package replaced, download complete)
    // have to be exported for Android to reach them.
    const actions = [...(m[3] || '').matchAll(/<action\s+android:name\s*=\s*"([^"]+)"/g)].map((a) => a[1]);
    const isWidget = /android\.appwidget\.provider/.test(m[3] || '');
    if (isWidget || (actions.length && actions.every((a) => SYSTEM_ACTIONS.has(a) || (m[1] === 'receiver' && /^android\.(?:intent\.action|appwidget\.action)\./.test(a))))) continue;
    const name = (attrs.match(/android:name\s*=\s*"([^"]+)"/) || [])[1] || m[1];
    open.push(`${m[1]} ${name}`);
  }
  if (!open.length) return [];
  return [
    {
      id: 'android-exported-components',
      severity: 'medium',
      area: 'security',
      title: `${open.length} Android component${open.length === 1 ? '' : 's'} open to every other app`,
      detail: `${open.slice(0, 4).join(', ')}${open.length > 4 ? ', …' : ''}: exported="true" without a permission, so any installed app can start it or read from it. Set exported="false" unless another app must call it, or protect it with android:permission.`,
      fix: { kind: 'security', step: 'In `android/app/src/main/AndroidManifest.xml`, set `android:exported="false"` on services/receivers/providers no other app needs, or add `android:permission`.' },
    },
  ];
}

// API calls over plain HTTP/WS to a real host. Android (API 28+) and iOS block these unless
// security is turned off, so they either fail in production or travel unencrypted.
const LOCAL_HOST = /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1)/;
export function plainHttpCalls(root) {
  const hosts = new Map();
  for (const file of jsFiles(root)) {
    const text = read(file);
    if (!text || !/(?:http|ws):\/\//.test(text)) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (/Linking\.|openURL|openBrowser|WebBrowser\.|href=|xmlns|schemas\.|w3\.org|example\.(?:com|org)/.test(line)) return;
      if (!/\bfetch\s*\(|axios|baseURL|baseUrl|BASE_URL|API_URL|apiUrl|new WebSocket\s*\(|\.get\s*\(|\.post\s*\(/.test(line)) return;
      for (const m of line.matchAll(/['"`](?:http|ws):\/\/([^/'"`:\s$]+)/g)) {
        // Real hosts only: not local addresses, not placeholders like http://dummy used for URL parsing.
        if (LOCAL_HOST.test(m[1]) || /^\$\{/.test(m[1]) || !m[1].includes('.')) continue;
        if (!hosts.has(m[1])) hosts.set(m[1], `${path.relative(root, file)}:${i + 1}`);
      }
    });
  }
  if (!hosts.size) return [];
  const list = [...hosts].map(([h, at]) => `${h} (${at})`);
  return [
    {
      id: 'plain-http-calls',
      severity: 'medium',
      area: 'security',
      title: `API calls over plain HTTP to ${hosts.size} host${hosts.size === 1 ? '' : 's'}`,
      detail: `${list.slice(0, 4).join(', ')}${list.length > 4 ? ', …' : ''}. Anyone on the same network can read or change this traffic, and Android and iOS block it unless cleartext is allowed. Use https:// (wss:// for sockets).`,
      fix: { kind: 'security', step: `Switch ${[...hosts.keys()].slice(0, 3).map((h) => `\`${h}\``).join(', ')}${hosts.size > 3 ? ' and the others' : ''} to https:// (wss:// for sockets), then remove any cleartext exceptions you added for them.` },
    },
  ];
}

// Firebase security rules kept in the repo. An open database or bucket is the most common way
// mobile app data leaks: anyone with the project id (it ships in the app) can read or wipe it.
export function cloudRules(root, deps, now = new Date()) {
  const findings = [];
  const dirs = [root, path.dirname(root), path.dirname(path.dirname(root))];
  const findFile = (names) => {
    for (const d of dirs) for (const n of names) if (fs.existsSync(path.join(d, n))) return path.join(d, n);
    return null;
  };
  const rel = (f) => path.relative(root, f) || path.basename(f);
  const usesFirebaseData = Object.keys(deps).some((n) => /^@react-native-firebase\/(database|firestore|storage)$|^firebase$/.test(n));

  // Realtime Database (JSON). `.read`/`.write` set to true, or "auth != null" at the root.
  const rtdb = findFile(['database.rules.json']);
  if (rtdb) {
    const text = read(rtdb);
    const openWrite = /"\.write"\s*:\s*(?:true|"true")/.test(text);
    const openRead = /"\.read"\s*:\s*(?:true|"true")/.test(text);
    const rootAuthOnly = /"rules"\s*:\s*\{\s*"\.(?:read|write)"\s*:\s*"auth\s*!==?\s*null"/.test(text);
    if (openWrite || openRead) {
      findings.push(rulesFinding('firebase-rtdb-open', openWrite ? 'critical' : 'high', `Realtime Database rules let anyone ${openWrite ? 'write' : 'read'} (${rel(rtdb)})`, `A rule sets ${openWrite ? '".write"' : '".read"'} to true. The database URL ships inside the app, so anyone can ${openWrite ? 'change or delete your data' : 'download it'} without signing in.`, `In \`${rel(rtdb)}\`, replace the true rules with auth and owner checks (e.g. "auth.uid === $uid").`));
    } else if (rootAuthOnly) {
      findings.push(rulesFinding('firebase-rtdb-any-user', 'medium', `Realtime Database rules give every signed-in user the whole database (${rel(rtdb)})`, 'The root rule only checks "auth != null". Anyone who can create an account (or sign in anonymously) can read or write every user\'s data.', `In \`${rel(rtdb)}\`, scope the rules per path, e.g. "auth.uid === $uid".`));
    }
  }

  // Firestore and Storage rules: `allow ...: if true`, a bare `allow read, write;`, or
  // test-mode rules (`request.time < timestamp.date(...)`).
  for (const [names, label, id] of [[['firestore.rules'], 'Firestore', 'firebase-firestore'], [['storage.rules'], 'Cloud Storage', 'firebase-storage']]) {
    const file = findFile(names);
    if (!file) continue;
    const text = read(file).replace(/\/\/.*$/gm, '');
    const testMode = text.match(/request\.time\s*<\s*timestamp\.date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)/);
    const { openWrite, openReadAll } = scanAllowRules(text);
    if (testMode) {
      const until = new Date(Date.UTC(Number(testMode[1]), Number(testMode[2]) - 1, Number(testMode[3])));
      if (until > now) {
        findings.push(rulesFinding(`${id}-test-mode`, 'critical', `${label} is in test mode until ${until.toISOString().slice(0, 10)} (${rel(file)})`, 'Test-mode rules allow every read and write from anyone until that date.', `Replace the test-mode rules in \`${rel(file)}\` with rules that check request.auth and the document owner.`));
      } else {
        findings.push(rulesFinding(`${id}-test-mode-expired`, 'high', `${label} test-mode rules expired on ${until.toISOString().slice(0, 10)} (${rel(file)})`, 'Past that date every request is denied, so the app cannot read or write its data, and the rules in the repo do not describe real access control.', `Write real rules in \`${rel(file)}\` (request.auth and owner checks).`));
      }
    } else if (openWrite) {
      findings.push(rulesFinding(`${id}-open-write`, 'critical', `${label} rules let anyone write (${rel(file)}:${openWrite})`, 'A write rule has no condition (or "if true"). Your Firebase project id ships inside the app, so anyone can change or delete this data without signing in.', `In \`${rel(file)}\`, require request.auth (and the owner's uid) for every write.`));
    } else if (openReadAll) {
      findings.push(rulesFinding(`${id}-open-read`, 'high', `${label} rules let anyone read everything (${rel(file)}:${openReadAll})`, 'A recursive wildcard match ({path=**}) allows reads with no condition, so all data is public to anyone who has the project id (it ships inside the app).', `In \`${rel(file)}\`, limit public reads to the paths that are meant to be public.`));
    }
  }

  if (!findings.length && usesFirebaseData && !rtdb && !findFile(['firestore.rules', 'storage.rules'])) {
    findings.push({
      id: 'firebase-rules-not-in-repo',
      severity: 'info',
      area: 'security',
      title: 'Firebase data is used, but its security rules are not in the repository',
      detail: 'Open database or storage rules are the most common way mobile app data leaks, and NativeKeel cannot see rules that live only in the Firebase console. Review them there (no "if true", no root-level "auth != null"), or keep them in the repo (firebase init) so they are reviewed and checked.',
    });
  }
  return findings;
}

function rulesFinding(id, severity, title, detail, step) {
  return { id, severity, area: 'security', title, detail, fix: { kind: 'security', step } };
}

// Line numbers of an unconditional write anywhere, and of an unconditional read in a match that
// is only a recursive wildcard (/{document=**}). Public reads of specific paths can be intentional.
function scanAllowRules(text) {
  const lines = text.split('\n');
  const stack = []; // match paths of the open blocks
  let openWrite = 0;
  let openReadAll = 0;
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    const m = code.match(/match\s+(\S+)\s*\{/);
    if (m) stack.push(m[1]);
    const allow = code.match(/allow\s+([\w,\s]+?)\s*(?::\s*if\s+(.+?))?\s*;/);
    if (allow) {
      const unconditional = !allow[2] || /^true$/.test(allow[2].trim());
      const ops = allow[1];
      if (unconditional && /\b(write|create|update|delete)\b/.test(ops)) openWrite = openWrite || i + 1;
      if (unconditional && /\b(read|get|list)\b/.test(ops) && /^\/\{[^}]*=\*\*\}$/.test(stack.at(-1) || '')) openReadAll = openReadAll || i + 1;
    }
    const closes = (code.match(/\}/g) || []).length - (code.match(/\{/g) || []).length;
    for (let k = 0; k < closes && stack.length; k++) stack.pop();
  });
  return { openWrite, openReadAll };
}

// Native code that turns off TLS certificate checks: anyone on the same Wi-Fi can read and
// change the app's HTTPS traffic (MASVS-NETWORK-1).
export function insecureTls(root) {
  const files = [];
  const collect = (dir, exts) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['Pods', 'build', 'node_modules', '.gradle', 'DerivedData', 'test', 'androidTest'].includes(e.name) && !/Tests?$/.test(e.name)) collect(full, exts);
      } else if (exts.test(e.name)) {
        files.push(full);
      }
    }
  };
  collect(path.join(root, 'android'), /\.(java|kt)$/);
  collect(path.join(root, 'ios'), /\.(m|mm|swift)$/);
  const PATTERNS = [
    { re: /checkServerTrusted\s*\([^)]*\)\s*(?:throws[^{]*)?(?::\s*Unit\s*)?\{\s*\}/, what: 'a TrustManager whose checkServerTrusted accepts every certificate' },
    { re: /(?:ALLOW_ALL_HOSTNAME_VERIFIER|NoopHostnameVerifier|AllowAllHostnameVerifier)|verify\s*\(\s*\w+\s*:?\s*String\??[^)]*\)\s*(?::\s*Boolean\s*)?(?:\{\s*return\s+true\s*;?\s*\}|=\s*true)|hostnameVerifier\s*\{\s*_\s*,\s*_\s*->\s*true\s*\}/, what: 'a hostname verifier that accepts every host' },
    { re: /onReceivedSslError[\s\S]{0,300}?\.proceed\s*\(\s*\)/, what: 'a WebView that proceeds on SSL errors' },
    { re: /allowsAnyHTTPSCertificateForHost|setAllowsAnyHTTPSCertificate/, what: 'an iOS API that accepts any HTTPS certificate' },
  ];
  const hits = [];
  let trustyCache = null;
  const blobTrusty = () => {
    if (trustyCache) return trustyCache;
    const values = [];
    for (const jf of jsFiles(root)) {
      const t = read(jf);
      if (t && t.includes('trusty')) for (const m of t.matchAll(/\btrusty\s*:\s*([^,}\n]+)/g)) values.push(m[1].trim());
    }
    trustyCache = !values.length ? 'unused' : values.some((v) => v === 'true') ? 'always' : 'setting';
    return trustyCache;
  };
  // A setting like "ignore TLS errors" or "trust self-signed" anywhere in the native code: the
  // bypass is often defined in one file and switched on from another.
  const optInSetting = /(?:ignore\w*(?:ssl|tls|cert)\w*|trustSelfSigned|allowSelfSigned|selfSignedCert)/i;
  const projectOptIn = files.some((f) => optInSetting.test(read(f)));
  for (const f of files) {
    const text = read(f);
    if (!text) continue;
    // A bypass behind a setting (trust a self-signed home server, an "ignore TLS errors" switch)
    // is an opt-in feature: still worth reviewing, but not the same as trusting everything.
    const OPT_IN = /\bif\s*\(?[^\n]*(?:validate|verif|trust|self.?signed|ignore\w*(?:ssl|tls|cert)|insecure|allowInvalid|acceptInvalid|unsafe)/i;
    const optIn = (index) => {
      const before = text.slice(Math.max(0, index - 1200), index).split('\n').slice(-25).join('\n');
      return OPT_IN.test(before) || projectOptIn || blobTrusty() === 'setting';
    };
    // react-native-blob-util's sharedTrustManager is used only for requests made with
    // `trusty: …`: never used, it changes nothing; tied to a setting, it is an opt-in.
    if (/(?:ReactNativeBlobUtilUtils|RNFetchBlobUtils)\.sharedTrustManager/.test(text) && blobTrusty() === 'unused') continue;
    for (const p of PATTERNS) {
      const m = text.match(p.re);
      if (m) hits.push({ file: path.relative(root, f), line: text.slice(0, m.index).split('\n').length, what: p.what, optIn: optIn(m.index) });
    }
    // iOS: answering a server-trust challenge with the server's own trust, without evaluating it.
    if (/\.(m|mm|swift)$/.test(f) && /(?:URLCredential\(\s*trust:|credentialForTrust:)/.test(text) && !/SecTrustEvaluate|SecTrustEvaluateWithError|evaluate\(/.test(text)) {
      const idx = text.search(/URLCredential\(\s*trust:|credentialForTrust:/);
      hits.push({ file: path.relative(root, f), line: text.slice(0, idx).split('\n').length, what: 'a URL session that trusts the server certificate without evaluating it', optIn: optIn(idx) });
    }
  }
  const findings = hits.map((h) =>
    h.optIn
      ? {
          id: `insecure-tls:${h.file}`,
          severity: 'high',
          area: 'security',
          title: `TLS certificate checks can be switched off (${h.file}:${h.line})`,
          detail: `This file has ${h.what}, behind a setting (it looks like an opt-in for self-signed or self-hosted servers). While it is on, anyone on the same network can read and change that traffic. Keep it off by default, limit it to the one server the user chose (or pin that server's certificate), and say so clearly in the UI. (OWASP MASVS-NETWORK-1)`,
          fix: { kind: 'security', step: `Review the certificate bypass in \`${h.file}:${h.line}\`: off by default, limited to the user's own server, ideally certificate pinning instead.` },
        }
      : {
          id: `insecure-tls:${h.file}`,
          severity: 'critical',
          area: 'security',
          title: `TLS certificate checks are turned off (${h.file}:${h.line})`,
          detail: `This file has ${h.what}, with no setting around it. Anyone on the same network (public Wi-Fi, a compromised router) can read and change the app's HTTPS traffic, including logins and tokens. Remove it; for a self-signed development server, use a debug-only network security config instead. (OWASP MASVS-NETWORK-1)`,
          fix: { kind: 'security', step: `Remove the certificate bypass in \`${h.file}:${h.line}\` (${h.what}).` },
        },
  );

  // Release builds that trust user-installed certificates: a classic interception setup.
  const xmlDir = path.join(root, 'android', 'app', 'src', 'main', 'res', 'xml');
  let xmls = [];
  try {
    xmls = fs.readdirSync(xmlDir).filter((f) => f.endsWith('.xml'));
  } catch {
    // no res/xml
  }
  for (const x of xmls) {
    const text = read(path.join(xmlDir, x)).replace(/<debug-overrides>[\s\S]*?<\/debug-overrides>/g, '');
    if (/<network-security-config/.test(text) && /<certificates\s+src\s*=\s*"user"/.test(text)) {
      findings.push({
        id: `user-certificates:${x}`,
        severity: 'low',
        area: 'security',
        title: `Release builds trust user-installed certificates (res/xml/${x})`,
        detail: 'A certificate the user (or malware, or a device profile) installs can intercept the app\'s HTTPS traffic. Apps for company servers with a private CA sometimes need this; otherwise keep <certificates src="user"/> inside <debug-overrides> only. (OWASP MASVS-NETWORK-1)',
        fix: { kind: 'security', step: `In \`android/app/src/main/res/xml/${x}\`, move \`<certificates src="user"/>\` into \`<debug-overrides>\`.` },
      });
    }
  }
  return findings;
}

// Cryptography that looks like protection but is not (MASVS-CRYPTO-1/2), and session tokens in
// unencrypted storage (MASVS-STORAGE-1).
const CRYPTO_RULES = [
  { id: 'hardcoded-key', re: /\b(?:CryptoJS\.(?:AES|DES|TripleDES|Rabbit|RC4)\.(?:encrypt|decrypt)\s*\([^,()]+,\s*['"`][^'"`]{4,}['"`]|createCipheriv\s*\(\s*['"][^'"]+['"]\s*,\s*['"`][^'"`]{4,}['"`])/, severity: 'high', title: 'Encryption key hardcoded in the app', detail: 'The key is a string in the JavaScript bundle, so anyone can extract it and decrypt the data. Derive keys per user (e.g. from the Keychain/Keystore) or keep encryption on the server.' },
  { id: 'weak-password-hash', re: /\b(?:md5|sha1|MD5|SHA1)\s*\(\s*[^)]*\bpass(?:word|wd)?\b/i, severity: 'high', title: 'Password hashed with MD5 or SHA-1', detail: 'MD5 and SHA-1 are fast and broken for passwords: anyone who captures the hash cracks it in minutes. To store or verify passwords, let the server use bcrypt, scrypt or Argon2; to derive an encryption key from a password, use PBKDF2, scrypt or Argon2; if a server protocol forces it, prefer that server\'s token or API-key login.' },
  { id: 'ecb-mode', re: /CryptoJS\.mode\.ECB|['"]aes-\d+-ecb['"]/i, severity: 'medium', title: 'Encryption in ECB mode', detail: 'ECB encrypts equal blocks to equal output, so patterns in the data stay visible. Use an authenticated mode such as AES-GCM.' },
  { id: 'insecure-random', re: /\b(?:nonce|secret|otp|salt|password|passcode|apikey|api_key|csrf|verifier|pkce)\w*\s*[=:]\s*[^;\n]*Math\.random\s*\(/i, severity: 'medium', title: 'Math.random used for a security value', detail: 'Math.random is predictable. Use crypto.getRandomValues (react-native-get-random-values or expo-crypto) for tokens, nonces, salts and codes.' },
];

export function weakCrypto(root) {
  const byRule = new Map();
  for (const file of jsFiles(root)) {
    const text = read(file);
    if (!text || !/CryptoJS|createCipheriv|md5|sha1|MD5|SHA1|Math\.random/.test(text)) continue;
    // Comments describing an algorithm are not code.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
    const lines = text.split('\n');
    for (const rule of CRYPTO_RULES) {
      // A nonce in a mock or dummy server response (Edge: "// Dummy response") protects nothing.
      const m = [...code.matchAll(new RegExp(rule.re.source, rule.re.flags.replace('g', '') + 'g'))].find((x) => {
        if (rule.id !== 'insecure-random') return true;
        const line = code.slice(0, x.index).split('\n').length;
        return !/\b(?:dummy|mock|fake|stub)/i.test(lines.slice(Math.max(0, line - 6), line).join('\n'));
      });
      if (m && !byRule.has(rule.id)) {
        // The Subsonic API (Navidrome, Airsonic) defines its login token as md5(password + salt):
        // the app cannot choose, so it is worth knowing, not an app bug.
        const protocol = rule.id === 'weak-password-hash' && /subsonic/i.test(text);
        byRule.set(rule.id, { rule, protocol, where: `${path.relative(root, file)}:${code.slice(0, m.index).split('\n').length}` });
      }
    }
  }
  return [...byRule.values()].map(({ rule, where, protocol }) => ({
    id: `crypto-${rule.id}`,
    severity: protocol ? 'low' : rule.severity,
    area: 'security',
    title: `${rule.title} (${where})${protocol ? ', required by the Subsonic API' : ''}`,
    detail: protocol
      ? 'The Subsonic API defines its token as md5(password + salt), so the app has no choice here. Anyone who captures a request can try to crack the password from it: use HTTPS only, and the server\'s API-key login if it offers one. (OWASP MASVS-CRYPTO)'
      : `${rule.detail} (OWASP MASVS-CRYPTO)`,
    fix: { kind: 'security', step: `${rule.title} at \`${where}\`: ${rule.detail.split('. ').slice(-1)[0]}` },
  }));
}

// Auth tokens written to AsyncStorage: on a rooted/jailbroken device, or from a backup, they
// can be read and reused to act as the user.
export function tokenStorage(root) {
  const hits = [];
  for (const file of jsFiles(root)) {
    // Web-only files (keychain.web.ts) have no Keychain to use; the mobile file decides.
    if (/\.web\.[cm]?[jt]sx?$/.test(file)) continue;
    const text = read(file);
    if (!text || !/AsyncStorage|MMKV/.test(text)) continue;
    const at = (i) => `${path.relative(root, file)}:${text.slice(0, i).split('\n').length}`;
    const seen = new Set();
    // By key name: setItem('access_token', …)
    for (const m of text.matchAll(/\b(?:AsyncStorage\.setItem|storage\.set|mmkv\.set)\s*\(\s*['"`@]?([\w@.\-:]*?(?:access_?token|refresh_?token|auth_?token|id_?token|jwt|session_?token|bearer)[\w.\-:]*)['"`]?\s*,/gi)) {
      seen.add(m.index);
      hits.push(`${m[1]} (${at(m.index)})`);
    }
    // By value: setItem(TOKEN_KEY, token), setItem('user', JSON.stringify({ token })). Push
    // notification and device tokens are not secrets.
    for (const m of text.matchAll(/\b(?:AsyncStorage\.setItem|(?:storage|mmkv)\.set(?:String)?)\s*\(\s*([^,()]{1,60}),\s*([^;\n]{0,120})/g)) {
      if (seen.has(m.index)) continue;
      if (!/\b(?:access_?token|refresh_?token|auth_?token|id_?token|session_?token|login_?token|accessToken|refreshToken|authToken|idToken|sessionToken|loginToken|jwt|token)\b/i.test(m[2])) continue;
      if (/push|fcm|apns|expo_?push|notif|device|firebase|messaging/i.test(m[1] + m[2])) continue;
      hits.push(`${m[1].trim()} (${at(m.index)})`);
    }
  }
  if (!hits.length) return [];
  return [
    {
      id: 'token-unencrypted-storage',
      severity: 'low',
      area: 'security',
      title: `Auth token${hits.length === 1 ? '' : 's'} stored without encryption`,
      detail: `${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ', …' : ''}. AsyncStorage (and unencrypted MMKV) is plain files: backups and rooted devices expose them, and a copied token signs in as the user. Keep tokens in the Keychain/Keystore (react-native-keychain, expo-secure-store). (OWASP MASVS-STORAGE-1)`,
      fix: { kind: 'security', step: 'Move auth tokens from AsyncStorage to the Keychain/Keystore (`react-native-keychain` or `expo-secure-store`).' },
    },
  ];
}

// OWASP MASVS control group of a security finding, by id. Shown in reports so a security
// reviewer can map findings to the standard they audit against.
export const MASVS_GROUPS = {
  STORAGE: 'Data on the device',
  CRYPTO: 'Keys and cryptography',
  AUTH: 'Access control (backend rules)',
  NETWORK: 'Network traffic',
  PLATFORM: 'WebViews and platform interaction',
  CODE: 'Dependencies and build',
  RESILIENCE: 'Reverse engineering',
};

export function masvsOf(id) {
  if (/^(secret:|env-bundled|crypto-|expo-secret|ai-key-)/.test(id)) return 'CRYPTO';
  if (/^(password-leak|token-unencrypted|android-allow-backup)/.test(id)) return 'STORAGE';
  if (/^(insecure-tls|user-certificates|plain-http|ios-ats|android-cleartext)/.test(id)) return 'NETWORK';
  if (/^(webview-|android-exported|deeplink-)/.test(id)) return 'PLATFORM';
  if (/^(firebase-|supabase-)/.test(id)) return 'AUTH';
  if (/^(vuln:|signing-|android-debuggable)/.test(id)) return 'CODE';
  if (/^(sourcemap-in-app|easy-reverse-engineering)/.test(id)) return 'RESILIENCE';
  return null;
}

// How easily the shipped app reads back as source (MASVS-RESILIENCE). React Native JavaScript is
// recoverable from any APK/IPA; Hermes bytecode and R8 only slow that down. The real defence is
// keeping secrets and trust decisions off the device, so this is advice, not an alarm.
export function reverseEngineering(root, project) {
  const findings = [];
  // Source maps packaged into the app give back the original code, names and comments.
  const mapDirs = [path.join(root, 'android', 'app', 'src', 'main', 'assets'), path.join(root, 'ios')];
  const maps = [];
  const scan = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && depth < 3 && !['Pods', 'build', 'DerivedData'].includes(e.name)) scan(path.join(dir, e.name), depth + 1);
      else if (/\.(?:bundle|jsbundle|hbc)\.map$|^index\.android\.bundle\.map$|^main\.jsbundle\.map$/.test(e.name)) maps.push(path.relative(root, path.join(dir, e.name)));
    }
  };
  for (const d of mapDirs) scan(d, 0);
  if (maps.length) {
    findings.push({
      id: 'sourcemap-in-app',
      severity: 'high',
      area: 'security',
      title: `A source map is packaged into the app (${maps[0]})`,
      detail: 'Anyone who unzips the APK/IPA gets your original JavaScript with names and comments. Upload source maps to your crash reporter instead, and keep them out of the app folders. (OWASP MASVS-RESILIENCE)',
      fix: { kind: 'security', step: `Remove \`${maps[0]}\` from the app sources (and from git), and upload source maps to the crash reporter instead.` },
    });
  }

  const gradle = read(path.join(root, 'android', 'app', 'build.gradle')) || read(path.join(root, 'android', 'app', 'build.gradle.kts')) || '';
  const props = read(path.join(root, 'android', 'gradle.properties')) || '';
  const r8Off = gradle && (/enableProguardInReleaseBuilds\s*=\s*false/.test(gradle) || /release\s*\{[^}]*minifyEnabled\s*\(?\s*false/.test(gradle));
  const hermesOff = /^\s*hermesEnabled\s*=\s*false/m.test(props) || /hermes_enabled\s*=>\s*false/.test(read(path.join(root, 'ios', 'Podfile')) || '');
  const factors = [hermesOff && 'Hermes is off, so the JavaScript ships as readable text', r8Off && 'R8/ProGuard is off, so Java/Kotlin class and method names stay readable'].filter(Boolean);
  if (factors.length && !project.managed) {
    findings.push({
      id: 'easy-reverse-engineering',
      severity: 'low',
      area: 'security',
      title: 'The release build is easy to read back',
      detail: `${factors.join('; ')}. Any React Native app can be unpacked, and obfuscation only slows that down, so never rely on it: keep secrets and checks that matter (prices, entitlements, admin flags) on the server. Turning these on is still cheap. (OWASP MASVS-RESILIENCE)`,
      fix: { kind: 'security', step: `${hermesOff ? 'Turn on Hermes. ' : ''}${r8Off ? 'Set `enableProguardInReleaseBuilds = true` in `android/app/build.gradle` and test a release build (add keep rules for libraries that need them). ' : ''}Keep secrets and trust decisions on the server.` },
    });
  }
  return findings;
}

// Secrets in Expo config: app.json/app.config `extra` ships inside the app (Constants.expoConfig),
// EXPO_PUBLIC_ variables are compiled into the bundle, and eas.json build env is committed.
// Names alone decide; many SDK "API keys" are public by design, so those are left alone.
const SECRET_NAME = /(?:secret|private|password|passwd|auth[_-]?token|access[_-]?token|refresh[_-]?token|access[_-]?key|service[_-]?role|admin[_-]?key|token$)/i;
const maskValue = (v) => (v.length <= 8 ? '****' : `${v.slice(0, 4)}…${v.slice(-2)}`);

export function expoConfigSecrets(root) {
  const findings = [];
  const shipped = [];
  const committed = [];
  const looksReal = (v) => typeof v === 'string' && v.length >= 12 && !/^\$\{|^process\.env|example|placeholder|your[_-]|xxx|changeme|<.*>/i.test(v);

  let app = null;
  try {
    app = JSON.parse(read(path.join(root, 'app.json')) || 'null');
  } catch {
    // not JSON
  }
  const extra = (app && (app.expo || app).extra) || {};
  for (const [k, v] of Object.entries(extra)) if (SECRET_NAME.test(k) && looksReal(v)) shipped.push({ where: `app.json extra.${k}`, value: v });
  for (const f of ['app.config.js', 'app.config.ts']) {
    const text = read(path.join(root, f));
    const block = text && text.match(/\bextra\s*:\s*\{([\s\S]*?)\n\s*\}/);
    if (!block) continue;
    for (const m of block[1].matchAll(/([A-Za-z_][\w]*)\s*:\s*['"`]([^'"`\n]{12,})['"`]/g)) {
      if (SECRET_NAME.test(m[1]) && looksReal(m[2])) shipped.push({ where: `${f} extra.${m[1]}`, value: m[2] });
    }
  }
  let eas = null;
  try {
    eas = JSON.parse(read(path.join(root, 'eas.json')) || 'null');
  } catch {
    // not JSON
  }
  for (const [profile, cfg] of Object.entries((eas && eas.build) || {})) {
    for (const [k, v] of Object.entries((cfg && cfg.env) || {})) {
      if (!SECRET_NAME.test(k) || !looksReal(v)) continue;
      if (k.startsWith('EXPO_PUBLIC_')) shipped.push({ where: `eas.json build.${profile}.env.${k}`, value: v });
      else committed.push({ where: `eas.json build.${profile}.env.${k}`, value: v });
    }
  }
  if (shipped.length) {
    findings.push({
      id: 'expo-secret-shipped',
      severity: 'high',
      area: 'security',
      title: `Secret-looking value${shipped.length === 1 ? '' : 's'} shipped inside the app via Expo config (${shipped[0].where})`,
      detail: `${shipped.map((s) => `${s.where} = ${maskValue(s.value)}`).slice(0, 3).join('; ')}. Expo \`extra\` is readable from the app manifest and EXPO_PUBLIC_ variables are compiled into the bundle, so anyone with the app can read them. Revoke them and move the calls that need them to a server. (OWASP MASVS-CRYPTO)`,
      fix: { kind: 'secret', label: 'Secret in Expo config', file: shipped[0].where.split(' ')[0], line: 1, bundled: true },
    });
  }
  if (committed.length) {
    findings.push({
      id: 'expo-secret-committed',
      severity: 'high',
      area: 'security',
      title: `Secret committed in eas.json (${committed[0].where})`,
      detail: `${committed.map((s) => `${s.where} = ${maskValue(s.value)}`).slice(0, 3).join('; ')}. Everyone with repository access can use it (a Sentry auth token, for example, can read and change your Sentry organisation). Rotate it and store it as an EAS secret (\`eas env:create\`) instead. (OWASP MASVS-CRYPTO)`,
      fix: { kind: 'secret', label: 'Secret in eas.json', file: 'eas.json', line: 1, bundled: false },
    });
  }
  return findings;
}

// AI provider keys read by app code from build-time variables. EXPO_PUBLIC_ variables,
// react-native-config and react-native-dotenv inline the value into the JavaScript bundle, so
// the key ships even though .env is not committed: anyone who unpacks the app can bill
// requests to it. The variable name is enough; the value never needs to be in the repository.
const AI_PROVIDERS = [
  ['OPENAI', 'OpenAI', /api\.openai\.com/],
  ['ANTHROPIC|CLAUDE', 'Anthropic', /api\.anthropic\.com/],
  ['GEMINI|GOOGLE_AI|GOOGLE_GENAI|GENAI', 'Google Gemini', /generativelanguage\.googleapis\.com|@google\/gen(?:erative-)?ai/],
  ['GROQ', 'Groq', /api\.groq\.com/],
  ['MISTRAL', 'Mistral', /api\.mistral\.ai/],
  ['DEEPSEEK', 'DeepSeek', /api\.deepseek\.com/],
  ['OPENROUTER', 'OpenRouter', /openrouter\.ai\/api/],
  ['XAI|GROK', 'xAI', /api\.x\.ai/],
  ['REPLICATE', 'Replicate', /api\.replicate\.com/],
  ['ELEVENLABS|ELEVEN_LABS', 'ElevenLabs', /api\.elevenlabs\.io/],
  ['PERPLEXITY', 'Perplexity', /api\.perplexity\.ai/],
  ['COHERE', 'Cohere', /api\.cohere\.(?:ai|com)/],
  ['DEEPGRAM', 'Deepgram', /api\.deepgram\.com/],
  ['ASSEMBLYAI', 'AssemblyAI', /api\.assemblyai\.com/],
  ['FAL', 'fal.ai', /fal\.run|fal\.ai/],
];
const AI_NAME = new RegExp(`^[A-Z0-9_]*?(?:^|_)(${AI_PROVIDERS.map((p) => p[0]).join('|')})(?:_[A-Z0-9_]*)?_(?:API_)?(?:KEY|TOKEN|SECRET)$`);
const AI_SERVER_DIRS = /^(?:functions|server|backend|api|cloud-functions|scripts|supabase|convex|worker|workers)(?:\/|$)|(?:^|\/)app\/api\/|\+api\.[jt]sx?$/;

export function aiKeysInBundle(root, deps = {}) {
  const expo = !!deps.expo;
  const ways = [
    expo && [/process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g, 'EXPO_PUBLIC_ variables are compiled into the JavaScript bundle'],
    deps['react-native-config'] && [/\bConfig\.([A-Z0-9_]+)/g, 'react-native-config compiles its values into the app'],
    (deps['react-native-dotenv'] || deps['module:react-native-dotenv']) && [/import\s*\{([^}]+)\}\s*from\s*['"](?:@env|react-native-dotenv)['"]/g, 'react-native-dotenv inlines its values into the JavaScript bundle'],
  ].filter(Boolean);
  if (!ways.length) return [];
  const byProvider = new Map();
  for (const file of jsFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (AI_SERVER_DIRS.test(rel)) continue;
    const text = read(file);
    if (!text || !/KEY|TOKEN|SECRET/.test(text)) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const [re, how] of ways) {
      for (const m of code.matchAll(re)) {
        for (const name of m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].replace(/^EXPO_PUBLIC_/, ''))) {
          const hit = name.match(AI_NAME);
          if (!hit) continue;
          const provider = AI_PROVIDERS.find((p) => new RegExp(`^(?:${p[0]})$`).test(hit[1]));
          if (!provider || byProvider.has(provider[1])) continue;
          const full = m[0].startsWith('process.env.') ? m[1] : m[0].startsWith('Config.') ? `Config.${name}` : name;
          byProvider.set(provider[1], { provider, name: full, how, where: `${rel}:${code.slice(0, m.index).split('\n').length}` });
        }
      }
    }
  }
  if (!byProvider.size) return [];
  // Direct calls from the app to the provider confirm the key is used on the device.
  const direct = new Set();
  for (const file of jsFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (AI_SERVER_DIRS.test(rel)) continue;
    const text = read(file) || '';
    for (const { provider } of byProvider.values()) if (provider[2].test(text)) direct.add(provider[1]);
  }
  return [...byProvider.values()].map(({ provider, name, how, where }) => ({
    id: `ai-key-in-bundle:${provider[1]}`,
    severity: 'high',
    area: 'security',
    title: `${provider[1]} API key ships inside the app (${where})`,
    detail: `The app reads ${name}, and ${how}${direct.has(provider[1]) ? `; the app also calls ${provider[1]} directly` : ''}. Anyone who unpacks the app gets the key and can run requests on your bill (AI keys are a favourite target of bundle scrapers). Move the ${provider[1]} call to a server you control (an Expo API route, a Firebase or Supabase function) that holds the key and checks who is calling, then revoke the current key. (OWASP MASVS-CRYPTO-2)`,
    fix: { kind: 'security', step: `Move the ${provider[1]} call (${where}) behind your own server endpoint that keeps the key, then revoke the key that shipped.` },
  }));
}

// Deep links (MASVS-PLATFORM). A web link (https://your.domain/...) opens the app only when the
// domain is verified (autoVerify + assetlinks.json); without it Android 12+ opens the browser,
// and older Android lets any app that registers the same link receive it. Custom URL schemes can
// be registered by any app, so the template scheme "myapp" is shared with every other app that
// kept it, and an OAuth redirect to it can land in the wrong app.
const TEMPLATE_SCHEMES = new Set(['myapp', 'my-app', 'myscheme', 'your-app-scheme', 'yourappscheme']);
const SENSITIVE_LINK = /auth|login|signin|sign-in|reset|verify|magic|invite|oauth|callback|token/i;
const OAUTH_DEPS = ['expo-auth-session', '@clerk/clerk-expo', 'react-native-app-auth', '@react-native-community/oauth', 'react-native-auth0'];

export function deepLinks(root, deps = {}) {
  const findings = [];
  const unverified = new Map(); // host -> sensitive?
  const schemes = new Set();
  const realHost = (h) => h && !/[*$@{]/.test(h) && h.includes('.') && !/^(?:localhost|127\.|10\.|192\.168\.)/.test(h);

  // autoVerify on any one filter makes Android verify every web host in the manifest.
  const manifest = read(path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')) || '';
  const anyVerified = /<intent-filter\b[^>]*android:autoVerify\s*=\s*"true"/.test(manifest);
  for (const m of manifest.matchAll(/<intent-filter\b([^>]*)>([\s\S]*?)<\/intent-filter>/g)) {
    const body = m[2];
    if (!/android\.intent\.category\.BROWSABLE/.test(body)) continue;
    const found = [...body.matchAll(/android:scheme\s*=\s*"([^"]+)"/g)].map((x) => x[1]);
    for (const s of found) if (!/^https?$/.test(s)) schemes.add(s.toLowerCase());
    if (anyVerified || !found.some((s) => /^https?$/.test(s))) continue;
    const paths = [...body.matchAll(/android:path(?:Prefix|Pattern)?\s*=\s*"([^"]+)"/g)].map((x) => x[1]).join(' ');
    for (const h of body.matchAll(/android:host\s*=\s*"([^"]+)"/g)) {
      if (realHost(h[1])) unverified.set(h[1], unverified.get(h[1]) || SENSITIVE_LINK.test(`${h[1]} ${paths}`));
    }
  }

  let app = null;
  try {
    app = JSON.parse(read(path.join(root, 'app.json')) || 'null');
  } catch {
    // not JSON
  }
  const expo = (app && (app.expo || app)) || {};
  for (const s of [].concat(expo.scheme || [])) if (typeof s === 'string') schemes.add(s.toLowerCase());
  for (const f of ['app.config.js', 'app.config.ts']) {
    const text = read(path.join(root, f)) || '';
    for (const m of text.matchAll(/\bscheme\s*:\s*['"`]([\w.+-]+)['"`]/g)) schemes.add(m[1].toLowerCase());
  }
  const expoFilters = (expo.android && expo.android.intentFilters) || [];
  for (const filter of expoFilters.some((f) => f && f.autoVerify) ? [] : expoFilters) {
    if (!filter || ![].concat(filter.category || []).includes('BROWSABLE')) continue;
    for (const d of [].concat(filter.data || [])) {
      if (d && /^https?$/.test(d.scheme || '') && realHost(d.host)) {
        unverified.set(d.host, unverified.get(d.host) || SENSITIVE_LINK.test(`${d.host} ${d.pathPrefix || ''} ${d.path || ''} ${d.pathPattern || ''}`));
      }
    }
  }
  let iosDirs = [];
  try {
    iosDirs = fs.readdirSync(path.join(root, 'ios'), { withFileTypes: true }).filter((e) => e.isDirectory() && !/^(?:Pods|build)$|Tests$|\.xc/.test(e.name));
  } catch {
    // no ios folder
  }
  for (const d of iosDirs) {
    const plist = read(path.join(root, 'ios', d.name, 'Info.plist')) || '';
    for (const block of plist.match(/<key>CFBundleURLSchemes<\/key>\s*<array>[\s\S]*?<\/array>/g) || []) {
      for (const s of block.matchAll(/<string>([^<$]+)<\/string>/g)) schemes.add(s[1].toLowerCase());
    }
  }

  if (unverified.size) {
    const hosts = [...unverified.keys()];
    const sensitive = hosts.filter((h) => unverified.get(h));
    findings.push({
      id: 'deeplink-unverified',
      severity: sensitive.length ? 'medium' : 'low',
      area: 'security',
      title: `Web links to ${hosts.slice(0, 2).join(', ')}${hosts.length > 2 ? ` and ${hosts.length - 2} more` : ''} are not verified (no autoVerify)`,
      detail: `On Android 12+ these links open in the browser instead of the app, and on older Android any installed app that registers the same links can receive them${sensitive.length ? ', including the login/reset/invite links that carry tokens' : ''}. For domains you own, add android:autoVerify="true" to the intent filter and publish /.well-known/assetlinks.json with your signing certificate. (OWASP MASVS-PLATFORM)`,
      fix: { kind: 'security', step: `Add \`android:autoVerify="true"\` to the https intent filters for ${hosts.slice(0, 3).map((h) => `\`${h}\``).join(', ')} and serve \`https://${hosts[0]}/.well-known/assetlinks.json\`.` },
    });
  }
  const template = [...schemes].filter((s) => TEMPLATE_SCHEMES.has(s));
  if (template.length) {
    const oauth = OAUTH_DEPS.filter((d) => deps[d]);
    findings.push({
      id: 'deeplink-template-scheme',
      severity: oauth.length ? 'medium' : 'low',
      area: 'security',
      title: `The app still uses the template URL scheme "${template[0]}://"`,
      detail: `Many other apps kept the same scheme, so ${template[0]}:// links can open a different app${oauth.length ? `, and the sign-in redirect of ${oauth.join(', ')} can be delivered to it` : ''}. Pick a scheme unique to your app (for example your bundle identifier). (OWASP MASVS-PLATFORM)`,
      fix: { kind: 'security', step: `Replace the "${template[0]}" scheme with one unique to the app (app.json \`scheme\`, AndroidManifest and Info.plist), and update redirect URIs registered with your sign-in providers.` },
    });
  }
  return findings;
}

// Supabase (MASVS-AUTH). The anon key ships in every copy of the app, so a table in the public
// schema without row level security can be read and written by anyone through the REST API.
// Only migrations under a supabase/ folder count: other SQL may target another database.
export function supabaseRls(root) {
  const repo = (() => {
    let d = root;
    for (let i = 0; i < 4 && !fs.existsSync(path.join(d, '.git')); i++) d = path.dirname(d);
    return fs.existsSync(path.join(d, '.git')) ? d : root;
  })();
  const sqlFiles = [];
  const walkSql = (dir, depth, inSupabase) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 6 && !['node_modules', '.git', 'Pods', 'build', 'dist'].includes(e.name)) walkSql(p, depth + 1, inSupabase || e.name === 'supabase');
      } else if (inSupabase && e.name.endsWith('.sql') && !/seed/i.test(e.name)) sqlFiles.push(p);
    }
  };
  walkSql(repo, 0, false);
  if (!sqlFiles.length) return [];
  const sql = sqlFiles.map((f) => read(f) || '').join('\n').replace(/--[^\n]*/g, '');
  // RLS switched on for every table in a loop (format('alter table %I.%I enable …')): trust it.
  if (/enable row level security/i.test(sql) && /%I/.test(sql)) return [];
  const name = (q) => q.replace(/"/g, '').toLowerCase();
  const tables = new Map();
  for (const m of sql.matchAll(/create table\s+(?:if not exists\s+)?((?:"?public"?\.)?"?\w+"?)\s*\(/gi)) {
    const t = name(m[1]).replace(/^public\./, '');
    if (!tables.has(t)) tables.set(t, path.relative(repo, sqlFiles.find((f) => (read(f) || '').includes(m[1])) || sqlFiles[0]));
  }
  const rls = new Set([...sql.matchAll(/alter table\s+(?:if exists\s+)?(?:only\s+)?((?:"?public"?\.)?"?\w+"?)\s+enable row level security/gi)].map((m) => name(m[1]).replace(/^public\./, '')));
  for (const m of sql.matchAll(/alter table\s+(?:if exists\s+)?(?:only\s+)?((?:"?public"?\.)?"?\w+"?)\s+disable row level security/gi)) rls.delete(name(m[1]).replace(/^public\./, ''));
  const open = [...tables].filter(([t]) => !rls.has(t));
  if (!open.length) return [];
  return [
    {
      id: 'supabase-rls-off',
      severity: 'high',
      area: 'security',
      title: `${open.length} Supabase table${open.length === 1 ? '' : 's'} without row level security (${open.slice(0, 3).map(([t]) => t).join(', ')}${open.length > 3 ? ', …' : ''})`,
      detail: `Created in ${[...new Set(open.map(([, f]) => f))].slice(0, 2).join(', ')} without \`enable row level security\`. The anon key ships inside every copy of the app, so unless RLS was switched on in the Supabase dashboard, anyone can read and change these tables through the REST API. Enable RLS and add policies for the access each table needs. (OWASP MASVS-AUTH)`,
      fix: { kind: 'security', step: `Add \`alter table public.<name> enable row level security;\` and policies for ${open.slice(0, 4).map(([t]) => `\`${t}\``).join(', ')} in a new migration, then check the Supabase dashboard (Table Editor → RLS) for tables created there.` },
    },
  ];
}

// Google Play restricts some permissions to apps whose core function needs them, behind a
// Play Console declaration (checked on the policy pages, October 2026). Declaring one without
// that leads to rejection or removal. Permissions removed with tools:node="remove" (to drop one a
// library adds) do not count.
const PLAY_RESTRICTED = {
  READ_MEDIA_IMAGES: { severity: 'high', why: 'Photo and video permissions: only apps whose core function needs broad access (galleries, editors). Others must use the system photo picker (expo-image-picker and react-native-image-picker use it without this permission). Enforced since 28 May 2025; apps can be removed.' },
  READ_MEDIA_VIDEO: { severity: 'high', why: 'Photo and video permissions: as READ_MEDIA_IMAGES.' },
  MANAGE_EXTERNAL_STORAGE: { severity: 'high', why: 'All files access: only file managers, backup, antivirus and document management apps, with an approved declaration.' },
  REQUEST_INSTALL_PACKAGES: { severity: 'high', why: 'Only for browsers, file managers, messaging with attachments, backup and enterprise apps, with a declaration.' },
  ACCESS_BACKGROUND_LOCATION: { severity: 'high', why: 'Needs a core feature that requires it, a Play Console declaration with a short video, and an in-app disclosure before the permission prompt; without approval updates can be blocked.' },
  READ_SMS: { severity: 'high', why: 'SMS and Call Log permissions are for default SMS/phone handler apps only.' },
  SEND_SMS: { severity: 'high', why: 'SMS and Call Log permissions are for default SMS/phone handler apps only.' },
  RECEIVE_SMS: { severity: 'high', why: 'SMS and Call Log permissions are for default SMS/phone handler apps only.' },
  READ_CALL_LOG: { severity: 'high', why: 'SMS and Call Log permissions are for default SMS/phone handler apps only.' },
  USE_FULL_SCREEN_INTENT: { severity: 'medium', why: 'Granted by default only to calling and alarm apps (since 22 January 2025 on Android 14+); others need a declaration and user consent.' },
  USE_EXACT_ALARM: { severity: 'medium', why: 'Only for alarm, timer and calendar apps; others should use SCHEDULE_EXACT_ALARM.' },
};

export function playRestrictedPermissions(root, deps = {}) {
  const declared = new Map();
  const manifest = read(path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')) || '';
  for (const m of manifest.matchAll(/<uses-permission(?:-sdk-23)?\b([^>]*)>/g)) {
    const perm = (m[1].match(/android:name\s*=\s*"android\.permission\.(\w+)"/) || [])[1];
    if (perm && PLAY_RESTRICTED[perm] && !/tools:node\s*=\s*"remove"/.test(m[1])) declared.set(perm, 'AndroidManifest.xml');
  }
  let app = null;
  try {
    app = JSON.parse(read(path.join(root, 'app.json')) || 'null');
  } catch {
    // not JSON
  }
  const android = (app && (app.expo || app).android) || {};
  const blocked = new Set((android.blockedPermissions || []).map((p) => String(p).replace(/^android\.permission\./, '')));
  for (const p of android.permissions || []) {
    const perm = String(p).replace(/^android\.permission\./, '');
    if (PLAY_RESTRICTED[perm] && !blocked.has(perm) && !declared.has(perm)) declared.set(perm, 'app.json');
  }
  for (const b of blocked) declared.delete(b);
  if (!declared.size) return [];
  const perms = [...declared.keys()];
  // Apps that need these usually filed the declaration already: medium, the developer decides.
  // Photo/video access next to a photo picker library is likely unneeded and risks removal: high.
  const picker = ['expo-image-picker', 'react-native-image-picker'].find((d) => deps[d]);
  const severity = picker && perms.some((p) => /^READ_MEDIA_/.test(p)) ? 'high' : 'medium';
  return [
    {
      id: 'play-restricted-permissions',
      severity,
      area: 'store',
      title: `Google Play restricts ${perms.length === 1 ? 'a permission' : `${perms.length} permissions`} this app declares (${perms.join(', ')})`,
      detail: `${perms.map((p) => `${p} (${declared.get(p)}): ${PLAY_RESTRICTED[p].why}`).join(' ')}${severity === 'high' ? ` The app already uses ${picker}, which works without photo/video permissions.` : ''} If the app does not need it, remove it (add it to \`blockedPermissions\` in Expo, or \`tools:node="remove"\` when a library adds it); if it does, complete the Permissions Declaration in Play Console before the next release.`,
      fix: { kind: 'play-permissions', step: `Remove ${perms.map((p) => `\`${p}\``).join(', ')} unless a core feature needs it, or file the Play Console permissions declaration.` },
    },
  ];
}
