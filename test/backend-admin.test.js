import test from 'node:test';
import assert from 'node:assert/strict';
import { backendAdminInBundle } from '../src/security.js';
import { scanSecrets } from '../src/secrets.js';
import { makeProject } from './helpers.js';

const deps = { expo: '~58.0.0', 'react-native': '0.88.0' };

test('backend admin: bundled admin credentials and server SDKs in app code', () => {
  const root = makeProject({
    'src/supabase.ts': "export const admin = createClient(url, process.env.EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!);\nconst anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;",
    'src/db.ts': "import { Client } from 'pg';\nimport { Platform } from 'react-native';\nconst c = new Client({ password: process.env.EXPO_PUBLIC_DB_PASSWORD });",
    'src/admin.ts': "import admin from 'firebase-admin';",
    'src/firebase.ts': "export const cfg = { databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL };",
    'bskylink/db.ts': "import pg from 'pg';",
    'functions/index.ts': "import Stripe from 'stripe';\nconst s = process.env.EXPO_PUBLIC_STRIPE_SECRET_KEY;",
    'src/__tests__/x.test.ts': "const h = process.env.EXPO_PUBLIC_HASURA_ADMIN_SECRET;",
  });
  const f = backendAdminInBundle(root, deps);
  const ids = f.map((x) => x.id).sort();
  assert.deepEqual(ids, ['backend-admin-in-bundle:Database password', 'backend-admin-in-bundle:Supabase service_role key', 'backend-server-sdk-in-app']);
  assert.equal(f.find((x) => x.id.includes('Supabase')).severity, 'critical');
  const sdk = f.find((x) => x.id === 'backend-server-sdk-in-app');
  assert.match(sdk.detail, /pg \(direct PostgreSQL connection: needs database credentials\) at src\/db\.ts:1/);
  assert.doesNotMatch(sdk.detail, /firebase-admin|bskylink/, 'only files that also import React Native or Expo');
  assert.ok(!JSON.stringify(f).includes('functions/'), 'server folders are not the app');
  assert.deepEqual(backendAdminInBundle(makeProject({ 'src/a.ts': 'const k = process.env.EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;' }), { 'react-native': '0.80.0' }), [], 'no Expo, no EXPO_PUBLIC_ inlining');
});

test('secrets: database URLs with passwords and Hasura admin secrets, not local or placeholder ones', () => {
  const root = makeProject({
    'package.json': { name: 'x' },
    // Fake values, assembled at run time so the file itself holds no complete credential-shaped
    // string (GitHub secret scanning flagged the plain form, 2026-10-18).
    'src/a.ts': [
      `const prod = '${['postgres://app', 'Xk92jfLq7@db.prod-cluster.acme-corp.io:5432/main'].join(':')}';`,
      `const mongo = '${['mongodb+srv://user', 'Zq81kslW2@cluster0.ab12c.' + 'mongodb.net/app'].join(':')}';`,
      `const local = '${['postgres://app', 'Xk92jfLq7@localhost:5432/main'].join(':')}';`,
      `const docker = '${['postgres://app', 'Xk92jfLq7@db:5432/main'].join(':')}';`,
      "const ph = 'postgres://app:password@db.prod.io/main';",
      "const br = 'postgresql://postgres:[YOUR_PASSWORD]@db.abc.supabase.co:5432/postgres';",
      `headers: { '${'x-hasura-' + 'admin-secret'}': 'hz8Kq2mN0pL4' }`,
    ].join('\n'),
  });
  const ids = scanSecrets(root).map((s) => s.id || s.rule || s.type);
  assert.equal(ids.filter((i) => /database-url/.test(String(i))).length, 2, JSON.stringify(ids));
  assert.equal(ids.filter((i) => /hasura/.test(String(i))).length, 1);
});
