import { SEVERITIES, countBySeverity } from './analyze.js';
import { CONTACT_EMAIL } from './config.js';
import { startHere } from './plan.js';

const ISSUE_URL = 'https://github.com/AlicanAkyol/nativekeel/issues/new?template=false-alarm.yml';
// Findings with an outside deadline (store rules, end of support, removed architecture).
export const DEADLINE_IDS = /^(rn-unsupported|expo-unsupported|new-arch-disabled|play-target-sdk|android-16kb|ios-uiscene-required|ios-privacy-manifest)/;

export function textReport(result, { color = true, verbose = false } = {}) {
  const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const c = { red: paint('31'), yellow: paint('33'), blue: paint('34'), gray: paint('90'), bold: paint('1'), green: paint('32') };
  const label = {
    critical: c.red('✖ CRITICAL'),
    high: c.yellow('▲ HIGH    '),
    medium: c.yellow('● MEDIUM  '),
    low: c.gray('· LOW     '),
    info: c.blue('ℹ INFO    '),
  };
  const indent = '           ';
  const out = [];
  const p = result.project;
  // Not set means React Native's default: off before 0.76, on from 0.76.
  const defaultOn = !!p.reactNative && Number(p.reactNative.split('.')[1]) >= 76;
  const arch = (v) => (v === true ? c.green('on') : v === false ? c.red('off') : defaultOn ? c.gray('on (default)') : c.red('off (default)'));

  out.push('');
  out.push(`${c.bold(result.focus === 'security' ? 'NativeKeel security report' : 'NativeKeel health report')}  ${p.name || ''}`);
  if (p.reactNative) out.push(`React Native ${p.reactNative}${result.latest.reactNative ? c.gray(` (latest ${result.latest.reactNative})`) : ''}`);
  if (p.expo) out.push(`Expo SDK ${p.expo.split('.')[0]}${p.managed ? ' (managed)' : ''}${result.latest.expo ? c.gray(` (latest SDK ${result.latest.expo.split('.')[0]})`) : ''}`);
  out.push(`New Architecture  android: ${arch(p.newArch.android)}  ios: ${arch(p.newArch.ios)}`);
  if (p.android && p.android.targetSdk) out.push(`Android targetSdk ${p.android.targetSdk}`);
  out.push(`Dependencies: ${result.deps.length} (${result.deps.filter((d) => d.native).length} native)`);
  for (const w of result.warnings) out.push(c.yellow(`! ${w}`));
  if (result.offlineRequested) out.push(c.gray('Offline mode: no network requests were made. Version and package checks need the network.'));
  else if (result.offline) out.push(c.yellow('! Could not reach npm or React Native Directory. Only local checks (secrets, settings) ran.'));
  out.push('');

  for (const sev of SEVERITIES) {
    const group = result.findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    if (sev === 'low') {
      // Outdated packages are many and alike: list them compactly. Everything else gets a full entry.
      const bumps = group.filter((f) => f.id.startsWith('dep-major:'));
      for (const f of group.filter((x) => !x.id.startsWith('dep-major:'))) {
        out.push(`${label.low} ${c.bold(f.title)} ${c.gray(`[${f.id}]`)}`);
        out.push(c.gray(indent + f.detail));
        if (f.attack) { out.push(indent + 'Verify: ' + f.attack.validation); out.push(indent + 'Fix: ' + f.fix.step); }
      }
      if (bumps.length) {
        const shown = verbose ? bumps : bumps.slice(0, 8);
        out.push(`${label.low} ${bumps.length} package${bumps.length === 1 ? ' is' : 's are'} a major version behind:`);
        out.push(c.gray(shown.map((f) => indent + f.title).join('\n')));
        if (bumps.length > shown.length) out.push(c.gray(`${indent}… and ${bumps.length - shown.length} more (run with --verbose)`));
      }
      out.push('');
      continue;
    }
    // Packages the Expo SDK upgrade moves: one line, they are not separate work.
    const expoMoves = group.filter((f) => f.fix && f.fix.expoManaged);
    for (const f of group.filter((x) => !(x.fix && x.fix.expoManaged))) {
      out.push(`${label[sev]} ${c.bold(f.title)} ${c.gray(`[${f.id}]`)}`);
      out.push(c.gray(indent + f.detail));
      if (f.attack) { out.push(indent + 'Verify: ' + f.attack.validation); out.push(indent + 'Fix: ' + f.fix.step); }
    }
    if (expoMoves.length) {
      const names = expoMoves.map((f) => f.fix.name);
      out.push(`${label[sev]} ${c.bold(`${expoMoves.length} package${expoMoves.length === 1 ? '' : 's'} move with the Expo SDK upgrade`)}`);
      out.push(c.gray(`${indent}${(verbose ? names : names.slice(0, 6)).join(', ')}${!verbose && names.length > 6 ? `, … (${names.length - 6} more with --verbose)` : ''}. \`npx expo install --fix\` sets the versions the new SDK expects.`));
    }
    out.push('');
  }

  if (result.findings.length && !(result.settings && result.settings.ignored.length)) out.push(c.gray(`To accept a finding, add its [id] to .nativekeel.json: { "ignore": [{ "id": "…", "reason": "…" }] }`));
  if (result.settings && result.settings.ignored.length) {
    const ig = result.settings.ignored;
    out.push(c.gray(`${result.settings.file}: ${ig.length} finding${ig.length === 1 ? '' : 's'} ignored by the team (${ig.slice(0, 3).map((i) => `${i.id}: ${i.reason}`).join('; ')}${ig.length > 3 ? '; …' : ''}).`));
  }
  if (result.baseline) {
    out.push(c.gray(`Baseline ${result.baseline.file}: ${result.baseline.suppressed} known findings hidden${result.baseline.fixed.length ? `, ${result.baseline.fixed.length} fixed since` : ''}.`));
  }
  const n = countBySeverity(result.findings);
  out.push(`${c.bold('Summary')}  ${c.red(`${n.critical} critical`)} · ${c.yellow(`${n.high} high`)} · ${n.medium} medium · ${n.low} low`);
  if (result.ratings) {
    const paintRating = (r) => (r === 'A' || r === 'B' ? c.green(r) : r === 'C' ? c.yellow(r) : c.red(r));
    out.push(`${c.bold('Ratings')}  ${result.ratings.map((r) => `${r.label} ${paintRating(r.rating)}`).join(' · ')}${c.gray('  ·  A = nothing found, E = a critical finding')}`);
  }
  if (result.security) {
    const groups = Object.entries(result.security);
    const withIssues = groups.filter(([, k]) => k > 0).map(([g, k]) => `${g.toLowerCase()} ${k}`);
    out.push(`${c.bold('Security')} (OWASP MASVS)  ${withIssues.length ? withIssues.join(' · ') : 'no matching findings'}${c.gray(`  ·  ${groups.length} finding categories; not a compliance verdict`)}`);
  }

  if (result.securityReview) {
    out.push(c.gray(result.securityReview.verdict));
    if (result.focus === 'security') {
      for (const [risk, group] of Object.entries(result.securityReview.risks)) out.push(`  ${risk}: ${group.count}`);
      const coverage = result.securityReview.flowCoverage;
      if (coverage) out.push(`Flow/config checks: ${coverage.filesRead} source files read; ${Object.values(coverage.skipped).reduce((a, b) => a + b, 0)} skipped paths/files.`);
      const native = result.securityReview.nativeCoverage;
      if (native) out.push(`Native Android checks: ${native.filesRead} files read; ${native.matchedEntryPoints} matched entry points; ${native.guardedOrUnresolved} guarded/unresolved sink candidates.`, ...native.limits.map(s => c.gray('Native scope: ' + s)));
      for (const limit of result.securityReview.limitations) out.push(c.gray('Scope: ' + limit));
    }
  }
  if (n.critical + n.high > 0 && result.focus !== 'security') {
    out.push('');
    out.push(c.bold('Start here'));
    const plain = (t) => t.replace(/\*\*/g, '').replace(/`/g, '');
    const cut = (t) => (t.length > 150 ? `${t.slice(0, 147).replace(/\s+\S*$/, '')}…` : t);
    startHere(result).forEach((s, i) => out.push(`  ${i + 1}. ${cut(plain(s.step))}`));
    out.push('');
    out.push(`Next: ${c.bold('npx nativekeel plan')} writes the full step-by-step plan.`);
    if (result.findings.some((f) => (f.severity === 'critical' || f.severity === 'high') && DEADLINE_IDS.test(f.id))) {
      out.push(`Short on time before a store deadline? We take on a few upgrades at a time: send this report to ${c.bold(CONTACT_EMAIL)}.`);
    }
    out.push(c.gray(`Something wrong for your app? Tell us (no code needed): ${ISSUE_URL}`));
  } else if (!result.findings.length) {
    out.push(c.green('No matching findings. Unchecked runtime and backend risks may remain.'));
  }
  out.push('');
  return out.join('\n');
}
