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
    const get = name => { if (!tables.has(name)) tables.set(name, { policies: new Map(), rls: false, uncertain: false }); return tables.get(name); };
    for (const file of files) {
      const source = read(file);
      if (source === null) { uncertain = true; continue; }
      for (const { sql, line } of sqlStatements(source)) {
      // These can change schema/policies indirectly; do not claim a final policy state.
      if (/^(?:do\b|call\b|execute\b|set\s+(?:local\s+)?search_path\b|select\b|rollback\b)/i.test(sql)) { uncertain = true; continue; }
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

export function firebaseBroadWrites(root) {
  const files = ['firestore.rules', 'storage.rules'].map(f => path.join(root, f));
  const findings = [];
  for (const file of files) {
    // Preserve newlines; matches inside comments must not count. We report the rule's
    // exact semantics, not that every application document is private or deployed.
    const text = (read(file) || '').replace(/\/\*[\s\S]*?\*\//g, s => s.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, s => s.replace(/[^\n]/g, ' '));
    const re = /\ballow\s+((?:read|write|get|list|create|update|delete)(?:\s*,\s*(?:read|write|get|list|create|update|delete))*)\s*:\s*if\s+\(*\s*request\.auth\s*!=\s*null\s*\)*\s*;/g;
    for (const m of text.matchAll(re)) {
      if (!/\b(?:write|update|delete)\b/.test(m[1])) continue;
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
