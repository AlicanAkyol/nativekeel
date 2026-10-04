import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets } from '../src/secrets.js';
import { makeProject } from './helpers.js';

const jwt = (payload) =>
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU`;

const scan = (src) => scanSecrets(makeProject({ 'package.json': '{}', 'src/config.js': src })).map((f) => f.rule);

test('Supabase: service_role is reported, anon key is not', () => {
  assert.deepEqual(scan(`const k = '${jwt({ iss: 'supabase', role: 'service_role' })}';`), ['supabase-service-role']);
  assert.deepEqual(scan(`const k = '${jwt({ iss: 'supabase', role: 'anon' })}';`), []);
});

test('provider key formats', () => {
  assert.deepEqual(scan(`'SG.${'a'.repeat(22)}.${'b'.repeat(43)}'`), ['sendgrid-key']);
  assert.deepEqual(scan(`'SK${'0123456789abcdef'.repeat(2)}'`), ['twilio-key']);
  assert.deepEqual(scan(`'GOCSPX-${'x'.repeat(28)}'`), ['google-oauth-secret']);
  assert.deepEqual(scan(`'${'0123456789abcdef'.repeat(2)}-us14'`), ['mailchimp-key']);
  assert.deepEqual(scan(`'shpat_${'ab12'.repeat(8)}'`), ['shopify-token']);
});

test('public identifiers are not secrets', () => {
  // Firebase/Google API keys, RevenueCat public keys and plain UUIDs are meant to ship in apps.
  assert.deepEqual(scan("const a = 'AIzaSyA1234567890abcdefghijklmnopqrstuv'; const b = 'appl_AbCdEfGhIjKlMnOpQrStUvWxYz1'; const c = '123e4567-e89b-12d3-a456-426614174000';"), []);
});

test('secrets are masked, never returned in full', () => {
  const key = `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const [f] = scanSecrets(makeProject({ 'package.json': '{}', 'src/a.js': `x='${key}'` }));
  assert.ok(!JSON.stringify(f).includes(key));
  assert.equal(f.preview, 'SG.a…bb');
});
