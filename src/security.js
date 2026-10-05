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

const SERVER_ONLY = /node\.?js|server[- ]side|\bhttp adapter\b|\bssr\b/i;
const SEVERITY = { critical: 'critical', high: 'high', moderate: 'medium', low: 'low', info: 'low' };
const RANK = ['low', 'medium', 'high', 'critical'];

// Advisories for the exact versions of runtime dependencies (devDependencies never ship).
export async function vulnerableDependencies(registry, versions) {
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
    const fixedIn = minimumFixed(relevant);
    const top = relevant
      .slice()
      .sort((a, b) => RANK.indexOf(sevOf(b)) - RANK.indexOf(sevOf(a)))
      .slice(0, 3)
      .map((a) => `${a.title}${a.url ? ` (${a.url})` : ''}`);
    findings.push({
      id: `vuln:${name}`,
      severity,
      area: 'security',
      title: `${name} ${version}: ${relevant.length} known vulnerabilit${relevant.length === 1 ? 'y' : 'ies'}`,
      detail: `${top.join('; ')}${relevant.length > 3 ? `; and ${relevant.length - 3} more` : ''}. ${fixedIn ? `Fixed in ${fixedIn} or later.` : 'Check the advisories for a fixed version.'}${serverOnly ? ` ${serverOnly} of them concern Node.js/server use only and are counted as low.` : ''} Source: GitHub Advisory Database (via npm).`,
      fix: { kind: 'vuln-dep', name, from: version, to: fixedIn, severity },
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

function minimumFixed(advisories) {
  let fixed = null;
  for (const a of advisories) {
    const bounds = [...String(a.vulnerable_versions || '').matchAll(/<\s*(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    if (!bounds.length) return null; // an advisory without a fixed version
    const hi = bounds.sort(compareVersions).at(-1);
    if (!fixed || compareVersions(hi, fixed) > 0) fixed = hi;
  }
  return fixed;
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
      findings.push({
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
      return OPT_IN.test(before) || projectOptIn;
    };
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
    for (const rule of CRYPTO_RULES) {
      const m = code.match(rule.re);
      if (m && !byRule.has(rule.id)) byRule.set(rule.id, { rule, where: `${path.relative(root, file)}:${code.slice(0, m.index).split('\n').length}` });
    }
  }
  return [...byRule.values()].map(({ rule, where }) => ({
    id: `crypto-${rule.id}`,
    severity: rule.severity,
    area: 'security',
    title: `${rule.title} (${where})`,
    detail: `${rule.detail} (OWASP MASVS-CRYPTO)`,
    fix: { kind: 'security', step: `${rule.title} at \`${where}\`: ${rule.detail.split('. ').slice(-1)[0]}` },
  }));
}

// Auth tokens written to AsyncStorage: on a rooted/jailbroken device, or from a backup, they
// can be read and reused to act as the user.
export function tokenStorage(root) {
  const hits = [];
  for (const file of jsFiles(root)) {
    const text = read(file);
    if (!text || !/AsyncStorage|MMKV/.test(text)) continue;
    for (const m of text.matchAll(/\b(?:AsyncStorage\.setItem|storage\.set|mmkv\.set)\s*\(\s*['"`@]?([\w@.\-:]*?(?:access_?token|refresh_?token|auth_?token|id_?token|jwt|session_?token|bearer)[\w.\-:]*)['"`]?\s*,/gi)) {
      hits.push(`${m[1]} (${path.relative(root, file)}:${text.slice(0, m.index).split('\n').length})`);
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
};

export function masvsOf(id) {
  if (/^(secret:|env-bundled|crypto-)/.test(id)) return 'CRYPTO';
  if (/^(password-leak|token-unencrypted|android-allow-backup)/.test(id)) return 'STORAGE';
  if (/^(insecure-tls|user-certificates|plain-http|ios-ats|android-cleartext)/.test(id)) return 'NETWORK';
  if (/^(webview-|android-exported)/.test(id)) return 'PLATFORM';
  if (/^firebase-/.test(id)) return 'AUTH';
  if (/^(vuln:|signing-|android-debuggable)/.test(id)) return 'CODE';
  return null;
}
