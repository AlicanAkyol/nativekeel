import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareImports } from '../src/prepare-imports.js';
import { compareImports } from '../src/compare-imports.js';
import { sha256 } from '../src/experiment-input.js';
import { makeProject } from './helpers.js';
import readFs from '../src/read-boundary.js';

const CLI = fileURLToPath(new URL('../bin/nativekeel.js', import.meta.url));
function fixture(t) {
  const context = { platform: 'android', mode: 'release', variant: 'test', artifactKind: 'javascript-bundle', reactNative: '0.80.0', engine: 'hermes', bundler: 'metro-test', lodashVersion: '4.17.21', buildSettingsHash: sha256('settings') };
  const input = { schemaVersion: 1, recipe: 'lodash-import-scope' };
  for (const side of ['before', 'after']) input[side] = { file: `${side}.bundle`, source: { root: `${side}-source`, files: ['App.ts', 'package.json'] }, context };
  const root = makeProject({
    'settings.json': input,
    'before.bundle': 'synthetic-baseline-bytes', 'after.bundle': 'changed-bytes',
    'before-source/App.ts': "import {debounce} from 'lodash';",
    'after-source/App.ts': "import debounce from 'lodash/debounce';",
    'before-source/package.json': { dependencies: { lodash: '4.17.21' } },
    'after-source/package.json': { dependencies: { lodash: '4.17.21' } },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, settings: path.join(root, 'settings.json'), experiment: path.join(root, 'experiment.json') };
}
function save(file, object) { fs.writeFileSync(file, JSON.stringify(object)); }

test('preparation captures files but does not fabricate completed review or tests', (t) => {
  const f = fixture(t);
  const result = prepareImports(f.settings);
  assert.equal(result.before.sha256, sha256('synthetic-baseline-bytes'));
  assert.equal(result.verification.behaviorTests, 'not-run');
  assert.equal(result.verification.onlyImportChange, false);
  assert.doesNotMatch(JSON.stringify(result), /import \{debounce\}/, 'no source content is returned');
  save(f.experiment, result);
  const comparison = compareImports(f.experiment);
  assert.equal(comparison.status, 'incomparable');
  assert.equal(comparison.comparison, null);
  assert.equal(comparison.provenance.sourceHashes, 'verified-selected-files');
  assert.deepEqual(comparison.sourceChanges.paths, ['App.ts']);
  const cli = spawnSync(process.execPath, [CLI, 'prepare-imports', f.settings], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), result);
});

test('prepared evidence can be compared after explicit review; source edits invalidate it', (t) => {
  const f = fixture(t);
  const result = prepareImports(f.settings);
  result.verification = { onlyImportChange: true, samePackageVersion: true, behaviorTests: 'passed', testScope: ['synthetic test only'] };
  save(f.experiment, result);
  assert.equal(compareImports(f.experiment).status, 'reported-context-size-reduction');
  fs.appendFileSync(path.join(f.root, 'after-source/App.ts'), '\nthrow new Error("not executed");');
  assert.throws(() => compareImports(f.experiment), /Source inventory changed/);
});

test('source selection is deterministic but explicitly incomplete and rejects duplicates', (t) => {
  const f = fixture(t);
  const first = prepareImports(f.settings);
  const config = JSON.parse(fs.readFileSync(f.settings));
  config.before.source.files.reverse();
  save(f.settings, config);
  assert.equal(prepareImports(f.settings).before.sourceSnapshotHash, first.before.sourceSnapshotHash);
  assert.match(first.preparation.sourceCoverage, /not verified complete/);
  config.before.source.files.push('App.ts'); save(f.settings, config);
  assert.throws(() => prepareImports(f.settings), /Duplicate/);
});

test('missing, outside and oversized source files are rejected without running source', (t) => {
  const f = fixture(t);
  const config = JSON.parse(fs.readFileSync(f.settings));
  for (const files of [[], ['missing.ts'], ['../before.bundle']]) {
    config.before.source.files = files; save(f.settings, config);
    assert.throws(() => prepareImports(f.settings));
  }
  config.before.source.files = ['App.ts']; save(f.settings, config);
  fs.truncateSync(path.join(f.root, 'before-source/App.ts'), 8 * 1024 * 1024 + 1);
  assert.throws(() => prepareImports(f.settings), /size limit/);
});

test('source symlink escape and mixed evidence modes are rejected', (t) => {
  const f = fixture(t);
  const result = prepareImports(f.settings);
  delete result.after.sourceInventory;
  save(f.experiment, result);
  assert.match(compareImports(f.experiment).reasons.join(' '), /same source evidence mode/);
  const p = path.join(f.root, 'before-source/App.ts');
  fs.unlinkSync(p);
  fs.symlinkSync('../before.bundle', p);
  assert.throws(() => prepareImports(f.settings), /outside the experiment folder/);
});

test('a declared passed review cannot override changed package metadata or selection coverage', (t) => {
  for (const kind of ['package', 'coverage']) {
    const f = fixture(t);
    if (kind === 'package') save(path.join(f.root, 'after-source/package.json'), { dependencies: { lodash: '4.17.20' } });
    else {
      const config = JSON.parse(fs.readFileSync(f.settings));
      config.after.source.files = ['App.ts'];
      save(f.settings, config);
    }
    const result = prepareImports(f.settings);
    result.verification = { onlyImportChange: true, samePackageVersion: true, behaviorTests: 'passed', testScope: ['reported test'] };
    save(f.experiment, result);
    const comparison = compareImports(f.experiment);
    assert.equal(comparison.status, 'incomparable');
    assert.equal(comparison.comparison, null);
    assert.match(comparison.reasons.join(' '), kind === 'package' ? /configuration file changed/ : /source file sets differ/);
  }
});

test('preparation rejects unsupported contexts and ignores unrecognized metadata', (t) => {
  const f = fixture(t);
  const config = JSON.parse(fs.readFileSync(f.settings));
  config.before.context.unrecognized = 'NOT_PART_OF_THE_REPORT';
  save(f.settings, config);
  assert.doesNotMatch(JSON.stringify(prepareImports(f.settings)), /NOT_PART_OF_THE_REPORT/);
  config.before.context.mode = 'debug'; save(f.settings, config);
  assert.throws(() => prepareImports(f.settings), /release/);
});

test('a directory replaced during open cannot expose source outside the selected root', (t) => {
  const f = fixture(t);
  const outside = makeProject({ 'App.ts': 'OUTSIDE_SOURCE_MUST_NOT_BE_READ' });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const dir = fs.realpathSync(path.join(f.root, 'before-source'));
  const target = path.join(dir, 'App.ts');
  const originalOpen = readFs.openSync;
  const originalRead = readFs.readSync;
  let exchanged = false, outsideFd, readOutside = false;
  readFs.openSync = (file, ...args) => {
    if (file === target && !exchanged) {
      exchanged = true;
      fs.renameSync(dir, `${dir}-original`);
      fs.symlinkSync(outside, dir);
      outsideFd = originalOpen(file, ...args);
      return outsideFd;
    }
    return originalOpen(file, ...args);
  };
  readFs.readSync = (fd, ...args) => { if (fd === outsideFd) readOutside = true; return originalRead(fd, ...args); };
  try {
    assert.throws(() => prepareImports(f.settings), /outside the experiment folder/);
    assert.equal(exchanged, true);
    assert.equal(readOutside, false);
  } finally {
    readFs.openSync = originalOpen;
    readFs.readSync = originalRead;
  }
});
