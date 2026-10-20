import fs from './read-boundary.js';
import path from 'node:path';
import { gitLsFiles } from './git.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'Pods', 'build', '.gradle', 'DerivedData', '.expo', 'dist', 'coverage']);
const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.plist', '.xml', '.gradle', '.properties', '.env', '.m', '.mm', '.swift', '.kt', '.java']);
const MAX_FILE_BYTES = 1024 * 1024;

// Folders that hold server-side code: never bundled into the app, but still a leak if committed.
const SERVER_DIRS = new Set(['functions', 'server', 'backend', 'api', 'cloud-functions', 'scripts']);

// Only patterns that are almost never false positives. The `v` group is the secret value itself.
const RULES = [
  { id: 'aws-access-key', label: 'AWS access key ID', re: /\b(?<v>(?:AKIA|ASIA)[0-9A-Z]{16})\b/g },
  { id: 'aws-secret-key', label: 'AWS secret access key', re: /secretAccessKey["']?\s*[:=]\s*["'](?<v>[A-Za-z0-9/+]{40})["']/g },
  // A real key has a base64 body after the header; input placeholders ("-----BEGIN … Paste
  // your key here") and elided samples ("\n...\n") do not.
  {
    id: 'private-key',
    label: 'Private key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    validate: (m) => /[A-Za-z0-9+/]{60,}/.test(m.input.slice(m.index + m[0].length, m.index + m[0].length + 400).replace(/\\[nr]|["'`+,\s]/g, '')),
  },
  { id: 'stripe-secret', label: 'Stripe secret key', re: /\bsk_live_[0-9a-zA-Z]{20,}\b/g },
  { id: 'openai-key', label: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { id: 'anthropic-key', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
  { id: 'github-token', label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[baprs]-\d{6,}-[A-Za-z0-9-]{10,}\b/g },
  { id: 'sendgrid-key', label: 'SendGrid API key', re: /\b(?<v>SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g },
  { id: 'twilio-key', label: 'Twilio API key', re: /\b(?<v>SK[0-9a-fA-F]{32})\b/g },
  { id: 'google-oauth-secret', label: 'Google OAuth client secret', re: /\b(?<v>GOCSPX-[A-Za-z0-9_-]{28})\b/g },
  { id: 'mailchimp-key', label: 'Mailchimp API key', re: /\b(?<v>[0-9a-f]{32}-us\d{1,2})\b/g },
  { id: 'shopify-token', label: 'Shopify access token', re: /\b(?<v>shp(?:at|ca|pa|ss)_[a-fA-F0-9]{32})\b/g },
  // Sentry organization tokens (sntrys_ + base64 payload + _ + secret) and user tokens (sntryu_ + 64
  // hex) can read and change the Sentry organization. Sentry's own Expo plugin built them into the
  // app bundle in 5.16–5.19 (GHSA-68c2-4mpx-qh95).
  { id: 'sentry-auth-token', label: 'Sentry auth token', re: /\b(?<v>sntrys_[A-Za-z0-9+/=]{40,}_[A-Za-z0-9]{20,}|sntryu_[a-f0-9]{64})\b/g },
  // A database URL with a password connects straight to the database. Local development hosts
  // (localhost, Docker service names without a dot) and placeholder passwords are left alone.
  {
    id: 'database-url',
    label: 'Database connection string with password',
    re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|rediss?|amqps?):\/\/[^:@/\s'"`]+:(?<v>[^@/\s'"`]{6,})@(?<host>[A-Za-z0-9.-]+)/g,
    validate: (m) => /\./.test(m.groups.host) && !/^(?:localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|host\.docker\.internal)/.test(m.groups.host) && !/^(?:password|passw0rd|secret|changeme|\$\{|[<\[{(])/i.test(m.groups.v) && !/password|your|pass(?:wd)?$/i.test(m.groups.v),
  },
  { id: 'hasura-admin-secret', label: 'Hasura admin secret', re: /x-hasura-admin-secret["']?\s*[:=]\s*["'](?<v>[^"'\s$`{]{8,})["']/gi },
  // Supabase anon keys are public by design; the service_role key bypasses row-level security.
  // Both are JWTs, so decode the payload and only report the service role.
  {
    id: 'supabase-service-role',
    label: 'Supabase service_role key',
    re: /\b(?<v>eyJ[A-Za-z0-9_-]{10,}\.(?<payload>eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{20,})\b/g,
    validate: (m) => {
      try {
        // `supabase start` gives every developer the same demo keys (iss "supabase-demo"); they only
        // open a local database on 127.0.0.1.
        const claims = JSON.parse(Buffer.from(m.groups.payload, 'base64url').toString('utf8'));
        return claims.role === 'service_role' && claims.iss !== 'supabase-demo';
      } catch {
        return false;
      }
    },
  },
];

// Values that are obviously not real: docs examples, test fixtures, templates.
const PLACEHOLDER = /example|test|dummy|fake|sample|placeholder|xxxx|changeme|redacted|your[_-]?(?:api[_-]?)?(?:key|token|secret)/i;

// Hermes bytecode stores its strings back to back with no separator ("…JK6lsk_live_51…"), so in a
// built bundle a key does not start or end at a word boundary. Those copies of the rules drop the
// outer \b; the prefixes (sk_live_, AKIA, eyJ…) still anchor them.
// Only rules with a prefix that does not occur in ordinary text are relaxed: "sk-" alone would match
// inside "mask-image" or "task-…", and Twilio's SK + 32 hex inside base64 data. OpenAI keys also
// carry "T3BlbkFJ" (base64 of "OpenAI"), which a run of CSS names never does.
const RELAXED_IN_BINARY = {
  'aws-access-key': null,
  'stripe-secret': null,
  'openai-key': (m) => m[0].includes('T3BlbkFJ'),
  'anthropic-key': (m) => /^sk-ant-(?:api|admin)\d\d-/.test(m[0]),
  'github-token': null,
  'slack-token': null,
  'sendgrid-key': null,
  'google-oauth-secret': null,
  'shopify-token': null,
  'sentry-auth-token': null,
  'supabase-service-role': null,
};
const BINARY_RULES = RULES.map((rule) => {
  if (!(rule.id in RELAXED_IN_BINARY)) return rule;
  const extra = RELAXED_IN_BINARY[rule.id];
  return {
    ...rule,
    re: new RegExp(rule.re.source.replace(/^\\b/, '').replace(/\\b$/, ''), rule.re.flags),
    validate: extra ? (m) => extra(m) && (!rule.validate || rule.validate(m)) : rule.validate,
  };
});

// Every secret in `text` (a source file, or with `binary` a built JavaScript or Hermes bundle read
// as latin1): { rule, label, value, index }.
export function findSecrets(text, { binary = false } = {}) {
  const out = [];
  for (const rule of binary ? BINARY_RULES : RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.validate && !rule.validate(m)) continue;
      if (PLACEHOLDER.test(m[0])) continue;
      out.push({ rule: rule.id, label: rule.label, value: (m.groups && m.groups.v) || m[0], index: m.index });
    }
  }
  return out;
}

// Test code is never part of the app bundle.
export const TEST_PATH = /(^|\/)(__tests__|__mocks__|__fixtures__|test|tests|e2e|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\.[cm]?[jt]sx?$|[a-z]Test\.[cm]?[jt]sx?$/;

const JS_FILE = /\.[cm]?[jt]sx?$/;

// A JSON file only ends up in the JavaScript bundle when code imports it (a service-account
// file lying in the project root is committed, not shipped). Native resources (plist, xml) and
// assets under android/ and ios/ are packaged by the build, so they always ship.
function importedJsonNames(files) {
  const names = new Set();
  for (const file of files) {
    if (!JS_FILE.test(file)) continue;
    let text;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/['"`]([^'"`\n]+\.json)['"`]/g)) names.add(path.basename(m[1]));
  }
  return names;
}

const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*|#|<!--)/.test(line);

export function mask(value) {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name));
    } else if (EXTENSIONS.has(path.extname(e.name)) || e.name.startsWith('.env')) {
      yield path.join(dir, e.name);
    }
  }
}

function gitTrackedFiles(root) {
  const files = gitLsFiles(root);
  return files ? new Set(files) : null;
}

export function scanSecrets(root) {
  const findings = [];
  const tracked = gitTrackedFiles(root);
  const files = [...walk(root)];
  let jsonImports = null; // computed only if a JSON file holds a secret
  // A .env file reaches the bundle only through EXPO_PUBLIC_ names (Expo) or a library that
  // inlines every variable (react-native-config, react-native-dotenv). Other names stay with
  // server code (Expo API routes, functions) and the build.
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {}
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const inlinesAllEnv = ['react-native-config', 'react-native-dotenv', 'babel-plugin-transform-inline-environment-variables'].some((n) => allDeps[n]);
  // Expo embeds the app config in every build (Constants.expoConfig). Its public form drops only
  // _internal, hooks, ios.config, android.config and the update signing fields
  // (@expo/config getConfig isPublicConfig); plugin options and `extra` stay in the app.
  let expoPublic = '';
  if (allDeps.expo) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
      const exp = data.expo || data;
      delete exp._internal;
      delete exp.hooks;
      if (exp.ios) delete exp.ios.config;
      if (exp.android) delete exp.android.config;
      if (exp.updates) { delete exp.updates.codeSigningCertificate; delete exp.updates.codeSigningMetadata; }
      expoPublic = JSON.stringify(exp);
    } catch {}
  }
  for (const file of files) {
    let text;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (const rule of RULES) {
      for (const m of text.matchAll(rule.re)) {
        if (rule.validate && !rule.validate(m)) continue;
        if (PLACEHOLDER.test(m[0])) continue;
        const rel = path.relative(root, file);
        const posix = rel.split(path.sep).join('/');
        const value = m.groups && m.groups.v;
        const line = text.slice(0, m.index).split('\n').length;
        // Comments are stripped from the bundle; a key there is committed, not shipped.
        const inComment = isCommentLine(lines[line - 1] || '');
        let unreferencedJson = false;
        const inExpoConfig = posix === 'app.json' && expoPublic.includes(value || m[0]);
        if (file.endsWith('.json') && !/^(android|ios)\//.test(posix) && !inExpoConfig) {
          jsonImports = jsonImports || importedJsonNames(files);
          unreferencedJson = !jsonImports.has(path.basename(file));
        }
        const envFile = /^\.env(\.|$)/.test(path.basename(file));
        const envShipped = !envFile || inlinesAllEnv || /^\s*(?:export\s+)?EXPO_PUBLIC_/.test(lines[line - 1] || '');
        findings.push({
          rule: rule.id,
          label: rule.label,
          file: rel,
          line,
          preview: value ? mask(value) : null,
          // Start of the value, so a copy found in the built app is not reported a second time.
          fingerprint: (value || m[0]).slice(0, 16),
          // Gradle and properties files (sentry.properties, gradle.properties) are read by the build,
          // not packaged into the app.
          inAppBundle: !SERVER_DIRS.has(posix.split('/')[0]) && !TEST_PATH.test(posix) && !inComment && !unreferencedJson && envShipped && !/\.(?:properties|gradle|kts)$/.test(posix),
          inComment,
          committed: tracked ? tracked.has(posix) : null,
        });
      }
    }
  }
  return findings;
}
