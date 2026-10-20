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

test('script injection: untrusted text pasted into a run script in a privileged workflow', async () => {
  const { ciScriptInjection } = await import('../src/ci-security.js');
  const run2 = (yml) => ciScriptInjection(makeProject({ '.github/workflows/w.yml': yml }));
  const triage = (step, on = 'issues:\n    types: [opened]') => `on:\n  ${on}\njobs:\n  triage:\n    runs-on: ubuntu-latest\n    steps:\n${step}`;
  const [f] = run2(triage('      - run: echo "New issue: ${{ github.event.issue.title }}"\n'));
  assert.equal(f.severity, 'critical');
  assert.match(f.detail, /uses \$\{\{ github\.event\.issue\.title \}\} in a script/);
  assert.equal(run2(triage('      - uses: actions/github-script@v7\n        with:\n          script: |\n            core.info("${{ github.event.comment.body }}")\n', 'issue_comment:')).length, 1);
  for (const yml of [
    triage('      - env:\n          TITLE: ${{ github.event.issue.title }}\n        run: echo "$TITLE"\n'),
    triage('      - run: echo "${{ github.event.issue.number }}"\n'),
    triage('      - run: echo "${{ github.head_ref }}"\n', 'pull_request:'),
    `on:\n  pull_request_target:\njobs:\n  rc:\n    if: github.event.pull_request.user.login == 'release-bot'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "\${{ github.head_ref }}"\n`,
  ]) assert.deepEqual(run2(yml), [], yml);
});
