import test from 'node:test';
import assert from 'node:assert/strict';
import { ciSecurity } from '../src/ci-security.js';
import { makeProject } from './helpers.js';

const wf = (jobs, extra = '') => `name: ci\non:\n  pull_request_target:\n    types: [opened, synchronize]\n${extra}jobs:\n${jobs}`;
const checkoutHead = `      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`;
const run = (yml) => ciSecurity(makeProject({ '.github/workflows/ci.yml': yml }));

test('pull_request_target that checks out and runs the pull request', () => {
  const [f] = run(wf(`  test:\n    runs-on: ubuntu-latest\n    env:\n      DB: \${{ secrets.DATABASE_URL }}\n    steps:\n${checkoutHead}      - run: npm ci\n      - run: npm test\n`));
  assert.equal(f.severity, 'critical');
  assert.match(f.detail, /job test\) checks out the pull request and runs a step at line \d+, with secrets in scope/);
  const [readOnly] = run(wf(`  lint:\n    runs-on: ubuntu-latest\n    steps:\n${checkoutHead}      - run: npm run lint\n`, 'permissions:\n  contents: read\n'));
  assert.equal(readOnly.severity, 'high');
});

test('guarded or harmless pull_request_target jobs are not reported', () => {
  for (const yml of [
    wf(`  test:\n    if: github.event.pull_request.head.repo.full_name == github.repository\n    runs-on: ubuntu-latest\n    steps:\n${checkoutHead}      - run: npm test\n`),
    wf(`  authorize:\n    environment: external\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n  test:\n    needs: authorize\n    runs-on: ubuntu-latest\n    steps:\n${checkoutHead}      - run: npm test\n`),
    wf(`  label:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: node scripts/label.js\n`),
    wf(`  comment:\n    runs-on: ubuntu-latest\n    steps:\n${checkoutHead}      - uses: actions/github-script@v7\n`),
    `name: ci\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${checkoutHead}      - run: npm test\n`,
  ]) assert.deepEqual(run(yml), [], yml);
});
