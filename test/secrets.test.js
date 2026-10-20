import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets } from '../src/secrets.js';
import { makeProject, FAKE_PEM_BODY } from './helpers.js';

const jwt = (payload) =>
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU`;

const scan = (src) => scanSecrets(makeProject({ 'package.json': '{}', 'src/config.js': src })).map((f) => f.rule);

test('Supabase: service_role is reported, anon key is not', () => {
  assert.deepEqual(scan(`const k = '${jwt({ iss: 'supabase', role: 'service_role' })}';`), ['supabase-service-role']);
  assert.deepEqual(scan(`const k = '${jwt({ iss: 'supabase', role: 'anon' })}';`), []);
  assert.deepEqual(scan(`const LOCAL_SERVICE_ROLE_KEY = '${jwt({ iss: 'supabase-demo', role: 'service_role' })}';`), [], 'the public `supabase start` demo key');
});

test('.env values reach the bundle only through EXPO_PUBLIC_ or an env-inlining library', () => {
  const pem = `"-----BEGIN PRIVATE KEY-----\\n${FAKE_PEM_BODY.replace(/\n/g, '\\n')}-----END PRIVATE KEY-----"`;
  const env = (pkg, line) => scanSecrets(makeProject({ 'package.json': pkg, '.env': `API_URL=https://x.io\n${line}\n` }))[0];
  assert.equal(env({ dependencies: { expo: '53.0.0' } }, `FIREBASE_PRIVATE_KEY=${pem}`).inAppBundle, false, 'server-only name in an Expo app (API routes)');
  assert.equal(env({ dependencies: { expo: '53.0.0' } }, `EXPO_PUBLIC_FIREBASE_PRIVATE_KEY=${pem}`).inAppBundle, true);
  assert.equal(env({ dependencies: { 'react-native-config': '1.5.0' } }, `FIREBASE_PRIVATE_KEY=${pem}`).inAppBundle, true, 'react-native-config inlines every variable');
});

test('provider key formats', () => {
  assert.deepEqual(scan(`'SG.${'a'.repeat(22)}.${'b'.repeat(43)}'`), ['sendgrid-key']);
  assert.deepEqual(scan(`'SK${'0123456789abcdef'.repeat(2)}'`), ['twilio-key']);
  assert.deepEqual(scan(`'GOCSPX-${'Ab1Cd2E'.repeat(4)}'`), ['google-oauth-secret']);
  assert.deepEqual(scan(`'${'0123456789abcdef'.repeat(2)}-us14'`), ['mailchimp-key']);
  assert.deepEqual(scan(`'shpat_${'ab12'.repeat(8)}'`), ['shopify-token']);
});

test('public identifiers are not secrets', () => {
  // Firebase/Google API keys, RevenueCat public keys and plain UUIDs are meant to ship in apps.
  // Built from parts so secret scanners (GitHub push protection) do not flag this fake value.
  const googleKey = ['AI', 'za', 'Sy', 'A', '1234567890abcdefghijklmnopqrstuv'].join('');
  assert.deepEqual(scan(`const a = '${googleKey}'; const b = 'appl_AbCdEfGhIjKlMnOpQrStUvWxYz1'; const c = '123e4567-e89b-12d3-a456-426614174000';`), []);
});

test('secrets are masked, never returned in full', () => {
  const key = `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const [f] = scanSecrets(makeProject({ 'package.json': '{}', 'src/a.js': `x='${key}'` }));
  assert.ok(!JSON.stringify(f).includes(key));
  assert.equal(f.preview, 'SG.a…bb');
});

test('placeholders and docs examples are not secrets', () => {
  assert.deepEqual(scan(`process.env.SLACK_TOKEN = 'xoxb-test-token';`), []);
  assert.deepEqual(scan(`const id = '${['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')}';`), [], "AWS's documented example key");
  assert.deepEqual(scan(`const t = 'xoxb-${'1'.repeat(12)}-${'2'.repeat(13)}-${'Ab3'.repeat(8)}';`), ['slack-token'], 'a real-shaped Slack token still counts');
});

test('where a secret sits decides whether it ships', () => {
  const pem = ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('') + FAKE_PEM_BODY.replace(/\n/g, '\\n');
  const root = makeProject({
    'package.json': '{}',
    'src/app.js': `const k = "${pem}";\n`,
    'src/old.js': `// const k = "${pem}";\n`,
    'src/__tests__/a.test.js': `const k = "${pem}";\n`,
  });
  const byFile = Object.fromEntries(scanSecrets(root).map((f) => [f.file.split('/').join('/'), f]));
  assert.equal(byFile['src/app.js'].inAppBundle, true);
  assert.equal(byFile['src/old.js'].inAppBundle, false);
  assert.equal(byFile['src/old.js'].inComment, true);
  assert.equal(byFile['src/__tests__/a.test.js'].inAppBundle, false, 'test code is not bundled');
});

test('a JSON file ships only when the code imports it', () => {
  const pem = ['-----BEGIN ', 'PRIVATE KEY-----'].join('') + FAKE_PEM_BODY.replace(/\n/g, '\\n');
  const sa = JSON.stringify({ type: 'service_account', private_key: `${pem}\nabc` });
  const loose = makeProject({ 'package.json': '{}', 'service-account.json': sa, 'src/App.js': "export default 1;\n" });
  assert.equal(scanSecrets(loose)[0].inAppBundle, false, 'committed, not shipped');
  const imported = makeProject({ 'package.json': '{}', 'src/sa.json': sa, 'src/App.js': "import sa from './sa.json';\n" });
  assert.equal(scanSecrets(imported)[0].inAppBundle, true);
  const testFiles = makeProject({ 'package.json': '{}', 'test.js': `const k = "${pem}";\n`, 'src/cryptoTest.ts': `const k = "${pem}";\n`, 'src/latest.js': `const k = "${pem}";\n` });
  const byFile = Object.fromEntries(scanSecrets(testFiles).map((f) => [f.file, f.inAppBundle]));
  assert.equal(byFile['test.js'], false);
  assert.equal(byFile['src/cryptoTest.ts'], false);
  assert.equal(byFile['src/latest.js'], true, '"latest.js" is not a test file');
});

test('Sentry auth tokens; secrets in an Expo app.json ship in the app unless under ios/android.config', () => {
  const sentry = ['sntrys_', 'eyJpYXQiOjE3MDAwMDAwMDAuMCwidXJsIjoiaHR0cHM6Ly9zZW50cnkuaW8iLCJvcmciOiJhY21lIn0=', '_', 'Abc123Def456Ghi789Jkl012Mno345Pqr678Stu9'].join('');
  const stripe = ['sk_', 'live_', '51HxQ2wE4rT6yU8iO0pA1sD3fG5hJ7kL9zX'].join('');
  const app = (expo, deps = { expo: '58.0.0' }) => scanSecrets(makeProject({ 'package.json': { name: 'a', dependencies: deps }, 'app.json': { expo } }));
  const [plugin] = app({ plugins: [['@sentry/react-native/expo', { organization: 'acme', authToken: sentry }]] });
  assert.equal(plugin.rule, 'sentry-auth-token');
  assert.equal(plugin.inAppBundle, true, 'plugin options are embedded (Constants.expoConfig)');
  assert.equal(app({ extra: { stripe } })[0].inAppBundle, true, 'extra is embedded');
  assert.equal(app({ ios: { config: { googleMapsApiKey: 'x', stripe } } })[0].inAppBundle, false, 'ios.config is removed from the public config');
  assert.equal(app({ extra: { stripe } }, { 'react-native': '0.80.0' })[0].inAppBundle, false, 'not an Expo app: app.json is not embedded');
});

test('a token in sentry.properties is committed, not shipped: the build reads it', () => {
  const sentry = ['sntryu_', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'].join('');
  const [f] = scanSecrets(makeProject({ 'package.json': '{}', 'android/sentry.properties': `defaults.org=acme\nauth.token=${sentry}\n` }));
  assert.equal(f.rule, 'sentry-auth-token');
  assert.equal(f.inAppBundle, false);
});
