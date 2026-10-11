import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeProject, fakeRegistry } from './helpers.js';
import { loadProject } from '../src/project.js';
import { analyze } from '../src/analyze.js';
import { buildPlan } from '../src/plan.js';
import { handle } from '../src/mcp.js';

test('MCP preserves the recipe evidence and does not manufacture a measured benefit', async (t) => {
  const root = makeProject({
    'package.json': { name: 'import-review', dependencies: { 'react-native': '0.80.0', lodash: '4.17.21' } },
    'App.js': "import { debounce } from 'lodash';",
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'scan_project', arguments: { path: root, offline: true } } }, { roots: [fs.realpathSync(root)], version: 'test' });
  assert.equal(r.result.isError, false);
  const recipe = r.result.structuredContent.findings.find((f) => f.id === 'perf-heavy-imports').recommendation;
  assert.equal(recipe.recipe, 'lodash-import-scope');
  assert.equal(recipe.measuredBenefit, null);
  assert.equal(recipe.status, 'needs-verification');
  assert.equal(recipe.evidence[0].file, 'App.js:1');
});

test('a usage candidate retains upgrade advice and has no unconditional remove command', async (t) => {
  const root = makeProject({
    'package.json': { name: 'review', dependencies: { 'react-native': '0.80.0', 'test-lib': '1.0.0' } },
    'node_modules/react-native/package.json': { version: '0.80.0' },
    'node_modules/test-lib/package.json': { version: '1.0.0' },
    'src/App.js': 'export default null;',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scan = await analyze(loadProject(root), { get: fakeRegistry({ latest: { 'test-lib': '2.0.0' } }) });
  const finding = scan.findings.find((f) => f.id === 'unused:test-lib');
  assert.equal(finding.fix.kind, 'review-dep');
  assert.match(finding.detail, /may still need it/);
  assert.ok(scan.findings.some((f) => f.fix?.kind === 'bump-dep' && f.fix.name === 'test-lib'), 'candidate does not suppress the upgrade');
  const phase = buildPlan(scan).phases.find((p) => p.title === 'Review dependency usage before removal');
  assert.ok(phase);
  assert.doesNotMatch(JSON.stringify(phase), /npm (?:uninstall|remove)|yarn remove|pnpm remove/);
});

test('real MCP stdio from a plugin folder scans without custom server env', (t) => {
  const project = fs.realpathSync(fileURLToPath(new URL('./fixtures/action-app', import.meta.url)));
  if (!project.startsWith(fs.realpathSync(os.homedir()) + path.sep)) return t.skip('checkout must be inside the user home to exercise the plugin default boundary');
  const plugin = makeProject({ 'plugin.json': '{}' });
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const env = { ...process.env, PLUGIN_ROOT: plugin };
  delete env.NATIVEKEEL_MCP_ROOTS;
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'scan_project', arguments: { path: project, offline: true } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'improve_app', arguments: { path: project, offline: true } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/nativekeel.js', import.meta.url)), 'mcp'], { cwd: plugin, env, input, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const replies = r.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies.length, 3);
  assert.equal(replies[2].result.isError, false, JSON.stringify(replies[2]));
  assert.equal(replies[2].result.structuredContent.schemaVersion, 1);
  assert.equal(replies[1].result.isError, false, JSON.stringify(replies[1]));
  assert.ok(replies[1].result.structuredContent.project.reactNative);
  assert.doesNotMatch(r.stdout, /No project folders configured/);
});
