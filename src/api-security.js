import fs from './read-boundary.js';
import path from 'node:path';
import { sourceFiles } from './security-source.js';

// How the app talks to APIs, as far as the source shows it. Server-side authorization cannot be
// seen from here; these are the client-side mistakes that make it easy to abuse.

const SERVER = /^(?:server|backend|functions|api|scripts?|cli|tools|bin|supabase\/functions)\/|(?:^|\/)(?:__tests__|__mocks__|e2e|tests?)\/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$/;
const lineOf = (text, i) => text.slice(0, i).split('\n').length;
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

// A URL trusted after a text comparison. "https://api.example.com.attacker.dev" starts with
// "https://api.example.com"; "attacker.dev/?api.example.com" includes "api.example.com";
// "notexample.com" ends with "example.com". The same mistake disclosed Zulip users' credentials
// (CVE-2022-35962). Only comparisons against a literal address are reported.
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const LOCAL = /^(?:localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)|\.(?:local|test|invalid|localhost)$/i;
const FILE_EXT = /\.(?:html?|m?js|json|css|php|aspx?|dmg|exe|png|jpe?g|gif|svg|webp|mp3|mp4|m3u8|pdf|zip|apk|ipa|txt|xml)$/i;
const NOT_APP = /(?:^|\/)(?:web|nextjs|next|desktop|workers?|playwright|electron|capacitor|extension|bskyembed|website|docs?)\//i;
// The comparison matters only where it decides something about trust: an origin check, or code
// nearby that sends credentials, lets a WebView navigate, or acts on a link from outside.
const TRUST_CONTEXT = /onShouldStartLoadWithRequest|onNavigationStateChange|originWhitelist|onMessage|postMessage|injectJavaScript|Authorization|Bearer|access_?token|auth_?token|api_?key|cookie|credentials|withCredentials|trusted|allow(?:ed)?_?(?:list|hosts?|domains?|origins?)|white_?list|is(?:Safe|Trusted|Allowed|Valid)(?:Url|Host|Domain|Origin)?|deep_?link|Linking\.(?:addEventListener|getInitialURL)|handleOpenURL/i;
const URLISH = /(?:url|uri|link|href|origin|host|domain|redirect|target|location|endpoint|address|src)\w*$|\.url$/i;

export function urlTextChecks(root) {
  const hits = [];
  const { files } = sourceFiles(root, /\.[cm]?[jt]sx?$/);
  for (const { file, text } of files) {
    const rel = file.split(path.sep).join('/');
    if (SERVER.test(rel) || NOT_APP.test(rel) || !/startsWith|includes|indexOf|endsWith/.test(text)) continue;
    const code = stripComments(text);
    const lines = code.split('\n');
    const add = (m, what, bypass, host) => {
      if (FILE_EXT.test(host)) return;
      const line = lineOf(code, m.index);
      // Code only: words inside log messages and other strings do not count.
      const near = lines.slice(Math.max(0, line - 7), line + 6).join('\n').replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, "''");
      if (!/origin$/i.test(m[1]) && !TRUST_CONTEXT.test(near)) return;
      hits.push({ at: `${file}:${line}`, what, bypass });
    };
    // startsWith('https://host') with nothing after the host.
    for (const m of code.matchAll(/([\w$.?\]]+)\s*\.\s*startsWith\s*\(\s*(['"`])(https?:\/\/([a-z0-9.-]+)(?::\d+)?)\2\s*\)/gi)) {
      if (!DOMAIN.test(m[4]) || LOCAL.test(m[4])) continue;
      add(m, `${m[1]}.startsWith('${m[3]}')`, `${m[3]}.attacker.example`, m[4]);
    }
    // url.includes('host') / url.indexOf('host') on a value named like a URL.
    for (const m of code.matchAll(/([\w$.?\]]+)\s*\.\s*(includes|indexOf)\s*\(\s*(['"`])((?:https?:\/\/)?([a-z0-9.-]+)\/?)\3\s*\)/gi)) {
      if (!URLISH.test(m[1]) || !DOMAIN.test(m[5]) || LOCAL.test(m[5]) || !/[a-z]/i.test(m[5].split('.').pop())) continue;
      add(m, `${m[1]}.${m[2]}('${m[4]}')`, `https://attacker.example/?${m[5]}`, m[5]);
    }
    // hostname.endsWith('example.com') without the leading dot.
    for (const m of code.matchAll(/([\w$.?\]]*(?:host|hostname|domain|origin)\w*)\s*\.\s*endsWith\s*\(\s*(['"`])([a-z0-9][a-z0-9.-]*)\2\s*\)/gi)) {
      if (!DOMAIN.test(m[3]) || LOCAL.test(m[3])) continue;
      add(m, `${m[1]}.endsWith('${m[3]}')`, `attacker${m[3]}`, m[3]);
    }
  }
  if (!hits.length) return [];
  return [
    {
      id: 'url-checked-as-text',
      severity: 'medium',
      area: 'security',
      title: `${hits.length} URL${hits.length === 1 ? ' is' : 's are'} trusted after a text comparison (${hits[0].at}${hits.length > 1 ? ', …' : ''})`,
      detail: `${hits.slice(0, 4).map((h) => `${h.at} \`${h.what}\` also accepts ${h.bypass}`).join('; ')}${hits.length > 4 ? `; and ${hits.length - 4} more` : ''}. If the check decides where a token is sent, which page a WebView may open or which deep link is acted on, another site can pass it; the same mistake disclosed Zulip users' credentials (CVE-2022-35962). Parse the address and compare the host: \`new URL(url).host === 'api.example.com'\`, or for subdomains \`host === 'example.com' || host.endsWith('.example.com')\`. (OWASP MASVS-PLATFORM)`,
      fix: { kind: 'security', step: `Compare parsed hosts instead of text (${hits.slice(0, 3).map((h) => h.at).join(', ')}): \`new URL(url).host === 'api.example.com'\`.` },
      evidence: hits.slice(0, 20).map((h) => ({ file: h.at.split(':')[0], line: Number(h.at.split(':')[1]), role: h.what })),
    },
  ];
}

// Privileges the app grants itself: a client write of isPremium: true, role: 'admin' or credits
// straight to Firestore, the Realtime Database or Supabase. Unless the database rules forbid the
// user from changing that field, any user can make the same write from a script and get the
// subscription or role for free (a purchase checked only in the app). Fields the repository's
// Firestore rules or SQL mention by name are taken as protected.
const PRIVILEGED = /^(?:is_?)?(?:premium|pro|vip|paid|subscribed|admin|super_?admin|moderator|verified|unlimited)$|^(?:role|roles|plan|tier|subscription(?:_?(?:status|tier|plan|active))?|credits?|balance|coins|entitlements?|account_?type|user_?type)$/i;
const WRITE = /\b(?:updateDoc|setDoc|addDoc)\s*\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*\{|\.(?:update|set|upsert|insert)\s*\(\s*\[?\s*\{/g;

function objectLiteral(code, open) {
  let depth = 0;
  for (let i = open; i < code.length && i < open + 1500; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(open + 1, i);
  }
  return null;
}

export function clientPrivilegeWrites(root) {
  const hits = [];
  const { files } = sourceFiles(root, /\.[cm]?[jt]sx?$|\.rules$|\.sql$/);
  const protectedText = files.filter((f) => /\.(?:rules|sql)$/.test(f.file)).map((f) => f.text).join('\n');
  for (const { file, text } of files) {
    const rel = file.split(path.sep).join('/');
    // Admin screens grant these to other users; whether only admins may is a rules question this
    // finding is not about.
    if (!/\.[cm]?[jt]sx?$/.test(rel) || SERVER.test(rel) || NOT_APP.test(rel) || /admin/i.test(rel)) continue;
    if (!/firestore|firebase|supabase|database\(\)/i.test(text)) continue;
    const code = stripComments(text);
    for (const m of code.matchAll(WRITE)) {
      const body = objectLiteral(code, m.index + m[0].lastIndexOf('{'));
      if (!body) continue;
      // Top-level keys with a value that grants something: true, a role/plan string, a number,
      // or an increment.
      for (const k of body.matchAll(/(?:^|[,{\s])['"]?([A-Za-z_][\w]*)['"]?\s*:\s*(true\b|['"`](?:admin|pro|premium|vip|paid|active|owner|moderator|unlimited|gold|plus)['"`]|-?\d+\b|(?:firestore\.)?FieldValue\.increment\(|increment\()/gi)) {
        if (!PRIVILEGED.test(k[1]) || new RegExp(`\\b${k[1]}\\b`).test(protectedText)) continue;
        hits.push({ at: `${rel}:${lineOf(code, m.index)}`, field: k[1], value: k[2].replace(/\($/, '(…)') });
        break;
      }
    }
  }
  if (!hits.length) return [];
  return [
    {
      id: 'client-writes-privilege',
      severity: 'medium',
      area: 'security',
      title: `The app writes ${[...new Set(hits.map((h) => h.field))].slice(0, 3).join(', ')} to the database itself (${hits[0].at}${hits.length > 1 ? ', …' : ''})`,
      detail: `${hits.slice(0, 4).map((h) => `${h.at} sets \`${h.field}: ${h.value}\``).join('; ')}${hits.length > 4 ? `; and ${hits.length - 4} more` : ''}. If the database rules let a user update their own record, anyone can send the same write from a script, with no purchase or approval, and get the subscription, role or credits. Grant these fields from a server after verifying the purchase (a RevenueCat or store webhook, a Cloud Function or Edge Function), and make the rules reject client writes to them: in Firestore, \`!request.resource.data.diff(resource.data).affectedKeys().hasAny(['${hits[0].field}'])\`; in Supabase, a column privilege or a trigger. No rules in the repository mention ${hits.length === 1 ? 'this field' : 'these fields'}. (OWASP MASVS-AUTH)`,
      fix: { kind: 'security', step: `Move the write of ${[...new Set(hits.map((h) => h.field))].slice(0, 3).join(', ')} to a server that verifies the purchase or approval, and block client writes to ${hits.length === 1 ? 'that field' : 'those fields'} in the database rules.` },
      evidence: hits.slice(0, 20).map((h) => ({ file: h.at.split(':')[0], line: Number(h.at.split(':')[1]), role: h.field })),
    },
  ];
}

// A global axios interceptor that adds the user's token to every request, while the same global
// axios also calls other hosts: the token goes to them too. Interceptors that look at the URL or
// host first, and axios instances (axios.create), are left alone.
function callArgs(code, open) {
  let depth = 0;
  for (let i = open; i < code.length && i < open + 3000; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return code.slice(open + 1, i);
  }
  return null;
}

export function tokenToEveryHost(root) {
  const { files } = sourceFiles(root, /\.[cm]?[jt]sx?$/);
  let interceptor = null;
  const hosts = new Map(); // host -> where
  for (const { file, text } of files) {
    const rel = file.split(path.sep).join('/');
    if (SERVER.test(rel) || NOT_APP.test(rel) || !/\baxios\b/.test(text)) continue;
    const code = stripComments(text);
    for (const m of code.matchAll(/\baxios\s*\.\s*interceptors\s*\.\s*request\s*\.\s*use\s*\(/g)) {
      const body = callArgs(code, m.index + m[0].length - 1) || '';
      if (/Authorization|Bearer|access_?token|auth_?token/i.test(body) && !/\.url\b|baseURL|\.host\b|hostname|startsWith|new URL|includes\(/.test(body)) interceptor = interceptor || `${rel}:${lineOf(code, m.index)}`;
    }
    for (const m of code.matchAll(/\baxios(?:\s*\.\s*(?:get|post|put|patch|delete|head|request))?\s*\(\s*['"`]https?:\/\/([a-z0-9.-]+)/gi)) {
      if (!LOCAL.test(m[1]) && !hosts.has(m[1])) hosts.set(m[1], `${rel}:${lineOf(code, m.index)}`);
    }
    for (const m of code.matchAll(/\baxios\s*\.\s*defaults\s*\.\s*baseURL\s*=\s*['"`]https?:\/\/([a-z0-9.-]+)/gi)) hosts.set(`base:${m[1]}`, `${rel}:${lineOf(code, m.index)}`);
  }
  if (!interceptor) return [];
  const base = [...hosts.keys()].find((h) => h.startsWith('base:'))?.slice(5);
  const site = (h) => h.split('.').slice(-2).join('.');
  // Hosts of a different site than the API (or than each other when no base URL is set).
  const all = [...hosts.keys()].filter((h) => !h.startsWith('base:'));
  const sites = new Set(all.map(site));
  const others = base ? all.filter((h) => site(h) !== site(base)) : sites.size > 1 ? all : [];
  if (!others.length) return [];
  return [
    {
      id: 'token-sent-to-every-host',
      severity: 'medium',
      area: 'security',
      title: `The login token is added to every axios request, including ${others.length === 1 ? 'a call' : `${others.length} calls`} to another site (${others.slice(0, 2).join(', ')})`,
      detail: `The global axios interceptor at ${interceptor} adds the Authorization header without looking at where the request goes, and the same global axios calls ${others.slice(0, 4).map((h) => `${h} (${hosts.get(h)})`).join(', ')}. Those services receive the user's token with every call; whoever runs or compromises them can act as the user. Use an axios instance for your API (\`axios.create({ baseURL })\`) and add the interceptor to it, or add the header only when \`new URL(config.url, config.baseURL).host\` is your API's host. (OWASP MASVS-NETWORK)`,
      fix: { kind: 'security', step: `Limit the token interceptor (${interceptor}) to your API: move it to an axios instance with your baseURL, or check the request host before adding the header.` },
    },
  ];
}
