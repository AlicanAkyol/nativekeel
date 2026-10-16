import fs, { withReadRoots, readPolicy } from './read-boundary.js';
import { executionSafety } from './safety.js';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitArchive, setTrackedFiles, clearTrackedFiles } from './git.js';
import { loadProject } from './project.js';
import { analyze } from './analyze.js';
import { compareScans } from './compare.js';
import { ratings } from './ratings.js';

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
    // Everything in the archive is committed: let committed-file checks see the same files.
    const list = spawnSync('tar', ['-t', '-f', '-'], { input: archive.tar, maxBuffer: 64 * 1024 * 1024, timeout: 120000, encoding: 'utf8' });
    if (list.status === 0) setTrackedFiles(tmp, list.stdout.split('\n').filter((f) => f && !f.endsWith('/')).map((f) => f.replace(/^\.\//, '')));
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
    return { base, commit: archive.sha, diff, ok: bad.length === 0, newSerious: bad, ratings: { before: ratings(before.findings), after: ratings(after.findings) }, safety: executionSafety(after.findings), notes, offline };
  } finally {
    clearTrackedFiles(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// A pull request comment: what this change adds or fixes, then the app's totals. The marker
// lets the Action update one comment instead of adding a new one on every push.
export const PR_COMMENT_MARKER = '<!-- nativekeel-pr-comment -->';
const ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' };
const clean = (s) => String(s).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
export function prComment(r, { reportUrl = null } = {}) {
  const { added, fixed, counts } = r.diff;
  const order = ['critical', 'high', 'medium', 'low'];
  const sorted = (list) => [...list].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const line = (f) => `- ${ICON[f.severity] || '⚪'} **${f.severity}** · ${clean(f.title)}`;
  const out = [PR_COMMENT_MARKER, '### NativeKeel'];
  // The gate is the one `verify` exits on: no new critical or high findings.
  const serious = (r.newSerious || added.filter((f) => f.severity === 'critical' || f.severity === 'high')).length;
  out.push(serious ? `**Quality gate: ❌ failed**, ${serious} new critical or high finding${serious === 1 ? '' : 's'}.` : '**Quality gate: ✅ passed**, no new critical or high findings.', '');
  if (!added.length && !fixed.length) out.push('No new findings and nothing fixed compared with the base of this pull request.');
  else out.push(`This pull request: **${added.length} new**, **${fixed.length} fixed** compared with \`${r.commit.slice(0, 7)}\`.`);
  if (added.length) out.push('', '**New**', ...sorted(added).slice(0, 15).map(line), ...(added.length > 15 ? [`- …and ${added.length - 15} more`] : []));
  if (fixed.length) out.push('', '**Fixed**', ...sorted(fixed).slice(0, 10).map(line), ...(fixed.length > 10 ? [`- …and ${fixed.length - 10} more`] : []));
  const total = order.filter((s) => counts.after[s]).map((s) => `${counts.after[s]} ${s}`).join(' · ');
  out.push('', `Whole app: ${total || 'no findings'}.${reportUrl ? ` [Full report](${reportUrl})` : ''}`);
  if (r.ratings) {
    const was = Object.fromEntries(r.ratings.before.map((x) => [x.key, x.rating]));
    out.push('', `Ratings: ${r.ratings.after.map((x) => `${x.label} **${x.rating}**${was[x.key] && was[x.key] !== x.rating ? ` (was ${was[x.key]})` : ''}`).join(' · ')}`);
  }
  if (r.safety?.blocked) out.push('', '> ⛔ This project contains code NativeKeel flags as malicious. Do not install or run it until it is reviewed.');
  out.push('', '<sub>Static checks by [NativeKeel](https://nativekeel.com); no code was run.</sub>');
  return out.join('\n');
}
