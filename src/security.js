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
    } else if (JS_EXT.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
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
    // The endpoint answers for the versions we sent; double-check the range where it is simple.
    const relevant = list.filter((a) => applies(version, a.vulnerable_versions));
    if (!relevant.length) continue;
    const severity = relevant.map((a) => SEVERITY[a.severity] || 'low').sort((a, b) => RANK.indexOf(b) - RANK.indexOf(a))[0];
    const fixedIn = minimumFixed(relevant);
    const top = relevant
      .slice()
      .sort((a, b) => RANK.indexOf(SEVERITY[b.severity]) - RANK.indexOf(SEVERITY[a.severity]))
      .slice(0, 3)
      .map((a) => `${a.title}${a.url ? ` (${a.url})` : ''}`);
    findings.push({
      id: `vuln:${name}`,
      severity,
      area: 'security',
      title: `${name} ${version}: ${relevant.length} known vulnerabilit${relevant.length === 1 ? 'y' : 'ies'}`,
      detail: `${top.join('; ')}${relevant.length > 3 ? `; and ${relevant.length - 3} more` : ''}. ${fixedIn ? `Fixed in ${fixedIn} or later.` : 'Check the advisories for a fixed version.'}`,
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
