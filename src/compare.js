import { SEVERITIES, countBySeverity } from './analyze.js';
import { ratings } from './ratings.js';
import fs from './read-boundary.js';
import path from 'node:path';
import { findingLocations } from './locations.js';

// Compares two scans (from `--json`): what got fixed, what is new, how versions moved.
// Used for monthly Care reports and before/after case studies.

const arch = (a) => (a && a.android !== false && a.ios !== false ? 'on' : 'off');

// Why a finding is gone: its file no longer exists (deleted or moved, so the code may live on
// elsewhere), the two scans used different NativeKeel versions (the check changed), or the code was
// fixed. "Gone" alone is not "fixed".
function whyGone(f, after, toolChanged) {
  const root = after.project && after.project.root;
  const files = findingLocations(f).map((l) => l.file);
  if (root && files.length && files.some((x) => { try { return !fs.existsSync(path.join(root, x)); } catch { return false; } })) return 'file-removed';
  if (toolChanged) return 'tool-changed';
  return 'fixed';
}

export function compareScans(before, after) {
  const beforeIds = new Map(before.findings.map((f) => [f.id, f]));
  const afterIds = new Map(after.findings.map((f) => [f.id, f]));
  const notInfo = (f) => f.severity !== 'info';
  const toolChanged = !!(before.toolVersion && after.toolVersion && before.toolVersion !== after.toolVersion);
  // The same check can get worse without a new id: a higher severity, or the same problem in a file
  // it was not in before. Compared by file, not line, so code that only moved down a few lines is
  // not new.
  const order = ['critical', 'high', 'medium', 'low', 'info'];
  const worsened = [];
  const spread = [];
  for (const f of after.findings) {
    const was = beforeIds.get(f.id);
    if (!was || !notInfo(f)) continue;
    if (order.indexOf(f.severity) < order.indexOf(was.severity)) worsened.push({ ...f, was: was.severity });
    const before = new Set(findingLocations(was).map((l) => l.file));
    const files = [...new Set(findingLocations(f).map((l) => l.file))].filter((x) => !before.has(x));
    if (files.length && before.size) spread.push({ ...f, newFiles: files });
  }
  return {
    worsened,
    spread,
    fixed: before.findings.filter((f) => notInfo(f) && !afterIds.has(f.id)).map((f) => ({ ...f, gone: whyGone(f, after, toolChanged) })),
    added: after.findings.filter((f) => notInfo(f) && !beforeIds.has(f.id)),
    counts: { before: countBySeverity(before.findings), after: countBySeverity(after.findings) },
    versions: {
      reactNative: [before.project.reactNative, after.project.reactNative],
      expo: [before.project.expo, after.project.expo],
      newArch: [arch(before.project.newArch), arch(after.project.newArch)],
      dependencies: [before.deps.length, after.deps.length],
      native: [before.deps.filter((d) => d.native).length, after.deps.filter((d) => d.native).length],
    },
    dates: [before.scannedAt, after.scannedAt],
    tools: [before.toolVersion || null, after.toolVersion || null],
    ratings: { before: ratings(before.findings), after: ratings(after.findings) },
  };
}

export function compareToMarkdown(c, { title = 'Health report: before and after' } = {}) {
  const row = (label, [a, b]) => (a === b || (a == null && b == null) ? null : `| ${label} | ${a ?? '–'} | ${b ?? '–'} |`);
  const lines = [`### ${title}`, '', `${c.dates[0].slice(0, 10)} → ${c.dates[1].slice(0, 10)}`, '', '| | Before | After |', '|---|---|---|'];
  lines.push(
    ...[
      row('React Native', c.versions.reactNative),
      row('Expo SDK', c.versions.expo),
      row('New Architecture', c.versions.newArch),
      row('Dependencies', c.versions.dependencies),
      row('Native modules', c.versions.native),
    ].filter(Boolean),
  );
  if (c.ratings) {
    c.ratings.after.forEach((x, i) => lines.push(`| ${x.label} rating | ${c.ratings.before[i].rating} | ${x.rating} |`));
  }
  for (const sev of SEVERITIES.filter((s) => s !== 'info')) {
    lines.push(`| ${sev[0].toUpperCase()}${sev.slice(1)} findings | ${c.counts.before[sev]} | ${c.counts.after[sev]} |`);
  }
  lines.push('');
  if (c.fixed.length) {
    lines.push(`**Fixed (${c.fixed.length})**`, '');
    const why = { 'file-removed': ' _(its file was removed or moved: check the code did not move elsewhere)_', 'tool-changed': ' _(may come from the newer NativeKeel version)_' };
    for (const f of c.fixed) lines.push(`- ${f.gone === 'fixed' || !f.gone ? '✅' : '❔'} ${f.title}${why[f.gone] || ''}`);
    lines.push('');
  }
  if (c.added.length) {
    lines.push(`**New (${c.added.length})**`, '');
    for (const f of c.added) lines.push(`- ${f.severity === 'critical' || f.severity === 'high' ? '⚠️' : '•'} ${f.title}`);
    lines.push('');
  }
  if (c.worsened && c.worsened.length) {
    lines.push(`**Worse (${c.worsened.length})**`, '');
    for (const f of c.worsened) lines.push(`- ⚠️ ${f.title} (${f.was} → ${f.severity})`);
    lines.push('');
  }
  if (c.spread && c.spread.length) {
    lines.push(`**In new files (${c.spread.length})**`, '');
    for (const f of c.spread) lines.push(`- ${f.title}: now also in ${f.newFiles.slice(0, 3).join(', ')}${f.newFiles.length > 3 ? ', …' : ''}`);
    lines.push('');
  }
  if (!c.fixed.length && !c.added.length && !(c.worsened && c.worsened.length) && !(c.spread && c.spread.length)) lines.push('No changes in findings.', '');
  // Different tool versions: part of the change can come from the checks (fewer false alarms, new
  // checks), not from the app.
  if (c.tools && c.tools[0] !== c.tools[1]) lines.push(`_Scanned with NativeKeel ${c.tools[0] || 'an older version'} and then ${c.tools[1] || 'an unknown version'}: some of these changes may come from the checks, not from the app. To separate them, scan the earlier commit again with ${c.tools[1] || 'the newer version'}._`, '');
  return `${lines.join('\n')}\n`;
}
