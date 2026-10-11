import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyUpgrade } from '../src/verify.js';
import { gitArchive } from '../src/git.js';
import { handle, allowedRoots } from '../src/mcp.js';
import { makeProject } from './helpers.js';

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('nativekeel-base-')).length;

function repo() {
  const root = makeProject({
    'package.json': { name: 'app', dependencies: { 'react-native': '0.80.0' } },
    'src/A.js': "import { SafeAreaView } from 'react-native';\nexport const A = () => <SafeAreaView />;\n",
  });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  return root;
}

test('verify: fixed and new findings against HEAD, temp copy removed', async () => {
  const root = repo();
  const before = leftovers();
  fs.writeFileSync(path.join(root, 'src/A.js'), "import { SafeAreaView } from 'react-native-safe-area-context';\nexport const A = () => <SafeAreaView />;\n");
  fs.writeFileSync(path.join(root, 'src/key.js'), "export const k = 'AKIA" + 'ABCDEFGHIJKLMNOP' + "';\n");
  const r = await verifyUpgrade(root);
  assert.ok(r.diff.fixed.some((f) => f.id === 'deprecated-core-imports'));
  assert.ok(r.diff.added.some((f) => f.severity === 'critical'), 'a committed AWS key is new and critical');
  assert.equal(r.ok, false);
  assert.match(r.commit, /^[0-9a-f]{40}$/);
  assert.equal(leftovers(), before);
});

test('verify: refuses option-like and range revisions, and folders outside git', async () => {
  const root = repo();
  for (const ref of ['--output=/tmp/x', '-h', 'HEAD..main', 'a b', '@{-1}', '']) assert.ok(gitArchive(root, ref).error, ref || '(empty)');
  await assert.rejects(verifyUpgrade(root, { base: 'no-such-branch' }), /unknown revision/);
  await assert.rejects(verifyUpgrade(makeProject({ 'package.json': '{}' })), /not a git repository|unknown revision/);
});

test("verify: the repository's own git config cannot run a program", async () => {
  const root = repo();
  const marker = path.join(os.tmpdir(), `nk-verify-fsmonitor-${process.pid}`);
  fs.rmSync(marker, { force: true });
  git(root, 'config', 'core.fsmonitor', `touch ${marker}; false`);
  await verifyUpgrade(root);
  assert.equal(fs.existsSync(marker), false);
});

test('MCP: verify_upgrade', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'src/A.js'), "import { SafeAreaView } from 'react-native-safe-area-context';\n");
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_upgrade', arguments: { path: root } } }, { version: 't', roots: allowedRoots({}, root) });
  const p = res.result.structuredContent;
  assert.equal(p.ok, true);
  assert.equal(p.fixed[0].id, 'deprecated-core-imports');
  assert.match(p.verdict, /No new critical or high/);
});

test('MCP verify retains an existing malware stop while ok still means no new serious findings', async () => {
  const root = makeProject({ 'package.json': { name: 'app', dependencies: { 'react-native': '0.86.0' } }, '.vscode/tasks.json': { tasks: [{ command: 'node fonts/audit.woff2', runOptions: { runOn: 'folderOpen' } }] } });
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  try {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_upgrade', arguments: { path: root } } }, { version: 'test', roots: [fs.realpathSync(root)] });
    assert.equal(res.result.isError, false);
    assert.equal(res.result.structuredContent.ok, true);
    assert.equal(res.result.structuredContent.safety.blocked, true);
    assert.match(res.result.structuredContent.warning, /Do not run/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('MCP verify refuses a repository redirected to git metadata outside its allowed roots', async () => {
  const outside = makeProject({ 'package.json': { name: 'outside', dependencies: { 'react-native': '0.86.0' } } });
  const root = makeProject({ 'package.json': { name: 'inside', dependencies: { 'react-native': '0.86.0' } } });
  git(outside, 'init', '-q'); git(outside, 'add', '.');
  git(outside, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  try {
    fs.symlinkSync(path.join(outside, '.git'), path.join(root, '.git'));
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verify_upgrade', arguments: { path: root } } }, { version: 'test', roots: [fs.realpathSync(root)] });
    assert.equal(res.result.isError, true);
  } finally { for (const dir of [root, outside]) fs.rmSync(dir, { recursive: true, force: true }); }
});
