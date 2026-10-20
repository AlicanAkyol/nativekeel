import test from 'node:test';
import assert from 'node:assert/strict';
import { urlTextChecks } from '../src/api-security.js';
import { makeProject } from './helpers.js';

const run = (files) => urlTextChecks(makeProject({ 'package.json': '{}', ...files }));

test('URLs trusted after a text comparison, where the check decides trust', () => {
  const webview = (cond) => `<WebView source={{ uri }} onShouldStartLoadWithRequest={(e) => ${cond}} />`;
  const [f] = run({ 'src/Pay.tsx': webview("e.url.startsWith('https://pay.example.com')") });
  assert.match(f.detail, /src\/Pay\.tsx:1 `e\.url\.startsWith\('https:\/\/pay\.example\.com'\)` also accepts https:\/\/pay\.example\.com\.attacker\.example/);
  assert.equal(run({ 'src/a.ts': "window.addEventListener('message', (e) => { if (!e.origin.includes('example.com')) return; run(e.data); });" }).length, 1, 'origin checks always count');
  assert.equal(run({ 'src/a.ts': "const allowedHost = host.endsWith('example.com');\nif (allowedHost) headers.Authorization = `Bearer ${token}`;" }).length, 1);
  for (const files of [
    { 'src/Pay.tsx': webview("e.url.startsWith('https://pay.example.com/')") },
    { 'src/Pay.tsx': webview("new URL(e.url).host === 'pay.example.com'") },
    { 'src/a.ts': "const isYoutube = url.includes('youtube.com');\nreturn isYoutube ? 'video' : 'link';" },
    { 'src/a.ts': "if (host.endsWith('.example.com')) allowed = true; // trusted" },
    { 'src/a.ts': "console.log('cookie'); if (url.includes('identity.example.edu')) return false;" },
    { 'src/a.ts': "if (link.includes('song.html')) trusted = parse(link);" },
    { 'web/src/a.ts': "if (!e.origin.includes('example.com')) return;" },
  ]) assert.deepEqual(run(files), [], JSON.stringify(files));
});

test('privileges the app writes to the database itself', async () => {
  const { clientPrivilegeWrites } = await import('../src/api-security.js');
  const run = (files) => clientPrivilegeWrites(makeProject({ 'package.json': '{}', ...files })).map((f) => f.detail);
  const firestore = "import { doc, updateDoc } from 'firebase/firestore';\n";
  assert.match(run({ 'src/pay.ts': `${firestore}await updateDoc(doc(db, 'users', uid), { isPremium: true, updatedAt: now });` })[0] || '', /src\/pay\.ts:2 sets `isPremium: true`/);
  assert.match(run({ 'src/pay.ts': "import { supabase } from './supabase';\nawait supabase.from('profiles').update({ plan: 'pro' }).eq('id', uid);" })[0] || '', /`plan: 'pro'`/);
  assert.match(run({ 'src/pay.ts': `${firestore}await updateDoc(ref, { credits: increment(100) });` })[0] || '', /`credits: increment\(…\)`/);
  for (const files of [
    { 'src/pay.ts': `${firestore}await updateDoc(ref, { isPremium: true });`, 'firestore.rules': "allow update: if !request.resource.data.diff(resource.data).affectedKeys().hasAny(['isPremium']);" },
    { 'src/pay.ts': `${firestore}await updateDoc(ref, { displayName: name, isOnline: true });` },
    { 'src/admin/Doctors.tsx': `${firestore}await updateDoc(ref, { isVerified: true });` },
    { 'functions/src/grant.ts': `${firestore}await updateDoc(ref, { isPremium: true });` },
  ]) assert.deepEqual(run(files), [], JSON.stringify(files));
});

test('a global axios interceptor sends the token to other sites too', async () => {
  const { tokenToEveryHost } = await import('../src/api-security.js');
  const interceptor = "import axios from 'axios';\naxios.defaults.baseURL = 'https://api.shop.io';\naxios.interceptors.request.use((config) => { config.headers.Authorization = `Bearer ${token}`; return config; });\n";
  const [f] = tokenToEveryHost(makeProject({ 'src/api.ts': interceptor, 'src/weather.ts': "import axios from 'axios';\nexport const w = () => axios.get('https://api.weather.example.org/v1');" }));
  assert.match(f?.title || '', /including a call to another site \(api\.weather\.example\.org\)/);
  const none = (files) => tokenToEveryHost(makeProject(files)).length;
  assert.equal(none({ 'src/api.ts': interceptor, 'src/b.ts': "import axios from 'axios';\naxios.get('https://cdn.shop.io/x');" }), 0, 'same site');
  assert.equal(none({ 'src/api.ts': interceptor.replace('config.headers.Authorization', "if (config.url.startsWith('/')) config.headers.Authorization"), 'src/weather.ts': "import axios from 'axios';\naxios.get('https://api.weather.example.org/v1');" }), 0, 'checks the URL');
});
