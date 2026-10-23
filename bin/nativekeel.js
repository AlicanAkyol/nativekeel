#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, findAppFolders } from '../src/project.js';
import { analyze, SEVERITIES, countBySeverity } from '../src/analyze.js';
import { textReport } from '../src/report-text.js';
import { htmlReport } from '../src/report-html.js';
import { sarifReport } from '../src/report-sarif.js';
import { markdownReport } from '../src/report-md.js';
import { buildPlan, planToMarkdown } from '../src/plan.js';
import { ratings } from '../src/ratings.js';
import { applyBaseline, saveBaseline } from '../src/baseline.js';
import { compareScans, compareToMarkdown } from '../src/compare.js';
import { securityOnly } from '../src/security-review.js';
import { gates } from '../src/settings.js';
import { buildImprovementPlan, improvementToMarkdown, improvementToText } from '../src/improve.js';
import { SITE_URL } from '../src/config.js';

const VALUE_FLAGS = new Set(['--html', '--out', '--baseline', '--save-baseline', '--brand', '--sarif', '--markdown', '--fail-on', '--sonar', '--path', '--base', '--comment', '--report-url', '--artifact']);
const COMMANDS = new Set(['scan', 'security', 'upgrade', 'improve', 'bundle', 'plan', 'compare', 'compare-imports', 'prepare-imports', 'explain', 'verify', 'fleet', 'mcp', 'help']);

function parseArgs(argv) {
  const flags = { artifacts: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(`${a} needs a value`);
      if (a === '--artifact') flags.artifacts.push(argv[++i]);
      else flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--') || a === '-h' || a === '-v') {
      flags[a.replace(/^-+/, '')] = true;
    } else {
      positional.push(a);
    }
  }
  const command = COMMANDS.has(positional[0]) ? positional.shift() : 'scan';
  return { command, flags, positional };
}

// Colour on a terminal; NO_COLOR (no-color.org) or --no-color turn it off, FORCE_COLOR turns it on
// where there is no terminal (CI logs, recordings).
function useColor(flags = {}) {
  if (process.env.NO_COLOR || flags['no-color']) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return !!process.stdout.isTTY;
}

function fail(message, code = 2) {
  console.error(`nativekeel: ${message}`);
  process.exit(code);
}

const HELP = `NativeKeel: health check for React Native and Expo apps

Usage
  npx nativekeel [path]          Scan an app and print the report
  npx nativekeel security [path]  Review data theft, account access and code execution risks
  npx nativekeel improve [path]  Prioritized app improvement review (--json or --out)
  npx nativekeel bundle [path | file.map] [--base old.map]
                                 What the release JavaScript bundle is made of, measured
                                 from the source map a release build wrote; with --base,
                                 what grew, shrank or was added since that build (--json)
  npx nativekeel upgrade [path]  Readiness for the newest React Native / Expo:
                                 what breaks in your code and deps, with a
                                 go/no-go verdict (exit 1 when blockers remain)
  npx nativekeel plan [path]     Write a step-by-step upgrade plan
  npx nativekeel fleet [folder ...] [--base fleet.json]
                                 Several apps side by side: versions, A–E ratings
                                 and store deadlines (--html, --markdown, --json);
                                 with --base, what changed since that run
  npx nativekeel compare <before.json> <after.json>
                                 What got fixed and what is new between two scans
  npx nativekeel explain "<error>" [--path <app>]
                                 What a build, launch or store error means and the
                                 fix (or pipe a log in: ... | npx nativekeel explain)
  npx nativekeel verify [path] [--base <rev>]
                                 After an upgrade: what got fixed and what is new
                                 compared with the last commit (exit 1 on new
                                 critical/high findings)
  npx nativekeel mcp             Run as an MCP server for AI coding agents (stdio)

Scan options
  --json                    Machine-readable output
  --html <file>             Save a shareable HTML report
  --markdown <file>         Save a Markdown summary (for pull request comments)
  --sarif <file>            Save SARIF for GitHub code scanning
  --sonar <file>            Save issues for SonarQube (sonar.externalIssuesReportPaths)
  --upload                  Send the scan summary (no code) to your team panel;
                            needs NATIVEKEEL_TOKEN (closed beta)
  --verbose                 List every outdated package
  --offline                 Make no network requests (local checks only)
  --artifact <file>         Also scan a built app (APK, AAB or IPA, e.g. from CI) for
                            keys added at build time; repeatable. Built apps and
                            bundles under android/app/build are scanned automatically
  --save-baseline <file>    Accept current findings as known
  --baseline <file>         Only report findings not in the baseline (for CI)
  --brand <name>            Put your company name on the HTML report
  --fail-on <level>         Exit 1 at this severity or above: critical (default),
                            high, medium, low, or never

Plan options
  --out <file>              Save the plan as Markdown (default: print it)
  --html <file>             Save report + plan as one HTML file

The scan exits with code 1 when a critical issue is found (see --fail-on), so it
can gate CI.

Team settings: a committed .nativekeel.json sets failOn, lists accepted
findings, each with a reason, and can limit which checks may fail the build
(gate): {"failOn":"high","gate":["secret:*","ci-*"],"ignore":[{"id":"flipper","reason":"..."}]}

Privacy: your code never leaves your machine. Without --offline, the only
requests are package-name lookups on registry.npmjs.org and
reactnative.directory. Secret values are always masked.  ${SITE_URL}`;

async function runScan(root, flags) {
  let project;
  try {
    project = loadProject(root);
  } catch (e) {
    fail(e.message);
  }
  if (!flags.json) process.stderr.write(`Scanning ${root}${flags.offline ? ' (offline)' : ''} …\n`);
  return analyze(project, { ...(flags.offline ? { get: async () => null, offline: true } : {}), artifacts: flags.artifacts });
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
}

function write(file, content) {
  fs.writeFileSync(file, content);
  process.stderr.write(`Saved ${path.resolve(file)}\n`);
}

// Every app under the given folders (or the folders themselves when they are apps).
async function runFleet(positional, flags, failOn) {
  const { fleetRow, sortFleet, fleetText, fleetMarkdown, fleetHtml, withTrend } = await import('../src/fleet.js');
  let previous = null;
  if (flags.base) {
    try {
      previous = JSON.parse(fs.readFileSync(flags.base, 'utf8'));
    } catch (e) {
      fail(`cannot read ${flags.base}: ${e.message}`);
    }
  }
  const apps = [];
  // Shown relative to the current folder, or from the given folder's name when it is elsewhere.
  const labels = new Map();
  const label = (dir, given) => {
    const rel = path.relative(process.cwd(), dir) || '.';
    return rel.startsWith('..') ? path.join(path.basename(given), path.relative(given, dir)) : rel;
  };
  for (const given of positional.length ? positional : ['.']) {
    const dir = path.resolve(given);
    let found = [];
    try {
      loadProject(dir);
      found = [dir];
    } catch {
      found = findAppFolders(dir, 4).map((a) => path.join(dir, a));
    }
    for (const app of found) {
      apps.push(app);
      if (!labels.has(app)) labels.set(app, label(app, dir));
    }
  }
  if (!apps.length) fail('No React Native or Expo app found in the given folders.');
  const rows = [];
  const summaries = new Map();
  for (const dir of [...new Set(apps)]) {
    const rel = labels.get(dir);
    try {
      const project = loadProject(dir);
      if (!flags.json) process.stderr.write(`Scanning ${rel}${flags.offline ? ' (offline)' : ''} …\n`);
      const result = await analyze(project, { ...(flags.offline ? { get: async () => null, offline: true } : {}), artifacts: flags.artifacts });
      rows.push({ ...fleetRow(result, rel), counts: countBySeverity(result.findings), failOn: (result.settings && result.settings.failOn) || null, scannedAt: result.scannedAt });
      summaries.set(rel, result.findings);
    } catch (e) {
      rows.push({ app: path.basename(dir), path: rel, error: e.message.split('\n')[0] });
    }
  }
  const trend = previous ? withTrend(sortFleet(rows), previous) : null;
  const sorted = trend ? trend.rows : sortFleet(rows);
  if (flags.html) write(flags.html, fleetHtml(sorted, { brand: flags.brand || null, trend }));
  if (flags.markdown) write(flags.markdown, fleetMarkdown(sorted, { trend }));
  console.log(flags.json ? JSON.stringify({ tool: 'nativekeel', scannedAt: new Date().toISOString(), apps: sorted, ...(trend ? { comparedWith: trend.since, removed: trend.removed } : {}) }, null, 2) : fleetText(sorted, { color: useColor(flags), trend }));
  if (flags.upload) {
    const { uploadReport, summaryFindings } = await import('../src/upload.js');
    try {
      const r = await uploadReport({ tool: 'nativekeel', version: packageVersion(), scannedAt: new Date().toISOString(), apps: sorted.filter((a) => !a.error).map((a) => ({ ...a, was: undefined, findings: summaryFindings(summaries.get(a.path) || []) })) });
      process.stderr.write(`Uploaded ${r.stored} app${r.stored === 1 ? '' : 's'} to the team panel (${r.team}).\n`);
    } catch (e) {
      process.stderr.write(`Upload to the team panel failed: ${e.message}\n`);
    }
  }
  // --fail-on applies to every app; without it, each app's own .nativekeel.json decides.
  const fails = (r) => {
    const level = failOn || r.failOn || 'critical';
    return level !== 'never' && SEVERITIES.slice(0, SEVERITIES.indexOf(level) + 1).some((s) => r.counts[s] > 0);
  };
  return sorted.some((r) => r.counts && fails(r)) ? 1 : 0;
}

async function main() {
  const { command, flags, positional } = parseArgs(process.argv.slice(2));

  if (flags.v || flags.version) {
    console.log(packageVersion());
    return 0;
  }
  if (command === 'help' || flags.h || flags.help) {
    console.log(HELP);
    return 0;
  }

  if (command === 'mcp') {
    // stdout belongs to the protocol from here on; anything else goes to stderr.
    const { serve } = await import('../src/mcp.js');
    console.log = (...a) => process.stderr.write(`${a.join(' ')}\n`);
    await serve({ version: packageVersion() });
    return 0;
  }

  if (command === 'explain') {
    const { explainError, relatedFindings } = await import('../src/errors.js');
    let text = positional.join(' ');
    if (!text && !process.stdin.isTTY) text = fs.readFileSync(0, 'utf8');
    if (!text.trim()) fail('usage: nativekeel explain "<error message>" [--path <app>]  (or pipe a log into it)');
    const matches = explainError(text).slice(0, 3);
    let findings = null;
    if (flags.path && matches.length) findings = (await runScan(path.resolve(flags.path), { ...flags, offline: true, json: true })).findings;
    if (flags.json) {
      console.log(JSON.stringify(matches.map((e) => ({ id: e.id, title: e.title, cause: e.cause, fix: e.fix, page: e.page, inThisProject: findings ? relatedFindings(e, findings).map((f) => ({ id: f.id, severity: f.severity, title: f.title })) : undefined })), null, 2));
      return matches.length ? 0 : 1;
    }
    if (!matches.length) {
      console.log(`Not a known error. Run \`npx nativekeel\` in the app: many build and launch failures come from a version mismatch it reports.\nKnown errors: ${SITE_URL}/fix/`);
      return 1;
    }
    for (const e of matches) {
      console.log(`\n${e.title}\n\n${e.cause}\n\nFix:\n${e.fix.map((f) => `  - ${f}`).join('\n')}`);
      if (findings) {
        const here = relatedFindings(e, findings);
        console.log(here.length ? `\nIn this project:\n${here.slice(0, 5).map((f) => `  - [${f.severity}] ${f.title}`).join('\n')}` : '\nThe scan found nothing related in this project.');
      }
      if (e.page) console.log(`\nMore: ${e.page}`);
    }
    return 0;
  }

  if (command === 'verify') {
    const { verifyUpgrade } = await import('../src/verify.js');
    let r;
    try {
      r = await verifyUpgrade(path.resolve(positional[0] || '.'), { base: flags.base || 'HEAD', offline: !flags.online });
    } catch (e) {
      return fail(e.message);
    }
    if (flags.comment) {
      const { prComment } = await import('../src/verify.js');
      write(flags.comment, prComment(r, { reportUrl: flags['report-url'] || null }));
    }
    if (flags.json) {
      console.log(JSON.stringify({ base: r.base, commit: r.commit, ok: r.ok, fixed: r.diff.fixed, added: r.diff.added, versions: r.diff.versions, counts: r.diff.counts, notes: r.notes }, null, 2));
    } else {
      console.log(compareToMarkdown({ ...r.diff, dates: [`${r.base} (${r.commit.slice(0, 7)})`, 'working tree'] }, { title: `Compared with ${r.base}` }).replace(/^(\d|\w).*→.*$/m, `${r.base} (${r.commit.slice(0, 7)}) → working tree`));
      for (const n of r.notes) console.log(`Note: ${n}`);
      console.log(r.ok ? 'No new critical or high findings.' : `${r.newSerious.length} new critical or high finding(s).`);
    }
    return r.ok ? 0 : 1;
  }

  if (command === 'prepare-imports') {
    if (positional.length !== 1) fail('usage: nativekeel prepare-imports <settings.json> (redirect stdout to experiment.json beside settings.json)');
    const { prepareImports } = await import('../src/prepare-imports.js');
    console.log(JSON.stringify(prepareImports(path.resolve(positional[0])), null, 2));
    return 0;
  }

  if (command === 'compare-imports') {
    if (positional.length !== 1) fail('usage: nativekeel compare-imports <experiment.json> [--json]');
    const { compareImports, importComparisonText } = await import('../src/compare-imports.js');
    const result = compareImports(path.resolve(positional[0]));
    console.log(flags.json ? JSON.stringify(result, null, 2) : importComparisonText(result));
    return result.status === 'incomparable' ? 2 : 0;
  }

  if (command === 'compare') {
    if (positional.length !== 2) fail('usage: nativekeel compare <before.json> <after.json> (scans saved with --json)');
    const [before, after] = positional.map((f) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (e) {
        return fail(`cannot read ${f}: ${e.message}`);
      }
    });
    const md = compareToMarkdown(compareScans(before, after));
    if (flags.out) write(flags.out, md);
    else console.log(md);
    return 0;
  }

  const root = path.resolve(positional[0] || '.');
  const brand = flags.brand || null;

  if (command === 'bundle') {
    const { analyzeSourceMap, bundleText, findBundleMaps } = await import('../src/bundle-map.js');
    let mapFile;
    if (/\.map$/.test(root)) mapFile = root;
    else {
      const [found] = findBundleMaps(root);
      if (!found) fail(`No release source map found in ${root}. Build a release (Android writes android/app/build/generated/sourcemaps/react/release/index.android.bundle.map; Expo: npx expo export --dump-sourcemap), or pass the .map file: nativekeel bundle path/to/index.android.bundle.map`);
      mapFile = path.join(root, found.file);
    }
    const shown = (f) => (path.relative(process.cwd(), f).startsWith('..') ? f : path.relative(process.cwd(), f));
    const result = analyzeSourceMap(fs.readFileSync(mapFile, 'utf8'));
    if (flags.base) {
      const { compareBundles, compareText } = await import('../src/bundle-map.js');
      const baseFile = path.resolve(flags.base);
      const diff = compareBundles(analyzeSourceMap(fs.readFileSync(baseFile, 'utf8')), result);
      console.log(flags.json ? JSON.stringify(diff, null, 2) : compareText(diff, shown(baseFile), shown(mapFile)));
      return 0;
    }
    console.log(flags.json ? JSON.stringify(result, null, 2) : bundleText(result, shown(mapFile)));
    return 0;
  }

  if (command === 'improve') {
    const plan = buildImprovementPlan(await runScan(root, flags));
    const output = flags.json ? JSON.stringify(plan, null, 2) : flags.out ? improvementToMarkdown(plan) : improvementToText(plan);
    if (flags.out) write(flags.out, output);
    else console.log(output);
    return plan.safety.blocked ? 1 : 0;
  }

  if (command === 'upgrade') {
    const { upgradeReport, upgradeText } = await import('../src/upgrade.js');
    const result = await runScan(root, flags);
    const report = upgradeReport(result);
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const color0 = useColor(flags);
      const paint = (code) => (s) => (color0 ? `\x1b[${code}m${s}\x1b[0m` : s);
      const color = { red: paint('31'), yellow: paint('33'), gray: paint('90'), bold: paint('1'), green: paint('32') };
      console.log(upgradeText(report, { color }));
    }
    return report.status === 'blocked' ? 1 : 0;
  }

  if (command === 'plan') {
    const result = await runScan(root, flags);
    const plan = buildPlan(result);
    if (flags.html) write(flags.html, htmlReport(result, { plan, brand }));
    const md = planToMarkdown(result, plan);
    if (flags.out) write(flags.out, md);
    else if (!flags.html) console.log(md);
    return 0;
  }

  if (flags['fail-on'] && !['critical', 'high', 'medium', 'low', 'never'].includes(flags['fail-on'])) fail('--fail-on must be one of critical, high, medium, low, never');
  if (flags.upload && flags.offline) fail('--upload sends the scan summary to the team panel, so it cannot be combined with --offline.');
  if (command === 'fleet') return runFleet(positional, flags, flags['fail-on']);
  let result = await runScan(root, flags);
  // --fail-on wins over the team's .nativekeel.json, which wins over the default.
  const failOn = flags['fail-on'] || (result.settings && result.settings.failOn) || 'critical';
  if (command === 'security') result = securityOnly(result);
  if (flags['save-baseline']) {
    const count = saveBaseline(flags['save-baseline'], result);
    process.stderr.write(`Baseline saved with ${count} known findings: ${path.resolve(flags['save-baseline'])}\n`);
  }
  if (flags.baseline) {
    try {
      result = applyBaseline(flags.baseline, result);
    } catch (e) {
      fail(`cannot read baseline ${flags.baseline}: ${e.message}`);
    }
  }

  if (command === 'security') result = securityOnly(result);
  // Ratings follow what is shown (after the baseline); a security-only report rates nothing else.
  if (command === 'security') delete result.ratings;
  else result.ratings = ratings(result.findings);
  if (flags.html) write(flags.html, htmlReport(result, { brand }));
  if (flags.markdown) write(flags.markdown, markdownReport(result, { verbose: !!flags.verbose }));
  if (flags.sarif) write(flags.sarif, `${JSON.stringify(sarifReport(result, { version: packageVersion() }), null, 2)}\n`);
  if (flags.sonar) {
    const { sonarReport, sonarScopeWarning } = await import('../src/report-sonar.js');
    const sonar = sonarReport(result);
    write(flags.sonar, `${JSON.stringify(sonar, null, 2)}\n`);
    const scope = sonarScopeWarning(sonar);
    if (scope) console.error(`nativekeel: ${scope}`);
  }
  if (flags.upload && command !== 'security') {
    const { uploadReport, summaryFindings } = await import('../src/upload.js');
    const { fleetRow } = await import('../src/fleet.js');
    try {
      const label = result.project.name || path.basename(result.project.root);
      const r = await uploadReport({ tool: 'nativekeel', version: packageVersion(), scannedAt: result.scannedAt, apps: [{ ...fleetRow(result, label), counts: countBySeverity(result.findings), findings: summaryFindings(result.findings) }] });
      process.stderr.write(`Uploaded to the team panel (${r.team}).\n`);
    } catch (e) {
      process.stderr.write(`Upload to the team panel failed: ${e.message}\n`);
    }
  }
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else console.log(textReport(result, { color: useColor(flags), verbose: !!flags.verbose }));
  if (failOn === 'never') return 0;
  const threshold = SEVERITIES.indexOf(failOn);
  return result.findings.some((f) => SEVERITIES.indexOf(f.severity) <= threshold && gates(result.settings, f.id)) ? 1 : 0;
}

// Exit only after stdout has flushed: process.exit() right after a large write to a pipe
// cuts the output off at 8 KB (`npx nativekeel --json | jq` got broken JSON).
main().then(
  (code) => process.stdout.write('', () => process.exit(code)),
  (e) => fail(e.stack || e.message),
);
