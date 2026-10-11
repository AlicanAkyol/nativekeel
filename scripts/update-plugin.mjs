// Points the Claude Code plugin at a published NativeKeel version: plugin.json version,
// the dependency in plugins/nativekeel/package.json, and a fresh package-lock.json with the
// tarball's integrity hash. Runs in CI after `npm publish`, because the hash exists only then.
// Usage: node scripts/update-plugin.mjs [version]   (default: package.json version)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'plugins', 'nativekeel');
const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`bad version: ${version}`);

const edit = (file, fn) => {
  const p = path.join(dir, file);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(json);
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
};
edit('.claude-plugin/plugin.json', (j) => (j.version = version));
// The Codex plugin (Agent Plugins format) has no lockfile install, so it pins npx to the version.
const codex = path.join(root, 'plugins', 'codex', 'nativekeel');
const editCodex = (file, fn) => {
  const p = path.join(codex, file);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(json);
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
};
editCodex('plugin.json', (j) => (j.version = version));
editCodex('mcp.json', (j) => (j.mcpServers.nativekeel.args = ['-y', `nativekeel@${version}`, 'mcp']));
fs.copyFileSync(path.join(dir, 'skills/react-native-health/SKILL.md'), path.join(codex, 'skills/react-native-health/SKILL.md'));
edit('package.json', (j) => (j.dependencies = { nativekeel: version }));
fs.rmSync(path.join(dir, 'package-lock.json'), { force: true });
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
const entry = lock.packages['node_modules/nativekeel'];
if (!entry || entry.version !== version || !/^sha512-/.test(entry.integrity || '')) throw new Error('lockfile does not pin the published version with an integrity hash');
console.log(`plugin now runs nativekeel@${version} (${entry.integrity.slice(0, 20)}…)`);
