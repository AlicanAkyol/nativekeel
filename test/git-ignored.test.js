import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadProject } from '../src/project.js';
import { performanceChecks } from '../src/performance.js';
import { scanSecrets } from '../src/secrets.js';
import { gitIgnored } from '../src/git.js';
import { makeProject, FAKE_AWS_ID } from './helpers.js';

const logs = Array.from({ length: 30 }, (_, i) => `console.log('x${i}');`).join('\n');

test('code in folders git ignores is not scanned; an ignored .env is still read for secrets', () => {
  const root = makeProject({
    'package.json': { name: 'p', dependencies: { 'react-native': '0.80.0', 'react-native-config': '1.5.0' } },
    '.gitignore': 'scratch/\n.env\n',
    'scratch/Debug.js': logs,
    'src/App.js': 'export default 1;\n',
    '.env': `AWS_KEY=${FAKE_AWS_ID}\n`,
  });
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '-A'], { cwd: root });
  assert.ok(gitIgnored(root)(`${root}/scratch/Debug.js`));
  assert.ok(!gitIgnored(root)(`${root}/src/App.js`));
  assert.ok(!performanceChecks(loadProject(root)).some((f) => f.id === 'perf-console-in-release'), 'ignored folder');
  const env = scanSecrets(root).find((s) => s.file === '.env');
  assert.ok(env && env.inAppBundle, 'react-native-config compiles the ignored .env into the app');

  const plain = makeProject({ 'package.json': { name: 'p', dependencies: { 'react-native': '0.80.0' } }, 'scratch/Debug.js': logs });
  assert.ok(performanceChecks(loadProject(plain)).some((f) => f.id === 'perf-console-in-release'), 'without git everything is scanned');
});
