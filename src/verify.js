import fs, { withReadRoots, readPolicy } from './read-boundary.js';
import { executionSafety } from './safety.js';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitArchive } from './git.js';
import { loadProject } from './project.js';
import { analyze } from './analyze.js';
import { compareScans } from './compare.js';

// After an upgrade (or any change), compares the project as committed at `base` with the working
// tree: what got fixed, what is new, how versions moved. The committed version is unpacked into
// a temporary folder outside the project and deleted afterwards; nothing in the project is written.
// Both sides are scanned offline by default so the difference comes from the change, not from
// registry answers that moved in between.
export async function verifyUpgrade(root, { base = 'HEAD', offline = true, analyzeOptions = {} } = {}) {
  const archive = gitArchive(root, base);
  if (archive.error) throw new Error(archive.error);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nativekeel-base-'));
  try {
    // bsdtar and GNU tar refuse absolute paths and ".." entries by default; git archive writes neither.
    const x = spawnSync('tar', ['-x', '-f', '-', '-C', tmp], { input: archive.tar, maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
    if (x.status !== 0) throw new Error('could not unpack the committed version');
    const options = offline ? { get: async () => null, offline: true } : analyzeOptions;
    const scanBase = () => analyze(loadProject(tmp), options);
    const before = await (readPolicy() ? withReadRoots([tmp], scanBase) : scanBase());
    const after = await analyze(loadProject(root), options);
    const diff = compareScans(before, after);
    const bad = diff.added.filter((f) => f.severity === 'critical' || f.severity === 'high');
    const notes = [];
    // node_modules is never committed: the committed side reads versions from the lockfile.
    if (after.project && fs.existsSync(path.join(root, 'node_modules')) && !fs.existsSync(path.join(tmp, 'node_modules'))) {
      notes.push('The committed version was scanned without node_modules (versions from the lockfile); the working tree with node_modules.');
    }
    return { base, commit: archive.sha, diff, ok: bad.length === 0, newSerious: bad, safety: executionSafety(after.findings), notes, offline };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
