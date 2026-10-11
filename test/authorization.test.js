import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { supabaseBroadPolicies, firebaseBroadWrites } from '../src/authorization.js';
import { analyze } from '../src/analyze.js';
import { loadProject } from '../src/project.js';
import { htmlReport } from '../src/report-html.js';
import { makeProject } from './helpers.js';
const base = 'create table public.records (id int, owner uuid); alter table public.records enable row level security;';
const policy = 'create policy broad on public.records for all to anon using (true) with check (true);';
const check = (sql, extra = {}) => { const root = makeProject({ 'supabase/migrations/001.sql': sql, ...extra }); try { return supabaseBroadPolicies(root); } finally { fs.rmSync(root, { recursive: true }); } };

test('Supabase: RLS alone does not restrict an unconditional anonymous ALL policy', () => {
  const found = check(base + '\n' + policy);
  assert.equal(found.length, 1);
  assert.match(found[0].title, /anonymous.*update\/delete/);
  assert.equal(found[0].severity, 'medium');
  assert.match(found[0].detail, /grants.*not verified/);
  assert.equal(found[0].evidence[0].line, 2);
  assert.ok(!found[0].id.includes('/tmp/'));
});

test('Supabase: public reads, insert-only forms and owner checks are not broad-write findings', () => {
  for (const p of [
    'create policy p on public.records for select to anon using (true);',
    'create policy p on public.records for insert to anon with check (true);',
    'create policy p on public.records for all to authenticated using (auth.uid() = owner) with check (auth.uid() = owner);',
    'create policy p on public.records for update to anon using (true) with check (true);',
    'create policy p on public.records for all to service_role using (true);',
    'create policy p on public.records for select to anon using (true); create policy w on public.records for update to anon using (true) with check (auth.uid() = owner);',
    'create policy p on private.records for all to anon using (true);',
  ]) assert.deepEqual(check(base + p), [], p);
});

test('Supabase: restrictions, dropped/altered policies and dynamic migrations suppress stale claims', () => {
  for (const later of [
    'drop policy broad on public.records;',
    'alter policy broad on public.records using (auth.uid() = owner);',
    'create policy limit_owner on public.records as restrictive for all to anon using (auth.uid() = owner);',
    'drop table public.records cascade;',
    'alter table public.records disable row level security;',
    'do $$ begin execute \'drop policy broad on public.records\'; end $$;',
    'set search_path to private;',
    'alter table public.records rename to other;',
    'rollback;',
  ]) assert.deepEqual(check(base + policy, { 'supabase/migrations/002.sql': later }), [], later);
});

test('Supabase: no SQL detection in comments, strings or function bodies', () => {
  for (const text of [`/* ${policy} */`, `-- ${policy}\n`, `create function x() returns text as $$ ${policy} $$ language sql;`, `insert into messages values ('${policy}');`]) assert.deepEqual(check(base + text), []);
  assert.equal(check(base + 'create policy "broad; with space" on "public"."records" using ((true));').length, 1);
});

test('Supabase: separate SELECT/DELETE, authenticated role, and restrictive role semantics', () => {
  const statements = 'create policy view on public.records for select to authenticated using (true); create policy erase on public.records for delete to authenticated using (true);';
  const findings = check(base + statements);
  assert.equal(findings.length, 1); assert.match(findings[0].title, /signed-in.*delete/);
  assert.deepEqual(check(base + statements + 'create policy own on public.records as restrictive for select to public using (owner = auth.uid());'), []);
  assert.equal(check(base + policy + 'create policy staff on public.records as restrictive for all to authenticated using (false);').length, 1);
});

test('Firebase: auth-only update/write conditions are reported, owner/admin guards and public read/create are not', () => {
  const root = makeProject({ 'firestore.rules': `rules_version = '2'; service cloud.firestore { match /databases/{database}/documents {
    match /users/{uid} { allow read, update: if request.auth != null; }
    match /private/{uid} { allow write: if request.auth != null && request.auth.uid == uid; }
    match /admin/{uid} { allow write: if isAdmin(); }
    match /news/{id} { allow read: if true; allow create: if request.auth != null; }
    // allow write: if request.auth != null;
    /* allow write: if request.auth != null; */
  } }` });
  try { const f = firebaseBroadWrites(root); assert.equal(f.length, 1); assert.equal(f[0].evidence[0].line, 2); assert.equal(f[0].severity, 'medium'); } finally { fs.rmSync(root, { recursive: true }); }
});

test('New authorization checks reach the normal analysis and HTML report', async () => {
  const root = makeProject({ 'package.json': { name: 'app', dependencies: { 'react-native': '0.86.0' } }, 'supabase/migrations/001.sql': base + policy, 'firestore.rules': 'service cloud.firestore { match /databases/{db}/documents { match /users/{uid} { allow write: if request.auth != null; } } }' });
  try {
    const r = await analyze(loadProject(root), { get: async () => null, offline: true });
    assert.ok(r.findings.some(f => f.id.startsWith('supabase-policy-broad-write:') && f.masvs === 'AUTH'));
    assert.ok(r.findings.some(f => f.id.startsWith('firebase-auth-only-write:') && f.masvs === 'AUTH'));
    assert.match(htmlReport(r), /Supabase policies allow/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
