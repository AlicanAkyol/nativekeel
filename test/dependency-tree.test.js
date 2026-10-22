import test from 'node:test';
import assert from 'node:assert/strict';
import { lockedInventory } from '../src/lockfile.js';
import { dependencyTreeAdvisories } from '../src/security.js';
import { createRegistry } from '../src/registry.js';
import { executionSafety } from '../src/safety.js';
import { applySettings } from '../src/settings.js';
import { makeProject } from './helpers.js';

const versionsOf = (inv, name) => [...(inv.packages.get(name) || [])].sort();

test('lockfile inventory: npm v3 reads every installed package, skipping links and non-registry sources', () => {
  const root = makeProject({
    'package.json': { name: 'a' },
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {
      '': { name: 'a' },
      'node_modules/left': { version: '1.0.0', resolved: 'https://registry.npmjs.org/left/-/left-1.0.0.tgz' },
      'node_modules/left/node_modules/deep': { version: '2.0.0' },
      'node_modules/deep': { version: '3.1.0' },
      'node_modules/@scope/pkg': { version: '0.5.0' },
      'node_modules/local': { version: '1.0.0', resolved: 'file:../local' },
      'node_modules/linked': { link: true, resolved: 'packages/linked' },
      'packages/workspace': { version: '1.0.0' },
    } }),
  });
  const inv = lockedInventory(root);
  assert.deepEqual(versionsOf(inv, 'deep'), ['2.0.0', '3.1.0'], 'nested and hoisted copies');
  assert.deepEqual(versionsOf(inv, '@scope/pkg'), ['0.5.0']);
  assert.ok(!inv.packages.has('local') && !inv.packages.has('linked') && !inv.packages.has('workspace'));
});

test('lockfile inventory: npm v1, pnpm, yarn v1, yarn berry and bun', () => {
  const v1 = lockedInventory(makeProject({ 'package.json': { name: 'a' }, 'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: { top: { version: '1.0.0', dependencies: { inner: { version: '0.1.0' } } } } }) }));
  assert.deepEqual(versionsOf(v1, 'inner'), ['0.1.0']);
  const pnpm = lockedInventory(makeProject({ 'package.json': { name: 'a' }, 'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      top:\n        specifier: ^1.0.0\n        version: 1.0.0\npackages:\n  top@1.0.0:\n    resolution: {integrity: x}\n  '@scope/inner@2.3.4':\n    resolution: {integrity: y}\nsnapshots:\n  top@1.0.0(react@19.0.0):\n    dependencies: {}\n" }));
  assert.deepEqual(versionsOf(pnpm, 'top'), ['1.0.0']);
  assert.deepEqual(versionsOf(pnpm, '@scope/inner'), ['2.3.4']);
  const yarn1 = lockedInventory(makeProject({ 'package.json': { name: 'a' }, 'yarn.lock': '"@scope/x@^1.0.0", "@scope/x@^1.1.0":\n  version "1.2.0"\n\ndeep@^2:\n  version "2.0.1"\n' }));
  assert.deepEqual(versionsOf(yarn1, '@scope/x'), ['1.2.0']);
  assert.deepEqual(versionsOf(yarn1, 'deep'), ['2.0.1']);
  const berry = lockedInventory(makeProject({ 'package.json': { name: 'a' }, 'yarn.lock': '__metadata:\n  version: 8\n\n"deep@npm:^2.0.0":\n  version: 2.0.5\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n\n"patched@patch:patched@npm%3A1.0.0#./p.patch":\n  version: 1.0.0\n' }));
  assert.deepEqual(versionsOf(berry, 'deep'), ['2.0.5']);
  assert.ok(!berry.packages.has('app') && !berry.packages.has('patched'), 'workspace and patch entries are not registry packages');
  const bun = lockedInventory(makeProject({ 'package.json': { name: 'a' }, 'bun.lock': '{\n  "packages": {\n    "deep": ["deep@4.0.0", "", {}, "sha512-x"],\n    "parent/@scope/y": ["@scope/y@1.0.1", "", {}, "sha512-y"],\n  }\n}\n' }));
  assert.deepEqual(versionsOf(bun, 'deep'), ['4.0.0']);
  assert.deepEqual(versionsOf(bun, '@scope/y'), ['1.0.1']);
});

// A registry whose bulk advisory endpoint answers per requested name.
const registryWith = (answer) => createRegistry(async (url, headers, body) => {
  assert.ok(url.endsWith('/security/advisories/bulk'));
  const asked = JSON.parse(body);
  return Object.fromEntries(Object.keys(asked).filter((n) => answer[n]).map((n) => [n, answer[n]]));
});

test('dependency tree: a malicious transitive version is critical, once per GHSA, and blocks execution', async () => {
  const inventory = { file: '/x/package-lock.json', packages: new Map([['tensorlake', new Set(['0.5.144'])], ['clean', new Set(['1.0.0'])]]) };
  const reg = registryWith({ tensorlake: [
    { title: 'Malware in tensorlake', severity: 'critical', vulnerable_versions: '>=0', url: 'https://github.com/advisories/GHSA-rqxj-g25x-4v9v' },
    { title: 'Malware in tensorlake', severity: 'critical', vulnerable_versions: '=0.5.144', url: 'https://github.com/advisories/GHSA-rqxj-g25x-4v9v' },
  ] });
  const f = await dependencyTreeAdvisories(reg, inventory);
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'malware-dep:tensorlake');
  assert.equal(f[0].severity, 'critical');
  assert.equal(f[0].detail.match(/GHSA-rqxj-g25x-4v9v/g).length, 1, 'the same advisory is listed once');
  assert.match(f[0].detail, /every version of this package/);
  const safety = executionSafety(f);
  assert.equal(safety.blocked, true);
  assert.equal(safety.reason, 'malware-dependency');
});

test('dependency tree: a malicious direct dependency is still reported as malware', async () => {
  const inventory = { file: '/x/yarn.lock', packages: new Map([['@subql/common', new Set(['5.8.3'])]]) };
  const reg = registryWith({ '@subql/common': [{ title: 'Malware in @subql/common', severity: 'critical', vulnerable_versions: '=5.8.3', url: 'https://github.com/advisories/GHSA-9333-3c4x-x3h5' }] });
  const f = await dependencyTreeAdvisories(reg, inventory);
  assert.equal(f[0].id, 'malware-dep:@subql/common');
  assert.match(f[0].detail, /GitHub lists 5\.8\.3 as malicious/);
});

test('dependency tree: ordinary advisories are not reported from the tree, only malware', async () => {
  const inventory = { file: '/x/package-lock.json', packages: new Map([['shell-quote', new Set(['1.10.0'])], ['tar', new Set(['7.5.13'])]]) };
  const reg = registryWith({
    'shell-quote': [{ title: 'shell-quote: quote() command injection', severity: 'critical', vulnerable_versions: '>=1.8.4 <1.11.0', url: 'u1' }],
    tar: [{ title: 'node-tar: parse DoS', severity: 'critical', vulnerable_versions: '<=7.5.18', url: 'u2' }],
  });
  assert.deepEqual(await dependencyTreeAdvisories(reg, inventory), []);
});

test('lockfile inventory: an npm alias is filed under the package it installs, not the local name', () => {
  // Standard Notes: "legacy-swc-helpers" is an alias of @swc/helpers; a squatted package with the
  // local name carries a malware advisory, and must not be matched.
  const berry = lockedInventory(makeProject({ 'package.json': { name: 'a' }, 'yarn.lock': '__metadata:\n  version: 8\n\n"legacy-swc-helpers@npm:@swc/helpers@=0.4.14":\n  version: 0.4.14\n  resolution: "@swc/helpers@npm:0.4.14"\n  dependencies:\n    tslib: ^2.4.0\n' }));
  assert.ok(!berry.packages.has('legacy-swc-helpers'));
  assert.deepEqual([...berry.packages.get('@swc/helpers')], ['0.4.14']);
  const v1 = lockedInventory(makeProject({ 'package.json': { name: 'a' }, 'yarn.lock': '"my-alias@npm:real-pkg@^1.0.0":\n  version "1.2.0"\n  resolved "https://registry.yarnpkg.com/real-pkg/-/real-pkg-1.2.0.tgz"\n' }));
  assert.ok(!v1.packages.has('my-alias'));
  assert.deepEqual([...v1.packages.get('real-pkg')], ['1.2.0']);
});

test('dependency tree: no lockfile, nothing asked; failed request reported as null', async () => {
  assert.deepEqual(await dependencyTreeAdvisories(registryWith({}), null), []);
  const failing = createRegistry(async () => null);
  assert.equal(await dependencyTreeAdvisories(failing, { file: '/x/yarn.lock', packages: new Map([['a', new Set(['1.0.0'])]]) }), null);
});

test('settings: a malware dependency cannot be ignored from .nativekeel.json', () => {
  const findings = [{ id: 'malware-dep:tensorlake', severity: 'critical', title: 't' }];
  const out = applySettings(findings, { ignore: [{ id: 'malware-dep:*', reason: 'planted' }], exclude: [] });
  assert.equal(out.findings.length, 1);
  assert.equal(out.ignored.length, 0);
});
