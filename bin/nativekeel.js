#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../src/project.js';
import { analyze, SEVERITIES } from '../src/analyze.js';
import { textReport } from '../src/report-text.js';
import { htmlReport } from '../src/report-html.js';
import { sarifReport } from '../src/report-sarif.js';
import { markdownReport } from '../src/report-md.js';
import { buildPlan, planToMarkdown } from '../src/plan.js';
import { applyBaseline, saveBaseline } from '../src/baseline.js';
import { compareScans, compareToMarkdown } from '../src/compare.js';
import { SITE_URL } from '../src/config.js';

const VALUE_FLAGS = new Set(['--html', '--out', '--baseline', '--save-baseline', '--brand', '--sarif', '--markdown', '--fail-on']);
const COMMANDS = new Set(['scan', 'plan', 'compare', 'help']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--') || a === '-h' || a === '-v') {
      flags[a.replace(/^-+/, '')] = true;
    } else {
      positional.push(a);
    }
  }
  const command = COMMANDS.has(positional[0]) ? positional.shift() : 'scan';
  return { command, flags, positional };
}

function fail(message, code = 2) {
  console.error(`nativekeel: ${message}`);
  process.exit(code);
}

const HELP = `NativeKeel: health check for React Native and Expo apps

Usage
  npx nativekeel [path]          Scan an app and print the report
  npx nativekeel plan [path]     Write a step-by-step upgrade plan
  npx nativekeel compare <before.json> <after.json>
                                 What got fixed and what is new between two scans

Scan options
  --json                    Machine-readable output
  --html <file>             Save a shareable HTML report
  --markdown <file>         Save a Markdown summary (for pull request comments)
  --sarif <file>            Save SARIF for GitHub code scanning
  --verbose                 List every outdated package
  --offline                 Make no network requests (local checks only)
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
  return analyze(project, flags.offline ? { get: async () => null, offline: true } : {});
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
}

function write(file, content) {
  fs.writeFileSync(file, content);
  process.stderr.write(`Saved ${path.resolve(file)}\n`);
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

  if (command === 'plan') {
    const result = await runScan(root, flags);
    const plan = buildPlan(result);
    if (flags.html) write(flags.html, htmlReport(result, { plan, brand }));
    const md = planToMarkdown(result, plan);
    if (flags.out) write(flags.out, md);
    else if (!flags.html) console.log(md);
    return 0;
  }

  const failOn = flags['fail-on'] || 'critical';
  if (!['critical', 'high', 'medium', 'low', 'never'].includes(failOn)) fail('--fail-on must be one of critical, high, medium, low, never');
  let result = await runScan(root, flags);
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

  if (flags.html) write(flags.html, htmlReport(result, { brand }));
  if (flags.markdown) write(flags.markdown, markdownReport(result, { verbose: !!flags.verbose }));
  if (flags.sarif) write(flags.sarif, `${JSON.stringify(sarifReport(result, { version: packageVersion() }), null, 2)}\n`);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else console.log(textReport(result, { color: process.stdout.isTTY, verbose: !!flags.verbose }));
  if (failOn === 'never') return 0;
  const threshold = SEVERITIES.indexOf(failOn);
  return result.findings.some((f) => SEVERITIES.indexOf(f.severity) <= threshold) ? 1 : 0;
}

// Exit only after stdout has flushed: process.exit() right after a large write to a pipe
// cuts the output off at 8 KB (`npx nativekeel --json | jq` got broken JSON).
main().then(
  (code) => process.stdout.write('', () => process.exit(code)),
  (e) => fail(e.stack || e.message),
);
