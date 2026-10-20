import fs from './read-boundary.js';
import path from 'node:path';

// Conservative static checks, not a proof of the deployed database's access rules.
// Only unconditional policies are classified. Functions/dynamic SQL are not evaluated.
const IDENT = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';
const TABLE = `(${IDENT}(?:\\s*\\.\\s*${IDENT})?)`;
const unquote = s => s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase();
const tableName = s => {
  const parts = s.match(new RegExp(IDENT, 'g')).map(unquote);
  return parts.length === 1 ? `public.${parts[0]}` : parts[0] === 'public' ? parts.join('.') : null;
};

// Mask comments, string literals and dollar-quoted function bodies before splitting SQL.
// Preserve offsets/newlines for evidence; quoted identifiers remain intact.
function sqlStatements(text) {
  let clean = '', i = 0;
  const blank = s => s.replace(/[^\n]/g, ' ');
  while (i < text.length) {
    if (text.startsWith('--', i)) { const end = text.indexOf('\n', i); const j = end < 0 ? text.length : end; clean += blank(text.slice(i, j)); i = j; }
    else if (text.startsWith('/*', i)) {
      const start = i; i += 2; let depth = 1;
      while (i < text.length && depth) { if (text.startsWith('/*', i)) { depth++; i += 2; } else if (text.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      clean += blank(text.slice(start, i));
    } else if (text[i] === "'") {
      const start = i++;
      while (i < text.length) { if (text[i++] === "'") { if (text[i] === "'") i++; else break; } }
      clean += 'X' + blank(text.slice(start + 1, i));
    } else if (text[i] === '"') {
      clean += text[i++];
      while (i < text.length) { const ch = text[i++]; clean += ch; if (ch === '"') { if (text[i] === '"') clean += text[i++]; else break; } }
    } else {
      const tag = text.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) { const end = text.indexOf(tag, i + tag.length); const j = end < 0 ? text.length : end + tag.length; clean += 'X' + blank(text.slice(i + 1, j)); i = j; }
      else clean += text[i++];
    }
  }
  const out = []; let start = 0, quote = false;
  for (let n = 0; n <= clean.length; n++) {
    if (clean[n] === '"') { if (quote && clean[n + 1] === '"') { n++; continue; } quote = !quote; }
    if (n === clean.length || (clean[n] === ';' && !quote)) {
      const raw = clean.slice(start, n); const at = start + raw.search(/\S|$/);
      out.push({ sql: raw.trim(), line: text.slice(0, at).split('\n').length }); start = n + 1;
    }
  }
  return out;
}
function read(file) { try { return fs.statSync(file).size <= 1024 * 1024 ? fs.readFileSync(file, 'utf8') : null; } catch { return null; } }
function migrationFiles(root) {
  const files = [];
  const walk = (dir, depth, migrations = false) => {
    if (depth > 8) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !['node_modules', '.git', 'Pods', 'build', 'dist', 'vendor', 'test', 'tests', '__tests__'].includes(e.name)) walk(path.join(dir, e.name), depth + 1, migrations || (e.name === 'migrations' && path.basename(dir) === 'supabase'));
      else if (migrations && e.isFile() && e.name.endsWith('.sql')) files.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return files.sort();
}
function expression(tail, keyword) {
  const m = new RegExp(`\\b${keyword}\\s*\\(`, 'i').exec(tail);
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length, start = i;
  while (i < tail.length && depth) { if (tail[i] === '(') depth++; if (tail[i] === ')') depth--; i++; }
  return depth ? '?' : tail.slice(start, i - 1).trim();
}
const isTrue = s => s !== null && /^\(*\s*true\s*\)*$/i.test(s);
const forRole = (policy, role) => policy.roles.includes('public') || policy.roles.includes(role);
const applies = (policy, op) => policy.op === 'all' || policy.op === op;

// Columns that hold personal data or credentials.
const PERSONAL = /^(?:e_?mail|email_address|phone(?:_number)?|mobile(?:_number)?|(?:home_|street_|billing_|shipping_)?address(?:_line\d?)?|street|birth_?date|date_of_birth|dob|birthday|ssn|national_id|tax_id|passport\w*|iban|card_number|password(?:_hash)?|access_token|refresh_token|api_key|secret|private_key|diagnosis|medical\w*|health\w*)$/i;
const PEOPLE = /^(?:users?|profiles?|user_\w+|\w+_users|\w+_profiles?|accounts?|customers?|clients?|patients?|members?|employees?|staff|contacts?|emergency_contacts|students?|parents?|guardians?|drivers?|riders?|passengers?|persons?|people|applicants?|candidates?|subscribers?|leads?)$/i;
const PRIVATE_BUCKET = /^(?:private|documents?|receipts?|invoices?|kyc|ids?|identity|id[-_]?cards?|passports?|licen[cs]es?|contracts?|medical|health|prescriptions?|statements?|payslips?|tax|backups?|exports?)(?:[-_]\w+)?$/i;
function columnNames(body) {
  const out = []; let depth = 0, start = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (i === body.length || (ch === ',' && depth === 0)) {
      const part = body.slice(start, i).trim(); start = i + 1;
      const m = part.match(new RegExp(`^(${IDENT})`));
      if (m && !/^(?:constraint|primary|foreign|unique|check|exclude|like)$/i.test(m[1])) out.push(unquote(m[1]));
    }
  }
  return out;
}
// Bucket ids inserted with public = true. Reads the raw statement (string values are masked in the
// parsed one).
function publicBucketNames(raw) {
  const cols = (raw.match(/storage\.buckets\s*\(([^)]*)\)/i) || [])[1];
  if (!cols) return [];
  const names = cols.split(',').map(x => x.trim().replace(/"/g, '').toLowerCase());
  const idAt = names.indexOf('id') >= 0 ? names.indexOf('id') : names.indexOf('name');
  const pubAt = names.indexOf('public');
  if (idAt < 0 || pubAt < 0) return [];
  const out = [];
  for (const row of raw.split(/\bvalues\b/i)[1]?.matchAll(/\(([^()]*)\)/g) || []) {
    const vals = row[1].split(',').map(v => v.trim());
    if (/^true$/i.test(vals[pubAt] || '')) out.push((vals[idAt] || '').replace(/^'|'$/g, ''));
  }
  return out;
}

export function supabaseBroadPolicies(root) {
  // Separate migration trees are separate databases, not one shared policy namespace.
  const groups = new Map();
  for (const file of migrationFiles(root)) {
    const key = file.slice(0, file.lastIndexOf(`${path.sep}migrations${path.sep}`));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  const findings = [];
  for (const files of groups.values()) {
    const tables = new Map(); let uncertain = false;
    const get = name => { if (!tables.has(name)) tables.set(name, { policies: new Map(), rls: false, uncertain: false, columns: new Set() }); return tables.get(name); };
    const publicBuckets = [];
    for (const file of files) {
      const source = read(file);
      if (source === null) { uncertain = true; continue; }
      for (const { sql, line } of sqlStatements(source)) {
      // These can change schema/policies indirectly; do not claim a final policy state.
      if (/^(?:do\b|call\b|execute\b|set\s+(?:local\s+)?search_path\b|select\b|rollback\b)/i.test(sql)) { uncertain = true; continue; }
      // Columns, to tell a table of personal data from a public catalogue.
      let c = sql.match(new RegExp(`^create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${TABLE}\\s*\\(([\\s\\S]*)\\)`, 'i'));
      if (c) { const name = tableName(c[1]); if (name) for (const col of columnNames(c[2])) get(name).columns.add(col); continue; }
      c = sql.match(new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${TABLE}\\s+(add\\s+column[\\s\\S]*)$`, 'i'));
      if (c) { const name = tableName(c[1]); if (name) for (const a of c[2].matchAll(new RegExp(`add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})`, 'gi'))) get(name).columns.add(unquote(a[1])); continue; }
      // Storage buckets created public: insert into storage.buckets (id, name, public) values (...).
      if (/^insert\s+into\s+storage\.buckets\b/i.test(sql)) { const raw = source.split('\n').slice(line - 1).join('\n').split(';')[0]; for (const b of publicBucketNames(raw)) publicBuckets.push({ name: b, file: path.relative(root, file), line }); continue; }
      let m = sql.match(new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${TABLE}\\s+(enable|disable)\\s+row\\s+level\\s+security$`, 'i'));
      if (m) { const name = tableName(m[1]); if (name) get(name).rls = m[2].toLowerCase() === 'enable'; continue; }
      m = sql.match(new RegExp(`^drop\\s+table\\s+(?:if\\s+exists\\s+)?${TABLE}(?:\\s+(?:cascade|restrict))?$`, 'i'));
      if (m) { tables.delete(tableName(m[1])); continue; }
      m = sql.match(new RegExp(`^(create|drop|alter)\\s+policy\\s+(?:if\\s+exists\\s+)?(${IDENT})\\s+on\\s+${TABLE}([\\s\\S]*)$`, 'i'));
      if (!m) {
        // Unknown DDL can rename/remove a policy's table. Suppress this group's results.
        if (/^(?:alter|drop)\s+(?:table|schema|policy)\b/i.test(sql)) uncertain = true;
        continue;
      }
      const name = tableName(m[3]); if (!name) continue;
      const t = get(name), policyName = unquote(m[2]), verb = m[1].toLowerCase(), tail = m[4].trim();
      if (verb === 'drop') { t.policies.delete(policyName); continue; }
      if (verb === 'alter') { t.uncertain = true; continue; }
      const header = tail.split(/\busing\s*\(|\bwith\s+check\s*\(/i)[0].trim();
      const h = header.match(new RegExp(`^(?:as\\s+(permissive|restrictive)\\s*)?(?:for\\s+(all|select|insert|update|delete)\\s*)?(?:to\\s+(${IDENT}(?:\\s*,\\s*${IDENT})*))?$`, 'i'));
      if (!h) { t.uncertain = true; continue; }
      t.policies.set(policyName, { name: policyName, file: path.relative(root, file), line, restrictive: h[1]?.toLowerCase() === 'restrictive', op: h[2]?.toLowerCase() || 'all', roles: h[3] ? h[3].match(new RegExp(IDENT, 'g')).map(unquote) : ['public'], using: expression(tail, 'using'), check: expression(tail, 'with\\s+check') });
    }
    }
    for (const b of publicBuckets.filter(x => PRIVATE_BUCKET.test(x.name))) findings.push({
      id: `supabase-public-private-bucket:${b.name}`,
      severity: 'high', area: 'security', confidence: 'medium', evidence: [{ file: b.file, line: b.line }],
      title: `Storage bucket "${b.name}" is public (${b.file}:${b.line})`,
      detail: `The bucket is created with public = true, so every file in it can be downloaded by anyone who has or guesses its URL, without signing in and without any storage policy applying. Its name suggests private files. Make it private and hand out signed URLs (createSignedUrl) to the owner. Deployed bucket settings were not verified. (OWASP MASVS-STORAGE)`,
      fix: { kind: 'security', step: `Create "${b.name}" with public = false and serve its files through signed URLs.` },
    });
    if (uncertain) continue;
    for (const [table, t] of tables) {
      if (!t.rls || t.uncertain) continue;
      const policies = [...t.policies.values()];
      for (const role of ['anon', 'authenticated']) {
        const relevant = policies.filter(p => forRole(p, role));
        const ops = [];
        const evidence = new Map();
        for (const op of ['update', 'delete']) {
          // SELECT policies can further restrict rows visible to UPDATE/DELETE. Any
          // restrictive policy or unknown predicate is handled conservatively.
          const select = relevant.find(p => !p.restrictive && applies(p, 'select') && isTrue(p.using));
          const write = relevant.find(p => !p.restrictive && applies(p, op) && isTrue(p.using) && (op !== 'update' || isTrue(p.check === null ? p.using : p.check)));
          if (!select || !write || relevant.some(p => p.restrictive && (applies(p, op) || applies(p, 'select')))) continue;
          ops.push(op); for (const p of [select, write]) evidence.set(p.name, { file: p.file, line: p.line, policy: p.name });
        }
        // Reads: everyone (or every account) can SELECT every row of a table with personal data.
        const read = relevant.find(p => !p.restrictive && applies(p, 'select') && isTrue(p.using));
        // Only tables of people: a hospital's or shop's phone and address are public on purpose.
        const personal = PEOPLE.test(table.split('.').pop()) ? [...t.columns].filter(col => PERSONAL.test(col)) : [];
        if (read && personal.length && !relevant.some(p => p.restrictive && applies(p, 'select')) && !(role === 'authenticated' && findings.some(f => f.id === `supabase-policy-broad-read:anon:${table}:${path.relative(root, files[0])}`))) {
          findings.push({
            id: `supabase-policy-broad-read:${role}:${table}:${path.relative(root, files[0])}`,
            severity: role === 'anon' ? 'high' : 'medium', area: 'security', confidence: 'high', evidence: [{ file: read.file, line: read.line, policy: read.name }],
            title: `${role === 'anon' ? 'Anyone' : 'Any signed-in user'} can read every row of ${table}, which holds ${personal.slice(0, 3).join(', ')} (${read.file}:${read.line})`,
            detail: `Policy "${read.name}" gives ${role} SELECT with USING (true) on ${table}, and the table has ${personal.join(', ')}. The project URL and anon key ship inside the app, so ${role === 'anon' ? 'anyone, without an account,' : 'anyone who signs up'} can list every user's ${personal.slice(0, 2).join(' and ')} through the API. Limit reads to the owner (\`using (auth.uid() = user_id)\`), or move public fields to a separate table or view. Exploitation also depends on the table's grants and on these migrations being deployed; those were not verified. (OWASP MASVS-AUTH, MASVS-PRIVACY)`,
            fix: { kind: 'security', step: `Restrict the SELECT policy "${read.name}" on ${table} to the row's owner, or expose only public columns through a view.` },
          });
        }
        if (!ops.length) continue;
        // PUBLIC also covers authenticated users: report that case once, under anon.
        if (role === 'authenticated' && findings.some(f => f.id === `supabase-policy-broad-write:anon:${table}:${path.relative(root, files[0])}`)) continue;
        const refs = [...evidence.values()];
        findings.push({
          id: `supabase-policy-broad-write:${role}:${table}:${path.relative(root, files[0])}`,
          severity: 'medium', area: 'security', confidence: 'high', evidence: refs,
          title: `Supabase policies allow ${role === 'anon' ? 'anonymous' : 'any signed-in'} users to ${ops.join('/')} all rows of ${table} (${refs[0].file}:${refs[0].line})`,
          detail: `The final supported migration statements enable RLS but give ${role} unconditional SELECT and ${ops.join('/').toUpperCase()} policies. These policies do not enforce row ownership. Exploitation additionally requires the role's table/schema grants, API exposure and these migrations to be deployed; those conditions were not verified. Shared editable data can be intentional. Restrictive policies, dynamic SQL and unrecognised policy changes are not evaluated. Source: https://www.postgresql.org/docs/current/sql-createpolicy.html (OWASP MASVS-AUTH)`,
          fix: { kind: 'security', step: `Review the ${role} policies on ${table}; if records belong to individual users, restrict USING and WITH CHECK to the owner or permitted role. Test with two distinct accounts and an anonymous client in a local/test database. Confirm grants and deployed policies.` },
        });
      }
    }
  }
  return findings;
}

const PRIVATE_COLLECTION = /^(?:messages?|chats?|conversations?|orders?|payments?|transactions?|invoices?|bookings?|appointments?|prescriptions?|medical\w*|health\w*|locations?|private\w*|notifications?|addresses)$/i;
// The match path enclosing `at`, outermost to innermost ("/databases/{db}/documents/users/{userId}").
function matchPath(text, at) {
  const stack = [];
  let pending = null;
  // Paths have no spaces ("/users/{userId}"); the block's brace follows after whitespace.
  for (const m of text.slice(0, at).matchAll(/\bmatch\s+(\/\S*)\s+\{|[{}]/g)) {
    if (m[1] !== undefined) { stack.push(m[1].trim()); pending = null; }
    else if (m[0] === '{') stack.push(null);
    else stack.pop();
  }
  return stack.filter(Boolean).join('');
}

export function firebaseBroadWrites(root) {
  const files = ['firestore.rules', 'storage.rules'].map(f => path.join(root, f));
  const findings = [];
  for (const file of files) {
    // Preserve newlines; matches inside comments must not count. We report the rule's
    // exact semantics, not that every application document is private or deployed.
    const text = (read(file) || '').replace(/\/\*[\s\S]*?\*\//g, s => s.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, s => s.replace(/[^\n]/g, ' '));
    const re = /\ballow\s+((?:read|write|get|list|create|update|delete)(?:\s*,\s*(?:read|write|get|list|create|update|delete))*)\s*:\s*if\s+\(*\s*request\.auth\s*!=\s*null\s*\)*\s*;/g;
    for (const m of text.matchAll(re)) {
      if (!/\b(?:write|update|delete)\b/.test(m[1])) {
        // Reads: only where the matched path is a collection of people or private records, or
        // every file in Cloud Storage.
        const where = matchPath(text, m.index);
        const coll = (where.match(/\/([\w-]+)\/\{[^}]*\}\s*$/) || [])[1] || '';
        // Every file: the wildcard sits right under the bucket root (/b/{bucket}/o/{allPaths=**}),
        // not under a folder such as /users/{uid}/avatar/{allPaths=**}.
        const everyFile = file.endsWith('storage.rules') && /\/o\/\{\w+=\*\*\}\s*$/.test(where);
        if (!everyFile && !(PEOPLE.test(coll) || PRIVATE_COLLECTION.test(coll))) continue;
        const line = text.slice(0, m.index).split('\n').length, rel = path.relative(root, file);
        findings.push({
          id: `firebase-auth-only-read:${rel}:${line}`, severity: 'medium', area: 'security', confidence: 'high', evidence: [{ file: rel, line }],
          title: everyFile ? `Any signed-in user can download every file in Cloud Storage (${rel}:${line})` : `Any signed-in user can read every ${coll} document (${rel}:${line})`,
          detail: `${where.trim() || 'This rule'} allows ${m[1].replace(/\s+/g, ' ')} when request.auth != null, without comparing request.auth.uid to the owner. Anyone who signs up (or signs in anonymously, if enabled) can ${everyFile ? 'list and download other users\' files' : `read every user's ${coll} records`} with the Firebase SDK and the config that ships in the app. Check the owner: \`allow read: if request.auth.uid == userId\` (or a field such as resource.data.ownerId). This is source evidence, not verification of deployed rules. Source: https://firebase.google.com/docs/rules/basics (OWASP MASVS-AUTH, MASVS-PRIVACY)`,
          fix: { kind: 'security', step: `In ${rel}:${line}, limit reads to the owner of the ${everyFile ? 'file path' : `${coll} document`} instead of any signed-in user.` },
        });
        continue;
      }
      const line = text.slice(0, m.index).split('\n').length, rel = path.relative(root, file);
      findings.push({
        id: `firebase-auth-only-write:${rel}:${line}`, severity: 'medium', area: 'security', confidence: 'high', evidence: [{ file: rel, line }],
        title: `Firebase write rule only requires a signed-in user (${rel}:${line})`,
        detail: 'This allow condition checks request.auth != null without checking the record owner or a privileged role. Every signed-in client can perform the listed write operations on paths matched by this rule; another narrower allow rule does not override a broader grant. Shared writable collections may be intentional. This is source evidence, not verification of deployed rules or a successful cross-account attack. Source: https://firebase.google.com/docs/firestore/security/rules-conditions (OWASP MASVS-AUTH)',
        fix: { kind: 'security', step: `Review ${rel}:${line}. For user-owned records, check request.auth.uid against the path/owner and prevent changes to ownership fields. Test user A versus user B and unauthenticated requests in the Firebase emulator; preserve intentional shared access.` },
      });
    }
  }
  return findings;
}
