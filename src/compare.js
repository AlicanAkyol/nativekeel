import { SEVERITIES, countBySeverity } from './analyze.js';

// Compares two scans (from `--json`): what got fixed, what is new, how versions moved.
// Used for monthly Care reports and before/after case studies.

const arch = (a) => (a && a.android !== false && a.ios !== false ? 'on' : 'off');

export function compareScans(before, after) {
  const beforeIds = new Map(before.findings.map((f) => [f.id, f]));
  const afterIds = new Map(after.findings.map((f) => [f.id, f]));
  const notInfo = (f) => f.severity !== 'info';
  return {
    fixed: before.findings.filter((f) => notInfo(f) && !afterIds.has(f.id)),
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
  for (const sev of SEVERITIES.filter((s) => s !== 'info')) {
    lines.push(`| ${sev[0].toUpperCase()}${sev.slice(1)} findings | ${c.counts.before[sev]} | ${c.counts.after[sev]} |`);
  }
  lines.push('');
  if (c.fixed.length) {
    lines.push(`**Fixed (${c.fixed.length})**`, '');
    for (const f of c.fixed) lines.push(`- ✅ ${f.title}`);
    lines.push('');
  }
  if (c.added.length) {
    lines.push(`**New (${c.added.length})**`, '');
    for (const f of c.added) lines.push(`- ${f.severity === 'critical' || f.severity === 'high' ? '⚠️' : '•'} ${f.title}`);
    lines.push('');
  }
  if (!c.fixed.length && !c.added.length) lines.push('No changes in findings.', '');
  return `${lines.join('\n')}\n`;
}
