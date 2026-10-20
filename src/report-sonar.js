import fs from './read-boundary.js';
import path from 'node:path';
import { SITE_URL } from './config.js';
import { locate } from './report-sarif.js';
import { findingLocations } from './locations.js';

// SonarQube / SonarCloud generic issue import format (SonarQube 10.3+), read through
// sonar.externalIssuesReportPaths. Teams already on SonarQube see NativeKeel findings next to
// their other issues, in the same quality gate. Both the MQR `impacts` and the Standard
// Experience `type`/`severity` are written, so either mode shows sensible values.
// https://docs.sonarsource.com/sonarqube-server/latest/analyzing-source-code/importing-external-issues/generic-issue-import-format/

const QUALITY = { security: 'SECURITY', secret: 'SECURITY', crash: 'RELIABILITY', store: 'RELIABILITY' };
const TYPE = { SECURITY: 'VULNERABILITY', RELIABILITY: 'BUG', MAINTAINABILITY: 'CODE_SMELL' };
const IMPACT = { critical: 'BLOCKER', high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
const LEGACY = { critical: 'BLOCKER', high: 'CRITICAL', medium: 'MAJOR', low: 'MINOR' };

const human = (id) => id.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// `base`: the folder SonarQube analyzes (sonar.projectBaseDir); paths are written relative to it.
export function sonarReport(result, { base: baseDir = process.cwd() } = {}) {
  let pkgLines = [];
  try {
    pkgLines = fs.readFileSync(path.join(result.project.root, 'package.json'), 'utf8').split('\n');
  } catch {
    pkgLines = [];
  }
  const findings = result.findings.filter((f) => f.severity !== 'info');
  const rel = (uri) => path.relative(baseDir, path.join(result.project.root, uri)).split(path.sep).join('/');
  // A rule has one severity in SonarQube, so a check whose findings differ in severity becomes
  // one rule per severity (`crash-removed-core-imports.high`); otherwise the plain check id.
  const base = (f) => f.id.split(':')[0];
  const severities = new Map();
  for (const f of findings) severities.set(base(f), new Set([...(severities.get(base(f)) || []), f.severity]));
  const ruleOf = (f) => (severities.get(base(f)).size > 1 ? `${base(f)}.${f.severity}` : base(f));
  const rules = new Map();
  for (const f of findings) rules.set(ruleOf(f), { id: ruleOf(f), check: base(f), quality: QUALITY[f.area] || 'MAINTAINABILITY', worst: f.severity });
  return {
    rules: [...rules.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({
      id: r.id,
      name: human(r.check),
      description: `NativeKeel check "${r.check}" for React Native and Expo apps. Details and fixes: ${SITE_URL}`,
      engineId: 'nativekeel',
      type: TYPE[r.quality],
      severity: LEGACY[r.worst],
      impacts: [{ softwareQuality: r.quality, severity: IMPACT[r.worst] }],
    })),
    issues: findings.map((f) => {
      const loc = locate(result, f, pkgLines);
      return {
        ruleId: ruleOf(f),
        effortMinutes: 0,
        primaryLocation: { message: clip(`[${f.severity}] ${f.title}. ${f.detail}`, 1000), filePath: rel(loc.uri), textRange: { startLine: loc.line || 1 } },
        ...(() => {
          const more = findingLocations(f).slice(1, 6);
          return more.length ? { secondaryLocations: more.map((e) => ({ message: clip(e.role || 'Related source evidence', 200), filePath: rel(e.file), textRange: { startLine: e.line } })) } : {};
        })(),
      };
    }),
  };
}

// Issues whose file lies outside sonar.sources (sonar-project.properties next to the report, or in
// the working directory) are dropped by the scanner without a word. Returns a warning, or null.
export function sonarScopeWarning(report, { cwd = process.cwd() } = {}) {
  let props = '';
  try { props = fs.readFileSync(path.join(cwd, 'sonar-project.properties'), 'utf8'); } catch { return null; }
  const value = (key) => (props.match(new RegExp(`^\\s*${key.replace(/\./g, '\\.')}\\s*=\\s*(.*)$`, 'm')) || [])[1];
  const sources = (value('sonar.sources') || '').split(',').map((s) => s.trim().replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean);
  if (!sources.length || sources.includes('.')) return null;
  const files = report.issues.map((i) => i.primaryLocation.filePath);
  const outside = files.filter((f) => !sources.some((s) => f === s || f.startsWith(`${s}/`)));
  if (!outside.length) return null;
  const sample = [...new Set(outside)].slice(0, 3).join(', ');
  return `${outside.length} of ${files.length} issues point at files outside sonar.sources (${sources.join(', ')}), e.g. ${sample}; SonarQube drops them. Add those folders (or package.json, android, ios) to sonar.sources, or keep them out on purpose.`;
}
