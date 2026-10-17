import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { uploadReport, summaryFindings } from '../src/upload.js';
import { makeProject, FAKE_AWS_ID } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nativekeel.js');

test('upload: summary findings carry no details, and errors from the panel surface', async () => {
  assert.deepEqual(summaryFindings([{ id: 'a', severity: 'high', area: 'store', title: 'T', detail: 'secret detail', evidence: [{ file: 'x' }] }, { id: 'i', severity: 'info', title: 'note' }]), [{ id: 'a', severity: 'high', area: 'store', title: 'T' }]);
  await assert.rejects(uploadReport({}, { token: '' }), /NATIVEKEEL_TOKEN/);
  const sent = [];
  const fake = async (url, init) => { sent.push({ url, init }); return { ok: false, status: 401, json: async () => ({ error: 'unknown or missing upload token' }) }; };
  await assert.rejects(uploadReport({ tool: 'nativekeel' }, { token: 'nku_x', fetchImpl: fake }), /unknown or missing upload token/);
  assert.equal(sent[0].init.headers.authorization, 'Bearer nku_x');
  assert.match(sent[0].url, /\/api\/v1\/scans$/);
});

test('upload: --upload never runs with --offline', () => {
  const root = makeProject({ 'package.json': { name: 'u', dependencies: { 'react-native': '0.80.0' } } });
  const r = spawnSync(process.execPath, [CLI, root, '--offline', '--upload'], { encoding: 'utf8', env: { ...process.env, NATIVEKEEL_TOKEN: 'nku_x' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot be combined with --offline/);
});

test('upload: the CLI sends one summary per app, without details or source', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { bodies.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ team: 'T', stored: 1 })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const root = makeProject({ 'package.json': { name: 'up-app', dependencies: { 'react-native': '0.80.0' } }, 'src/keys.js': `export const k = '${FAKE_AWS_ID}';\n` });
  // A 1 ms network budget keeps the scan off the registries; only the panel request goes out.
  const child = spawn(process.execPath, [CLI, root, '--upload', '--fail-on', 'never'], { env: { ...process.env, NATIVEKEEL_TOKEN: 'nku_test', NATIVEKEEL_API: `http://127.0.0.1:${server.address().port}`, NATIVEKEEL_NETWORK_BUDGET_MS: '1' } });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  await new Promise((r) => child.on('close', r));
  server.close();
  assert.match(err, /Uploaded to the team panel \(T\)/);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].auth, 'Bearer nku_test');
  const app = bodies[0].body.apps[0];
  assert.equal(app.app, 'up-app');
  assert.equal(app.ratings.length, 6);
  const text = JSON.stringify(bodies[0].body);
  assert.ok(!text.includes('"detail"') && !text.includes(FAKE_AWS_ID), 'no details and no secret values');
});
