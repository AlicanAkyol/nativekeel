import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProject } from './helpers.js';

// End-to-end: run the real CLI the way users do. --offline keeps these tests off the network.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nativekeel.js');
const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });

function app() {
  return makeProject({
    'package.json': { name: 'cli-app', dependencies: { 'react-native': '0.80.0' } },
    'src/keys.js': "export const k = 'AKIAIOSFODNN7EXAMPLE';\n",
  });
}

test('exit codes follow --fail-on', () => {
  const root = app();
  assert.equal(run([root, '--offline']).status, 1, 'critical finding fails by default');
  assert.equal(run([root, '--offline', '--fail-on', 'never']).status, 0);
  assert.equal(run([root, '--offline', '--fail-on', 'nope']).status, 2);
  const clean = makeProject({ 'package.json': { name: 'ok', dependencies: { 'react-native': '0.80.0' } } });
  assert.equal(run([clean, '--offline']).status, 0);
});

test('report files: JSON, HTML, Markdown, SARIF', () => {
  const root = app();
  const out = (f) => path.join(root, f);
  const r = run([root, '--offline', '--json', '--html', out('r.html'), '--markdown', out('r.md'), '--sarif', out('r.sarif')]);
  const json = JSON.parse(r.stdout);
  assert.equal(json.tool, 'nativekeel');
  assert.ok(json.findings.some((f) => f.id === 'secret:aws-access-key:src/keys.js'));
  assert.match(fs.readFileSync(out('r.html'), 'utf8'), /<!doctype html>/);
  assert.match(fs.readFileSync(out('r.md'), 'utf8'), /NativeKeel health report/);
  assert.equal(JSON.parse(fs.readFileSync(out('r.sarif'), 'utf8')).version, '2.1.0');
  for (const f of ['r.html', 'r.md', 'r.sarif']) {
    assert.ok(!fs.readFileSync(out(f), 'utf8').includes('AKIAIOSFODNN7EXAMPLE'), `${f} never contains the secret`);
  }
  assert.ok(!r.stdout.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('plan, baseline and compare commands', () => {
  const root = app();
  const plan = run(['plan', root, '--offline']);
  assert.equal(plan.status, 0);
  assert.match(plan.stdout, /# Upgrade plan: cli-app/);
  assert.match(plan.stdout, /Stop the leaks/);

  const baseline = path.join(root, 'baseline.json');
  run([root, '--offline', '--save-baseline', baseline]);
  assert.equal(run([root, '--offline', '--baseline', baseline]).status, 0, 'known findings do not fail CI');

  const before = path.join(root, 'before.json');
  fs.writeFileSync(before, run([root, '--offline', '--json']).stdout);
  fs.writeFileSync(path.join(root, 'src/keys.js'), '// removed\n');
  const after = path.join(root, 'after.json');
  fs.writeFileSync(after, run([root, '--offline', '--json']).stdout);
  const cmp = run(['compare', before, after]);
  assert.equal(cmp.status, 0);
  assert.match(cmp.stdout, /✅ AWS access key ID shipped inside the app/);
});

test('helpful errors', () => {
  const notRn = makeProject({ 'package.json': { name: 'web', dependencies: { next: '15.0.0' } } });
  const r = run([notRn]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not look like a React Native app/);
  assert.equal(run(['compare', 'only-one.json']).status, 2);
  assert.match(run(['--help']).stdout, /Usage/);
  assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+/);
});
