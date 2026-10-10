import fs from 'node:fs';
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
        if (file.endsWith('.json') && !/^(android|ios)\//.test(posix)) {
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
          inAppBundle: !SERVER_DIRS.has(posix.split('/')[0]) && !TEST_PATH.test(posix) && !inComment && !unreferencedJson && envShipped,
          inComment,
          committed: tracked ? tracked.has(posix) : null,
        });
      }
    }
  }
  return findings;
}
