import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ratings } from '../src/ratings.js';
import { sortFleet, fleetMarkdown, fleetHtml } from '../src/fleet.js';
import { makeProject, FAKE_AWS_ID } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nativekeel.js');
const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });

test('ratings: the worst severity in each area decides, info does not count', () => {
  const r = Object.fromEntries(ratings([
    { area: 'secret', severity: 'critical' },
    { area: 'security', severity: 'low' },
    { area: 'store', severity: 'medium' },
    { area: 'native', severity: 'high' },
    { area: 'accessibility', severity: 'info' },
    { area: 'performance', severity: 'low' },
  ]).map((x) => [x.key, x.rating]));
  assert.deepEqual(r, { security: 'E', store: 'C', stability: 'A', upgrade: 'D', performance: 'B', accessibility: 'A' });
});

test('fleet: apps in a folder (monorepo or client folders), worst first, one table', () => {
  const root = makeProject({
    'clients/leaky/package.json': { name: 'leaky', dependencies: { 'react-native': '0.80.0' } },
    'clients/leaky/app.json': '{}',
    'clients/leaky/src/keys.js': `export const k = '${FAKE_AWS_ID}';\n`,
    'clients/clean/package.json': { name: 'clean', dependencies: { 'react-native': '0.80.0' } },
    'clients/clean/app.json': '{}',
    'tools/package.json': { name: 'not-an-app', dependencies: { lodash: '4.0.0' } },
  });
  const res = run(['fleet', root, '--offline', '--json']);
  assert.equal(res.status, 1, 'a critical finding in any app fails, like a single scan');
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.apps.map((a) => a.path), [path.join(path.basename(root), 'clients/leaky'), path.join(path.basename(root), 'clients/clean')], 'outside the current folder: shown from the given folder');
  assert.deepEqual(JSON.parse(run(['fleet', 'clients', '--offline', '--json'], { cwd: root }).stdout).apps.map((a) => a.path), ['clients/leaky', 'clients/clean']);
  assert.equal(out.apps[0].ratings.find((x) => x.key === 'security').rating, 'E');
  assert.equal(run(['fleet', root, '--offline', '--fail-on', 'never']).status, 0);
  const html = path.join(root, 'fleet.html');
  run(['fleet', path.join(root, 'clients/clean'), path.join(root, 'clients/leaky'), '--offline', '--html', html]);
  assert.match(fs.readFileSync(html, 'utf8'), /<b>2<\/b><span>apps<\/span>/);
  assert.equal(run(['fleet', path.join(root, 'tools'), '--offline']).status, 2, 'no app found');
});

test('fleet: output escapes app data and keeps apps that could not be scanned', () => {
  const rows = sortFleet([
    { app: 'ok', path: 'a', ratings: ratings([]), critical: 0, high: 0, deadlines: [] },
    { app: 'x', path: 'b|<script>', error: 'No package.json' },
    { app: 'bad', path: 'c', ratings: ratings([{ area: 'store', severity: 'critical' }]), critical: 1, high: 0, deadlines: ['Target SDK <36>'] },
  ]);
  assert.deepEqual(rows.map((r) => r.app), ['bad', 'ok', 'x']);
  const html = fleetHtml(rows);
  assert.ok(!html.includes('<script>') && html.includes('Target SDK &lt;36&gt;'));
  assert.match(fleetMarkdown(rows), /b\\\|&lt;script&gt;/);
});
