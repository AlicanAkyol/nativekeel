import { SEVERITIES, countBySeverity } from './analyze.js';
import { SITE_URL } from './config.js';

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
  out.push(`${c.bold('NativeKeel health report')}  ${p.name || ''}`);
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
        out.push(`${label.low} ${c.bold(f.title)}`);
        out.push(c.gray(indent + f.detail));
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
    for (const f of group) {
      out.push(`${label[sev]} ${c.bold(f.title)}`);
      out.push(c.gray(indent + f.detail));
    }
    out.push('');
  }

  if (result.baseline) {
    out.push(c.gray(`Baseline ${result.baseline.file}: ${result.baseline.suppressed} known findings hidden${result.baseline.fixed.length ? `, ${result.baseline.fixed.length} fixed since` : ''}.`));
  }
  const n = countBySeverity(result.findings);
  out.push(`${c.bold('Summary')}  ${c.red(`${n.critical} critical`)} · ${c.yellow(`${n.high} high`)} · ${n.medium} medium · ${n.low} low`);

  if (n.critical + n.high > 0) {
    out.push('');
    out.push(`Next: ${c.bold('npx nativekeel plan')} writes a step-by-step upgrade plan.`);
    out.push(c.gray(`No time to do it yourself? Fixed-price upgrades: ${SITE_URL}/#services`));
  } else if (!result.findings.length) {
    out.push(c.green('Nothing to fix. This app is in good shape.'));
  }
  out.push('');
  return out.join('\n');
}
