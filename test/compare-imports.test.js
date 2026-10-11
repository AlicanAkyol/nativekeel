import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareImports } from '../src/compare-imports.js';
import { makeProject } from './helpers.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const CLI = fileURLToPath(new URL('../bin/nativekeel.js', import.meta.url));
function experiment(t, change = () => {}, after = 'after') {
  const before = 'before - synthetic test bytes';
  const context = { platform: 'android', mode: 'release', variant: 'arm64', artifactKind: 'javascript-bundle', reactNative: '0.80.0', engine: 'hermes', bundler: 'metro-test', lodashVersion: '4.17.21', buildSettingsHash: sha('settings') };
  const input = {
    schemaVersion: 1, recipe: 'lodash-import-scope',
    before: { file: 'before.bundle', sha256: sha(before), sourceSnapshotHash: sha('source-before'), context: { ...context } },
    after: { file: 'after.bundle', sha256: sha(after), sourceSnapshotHash: sha('source-after'), context: { ...context } },
    verification: { onlyImportChange: true, samePackageVersion: true, behaviorTests: 'passed', testScope: ['synthetic debounce contract'] },
  };
  change(input);
  const root = makeProject({ 'before.bundle': before, 'after.bundle': after, 'experiment.json': input });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'experiment.json');
}

test('import comparison measures actual bytes and keeps reported context separate', (t) => {
  const file = experiment(t);
  const r = compareImports(file);
  assert.equal(r.status, 'reported-context-size-reduction');
  assert.equal(r.comparison.reductionBytes, Buffer.byteLength('before - synthetic test bytes') - 5);
  assert.equal(r.provenance.buildContext, 'caller-reported');
  assert.equal(r.recommendation, 'requires-review');
  assert.match(r.limits.join(' '), /not installed app size/);
  const cli = spawnSync(process.execPath, [CLI, 'compare-imports', file, '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), r);
});

test('growth and unchanged artifacts do not become benefits', (t) => {
  for (const bytes of ['x'.repeat(100), 'before - synthetic test bytes']) {
    const r = compareImports(experiment(t, undefined, bytes));
    assert.equal(r.status, 'no-size-reduction');
    assert.ok(r.comparison.reductionBytes <= 0);
  }
});

test('platform, format, toolchain and settings mismatches block the comparison', (t) => {
  for (const [key, value] of Object.entries({ platform: 'ios', artifactKind: 'hermes-bytecode', variant: 'arm32', engine: 'jsc', reactNative: '0.81.0', bundler: 'other', lodashVersion: '4.17.20', buildSettingsHash: sha('other') })) {
    const file = experiment(t, (i) => { i.after.context[key] = value; });
    const r = compareImports(file);
    assert.equal(r.status, 'incomparable', key);
    assert.equal(r.comparison, null);
  }
});

test('missing or failed behavior verification and unchanged sources block the comparison', (t) => {
  for (const change of [
    (i) => { delete i.verification; },
    (i) => { i.verification.behaviorTests = 'failed'; },
    (i) => { i.verification.onlyImportChange = false; },
    (i) => { i.verification.samePackageVersion = false; },
    (i) => { i.verification.testScope = []; },
    (i) => { i.after.sourceSnapshotHash = i.before.sourceSnapshotHash; },
  ]) assert.equal(compareImports(experiment(t, change)).comparison, null);
  const file = experiment(t, (i) => { i.verification.behaviorTests = 'failed'; });
  assert.equal(spawnSync(process.execPath, [CLI, 'compare-imports', file]).status, 2);
});

test('modified artifacts, debug builds, bad schema and empty bundles are rejected', (t) => {
  for (const change of [
    (i) => { i.after.sha256 = sha('wrong'); },
    (i) => { i.before.context.mode = 'debug'; },
    (i) => { i.schemaVersion = 9; },
    (i) => { i.recipe = 'unknown'; },
    (i) => { delete i.after.sourceSnapshotHash; },
  ]) assert.throws(() => compareImports(experiment(t, change)));
  assert.throws(() => compareImports(experiment(t, undefined, '')), /empty artifact/);
});

test('artifact traversal and symlink escapes are rejected', (t) => {
  for (const file of ['../outside', '/tmp/outside']) assert.throws(() => compareImports(experiment(t, (i) => { i.before.file = file; })), /relative artifact path/);
  const manifest = experiment(t);
  const other = makeProject({ 'bundle': 'before - synthetic test bytes' });
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const before = path.join(path.dirname(manifest), 'before.bundle');
  fs.unlinkSync(before);
  fs.symlinkSync(path.join(other, 'bundle'), before);
  assert.throws(() => compareImports(manifest), /outside the experiment folder/);
});

test('bundle input is never executed and a size limit is enforced', (t) => {
  const manifest = experiment(t, undefined, "throw new Error('must never execute');");
  assert.doesNotThrow(() => compareImports(manifest));
  const bundle = path.join(path.dirname(manifest), 'after.bundle');
  fs.truncateSync(bundle, 64 * 1024 * 1024 + 1);
  assert.throws(() => compareImports(manifest), /size limit/);
});
