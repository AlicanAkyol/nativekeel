// The upgrade view: the one question an RN/Expo team asks before every upgrade — "what will break
// in MY code and deps if I move to the newest version, and in what order?" — answered from a scan
// result. It reuses the same findings the full report carries, but leads with a go/no-go verdict
// and lists only what the upgrade touches. Nothing here is a new detector; it reorganizes what
// analyze() already found so the upgrade story is the headline, not a buried low finding.
import { NEXT, EXPO_RN, CHANGES } from './upcoming.js';
import { CONTACT_EMAIL } from './config.js';

const minorOf = (v) => (v ? Number(String(v).split('.')[1]) : null);
const majorOf = (v) => (v ? Number(String(v).split('.')[0]) : null);

// The oldest React Native minor our breaking-change catalog has entries for. A jump that starts
// before this minus one crosses versions whose changes we do not carry, so "no blockers" is only
// partial knowledge and must not read as a clean go.
const CATALOG_MIN_RN = Math.min(...CHANGES.filter((c) => c.rn).map((c) => c.rn));
// Which Expo SDK first ships that minor: the catalog's effective Expo floor.
const CATALOG_MIN_EXPO = Math.min(...Object.entries(EXPO_RN).filter(([, rn]) => rn >= CATALOG_MIN_RN).map(([sdk]) => Number(sdk)));

// Group the scan's upgrade-relevant findings into a verdict. A blocker stops the build or crashes
// the app on the target version; a change in behavior or a tooling bump is a note, not a blocker.
export function upgradeReport(result) {
  const findings = result.findings || [];
  const by = (pred) => findings.filter(pred);
  const find = (id) => findings.find((f) => f.id === id);

  const isExpo = !!result.project.expo;
  const fromRn = result.project.reactNative || null;
  const fromExpo = result.project.expo ? majorOf(result.project.expo) : null;
  const target = {
    rn: `0.${NEXT.rn.minor}.x`,
    rnStatus: NEXT.rn.status,
    expo: isExpo ? NEXT.expo.sdk : null,
    expoStatus: isExpo ? NEXT.expo.status : null,
  };

  // Already on, or ahead of, the newest line we track: nothing to plan.
  const curMinor = minorOf(fromRn);
  const current = isExpo
    ? fromExpo !== null && fromExpo >= NEXT.expo.sdk
    : curMinor !== null && curMinor >= NEXT.rn.minor;

  // The per-change breakage carried by the `upcoming-changes` finding (file:line per change).
  const upcoming = find('upcoming-changes');
  const changes = (upcoming && upcoming.fix && upcoming.fix.changes) || [];
  const libCompile = changes.filter((c) => c.id === 'rn87-bare-includes');
  // A change can be in the app's own code, in a dependency, or both: each is its own blocker.
  const codeBreaks = changes.filter((c) => c.kind === 'removed' && c.id !== 'rn87-bare-includes' && c.hits.length);
  const libraryBreaks = changes.filter((c) => c.kind === 'removed' && (c.libraries || []).length);
  const behavior = changes.filter((c) => c.kind === 'behavior');
  const tooling = changes.filter((c) => c.kind === 'tooling');

  const interop = by((f) => f.id.startsWith('interop-job:'));
  const knownSerious = by((f) => f.fix && f.fix.kind === 'known-issue' && (f.severity === 'critical' || f.severity === 'high'));
  const knownMinor = by((f) => f.fix && f.fix.kind === 'known-issue' && f.severity !== 'critical' && f.severity !== 'high');
  const mismatch = [find('expo-rn-mismatch'), find('expo-sdk-mismatch')].filter(Boolean);
  const unsupported = [find('rn-unsupported'), find('expo-unsupported')].filter(Boolean);
  const newArch = find('new-arch-disabled');

  const blockers = [];
  for (const c of codeBreaks) blockers.push({ kind: 'code', title: c.title, where: c.hits, action: c.action, version: c.version, source: c.source });
  for (const c of libraryBreaks) blockers.push({ kind: 'library-js', title: `${c.title}, and a dependency still uses it`, where: c.libraries, action: 'Update the library if a release fixes it; until then patch it (patch-package). A fix in your own code does not cover it.', version: c.version, source: c.source });
  for (const c of libCompile) blockers.push({ kind: 'library-ios-build', title: c.title, where: c.hits, action: c.action, version: c.version, source: c.source });
  for (const f of interop) blockers.push({ kind: 'library-interop', title: f.title, where: [], action: f.detail, id: f.id });
  for (const f of knownSerious) blockers.push({ kind: 'known', title: f.title, where: [], action: f.detail, id: f.id });
  for (const f of mismatch) blockers.push({ kind: 'mismatch', title: f.title, where: [], action: f.detail, id: f.id });

  const notes = [];
  for (const c of behavior) notes.push({ kind: 'behavior', title: c.title, where: c.hits, action: c.action, version: c.version, source: c.source });
  for (const f of knownMinor) notes.push({ kind: 'known', title: f.title, where: [], action: f.detail, id: f.id });
  if (newArch) notes.push({ kind: 'new-arch', title: newArch.title, where: [], action: newArch.detail, id: newArch.id });

  const toolingItems = tooling.map((c) => ({ title: c.title, where: c.hits, action: c.action, version: c.version, source: c.source }));

  // Does the catalog cover the whole jump, or only its last step(s)? A far-behind app crosses
  // versions we do not carry, so a "no blockers" result there is partial, never a clean go.
  const coverage = isExpo
    ? (fromExpo !== null && fromExpo >= CATALOG_MIN_EXPO - 1 ? 'full' : 'partial')
    : (curMinor !== null && curMinor >= CATALOG_MIN_RN - 1 ? 'full' : 'partial');

  let status;
  if (!fromRn && fromExpo === null) status = 'unknown';
  else if (current) status = 'current';
  else if (blockers.length) status = 'blocked';
  else if (coverage === 'partial') status = 'partial';
  else status = 'ready';
  const coveredFrom = isExpo ? `Expo SDK ${CATALOG_MIN_EXPO}` : `React Native 0.${CATALOG_MIN_RN}`;

  // What a static scan cannot promise — stated so the verdict is trusted, not oversold.
  const cantKnow = [
    'Native library code and iOS/Android build settings beyond the checks above are not evaluated here; build once on the target before shipping.',
    `Breaking changes are matched from NativeKeel's catalog for the versions ahead of you (up to ${isExpo ? `Expo SDK ${NEXT.expo.sdk}` : `React Native 0.${NEXT.rn.minor}`}); a change not in the catalog is not reported.`,
  ];
  if (coverage === 'partial') cantKnow.unshift(`This is a multi-version jump. NativeKeel's catalog covers the breaking changes from ${coveredFrom} onward; the earlier steps between your version and there have their own breaking changes that are not evaluated here. Upgrade one version at a time and re-run — see \`nativekeel plan\` for the staged path.`);

  return {
    from: { reactNative: fromRn, expo: result.project.expo || null },
    to: target,
    status,
    coverage,
    blockers,
    notes,
    tooling: toolingItems,
    // End of support is a known fact, not a limit of the scan: shown with the verdict.
    support: unsupported.map((f) => f.title),
    cantKnow,
    counts: { blockers: blockers.length, notes: notes.length, tooling: toolingItems.length },
  };
}

const where = (hits) => (hits && hits.length ? ` — ${hits.slice(0, 4).join(', ')}${hits.length > 4 ? `, +${hits.length - 4} more` : ''}` : '');

export function upgradeText(report, { color } = {}) {
  const c = color || { bold: (s) => s, green: (s) => s, red: (s) => s, yellow: (s) => s, gray: (s) => s };
  const out = [];
  const fromLabel = report.from.expo
    ? `Expo SDK ${majorOf(report.from.expo)} (React Native ${report.from.reactNative || '?'})`
    : `React Native ${report.from.reactNative || '?'}`;
  const toLabel = report.to.expo
    ? `Expo SDK ${report.to.expo}${report.to.expoStatus !== 'stable' ? ` (${report.to.expoStatus})` : ''} / React Native ${report.to.rn}`
    : `React Native ${report.to.rn}${report.to.rnStatus !== 'stable' ? ` (${report.to.rnStatus})` : ''}`;

  if (report.status === 'unknown') {
    out.push(c.bold('Upgrade') + '  Could not detect React Native or Expo in this project.');
    return out.join('\n');
  }
  if (report.status === 'current') {
    out.push(`${c.bold('Upgrade')}  ${c.green('Up to date')} — ${fromLabel} is the newest line NativeKeel tracks (${toLabel}).`);
    return out.join('\n');
  }

  const verdict = report.status === 'blocked'
    ? c.red(`NOT READY — ${report.counts.blockers} blocker${report.counts.blockers === 1 ? '' : 's'} in your code and dependencies`)
    : report.status === 'partial'
      ? c.yellow('MULTI-VERSION JUMP — no blockers in the newest step, but earlier steps are not evaluated; upgrade one version at a time')
      : c.green('READY — no blockers found in your code');
  out.push(`${c.bold(`Upgrade  ${fromLabel} → ${toLabel}`)}`);
  out.push(`  ${verdict}${report.counts.notes || report.counts.tooling ? c.gray(`  ·  ${report.counts.notes} behavior change${report.counts.notes === 1 ? '' : 's'}, ${report.counts.tooling} tooling change${report.counts.tooling === 1 ? '' : 's'} to review`) : ''}`);
  for (const t of report.support || []) out.push(`  ${c.yellow('!')} ${t}`);
  out.push('');

  if (report.blockers.length) {
    out.push(c.bold('Blockers (fix before upgrading)'));
    for (const b of report.blockers) {
      const tag = { code: 'code', 'library-js': 'library', 'library-ios-build': 'iOS build', 'library-interop': 'native module', known: 'known trap', mismatch: 'version mismatch' }[b.kind] || b.kind;
      out.push(`  ${c.red('✗')} [${tag}${b.version ? ` · ${b.version}` : ''}] ${b.title}${where(b.where)}`);
      if (b.action) {
        // Shorten long prose, never the guide link at its end: a cut URL is useless.
        const m = b.action.match(/^(.*?)\s*(https?:\/\/\S+)$/s);
        const prose = m ? m[1] : b.action;
        const short = prose.length > 240 ? prose.slice(0, 237) + '…' : prose;
        out.push(c.gray(`      ${short}${m ? ` ${m[2]}` : ''}`));
      }
    }
    out.push('');
  }
  if (report.notes.length) {
    out.push(c.bold('Behavior changes to review'));
    for (const n of report.notes) out.push(`  ${c.yellow('•')} ${n.title}${where(n.where)}`);
    out.push('');
  }
  if (report.tooling.length) {
    out.push(c.bold('Tooling / config'));
    for (const t of report.tooling) out.push(`  ${c.yellow('•')} ${t.title}${where(t.where)}`);
    out.push('');
  }
  out.push(c.gray('What this cannot confirm:'));
  for (const k of report.cantKnow) out.push(c.gray(`  - ${k}`));
  if (report.status === 'blocked' || report.status === 'partial') {
    out.push('');
    out.push(`Rather hand the upgrade over? We take on a few at a time: send this output to ${c.bold(CONTACT_EMAIL)} for a fixed quote.`);
  }
  return out.join('\n');
}
