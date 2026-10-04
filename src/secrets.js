import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SKIP_DIRS = new Set(['node_modules', '.git', 'Pods', 'build', '.gradle', 'DerivedData', '.expo', 'dist', 'coverage']);
const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.json', '.plist', '.xml', '.gradle', '.properties', '.env', '.m', '.mm', '.swift', '.kt', '.java']);
const MAX_FILE_BYTES = 1024 * 1024;

// Folders that hold server-side code: never bundled into the app, but still a leak if committed.
const SERVER_DIRS = new Set(['functions', 'server', 'backend', 'api', 'cloud-functions', 'scripts']);

// Only patterns that are almost never false positives. The `v` group is the secret value itself.
const RULES = [
  { id: 'aws-access-key', label: 'AWS access key ID', re: /\b(?<v>(?:AKIA|ASIA)[0-9A-Z]{16})\b/g },
  { id: 'aws-secret-key', label: 'AWS secret access key', re: /secretAccessKey["']?\s*[:=]\s*["'](?<v>[A-Za-z0-9/+]{40})["']/g },
  { id: 'private-key', label: 'Private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
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
        return JSON.parse(Buffer.from(m.groups.payload, 'base64url').toString('utf8')).role === 'service_role';
      } catch {
        return false;
      }
    },
  },
];

// Values that are obviously not real: docs examples, test fixtures, templates.
const PLACEHOLDER = /example|test|dummy|fake|sample|placeholder|xxxx|changeme|redacted|your[_-]?(?:api[_-]?)?(?:key|token|secret)/i;

// Test code is never part of the app bundle.
const TEST_PATH = /(^|\/)(__tests__|__mocks__|__fixtures__|test|tests|e2e|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

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
  const res = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return res.status === 0 ? new Set(res.stdout.split('\n')) : null;
}

export function scanSecrets(root) {
  const findings = [];
  const tracked = gitTrackedFiles(root);
  for (const file of walk(root)) {
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
        findings.push({
          rule: rule.id,
          label: rule.label,
          file: rel,
          line,
          preview: value ? mask(value) : null,
          inAppBundle: !SERVER_DIRS.has(posix.split('/')[0]) && !TEST_PATH.test(posix) && !inComment,
          inComment,
          committed: tracked ? tracked.has(posix) : null,
        });
      }
    }
  }
  return findings;
}
