import fs from './read-boundary.js';
import path from 'node:path';
import { SITE_URL } from './config.js';

// SARIF 2.1.0 for GitHub code scanning: findings show up on the exact line in pull requests.
// https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html

const LEVEL = { critical: 'error', high: 'error', medium: 'warning', low: 'note', info: 'note' };

// Where a finding lives: its own file/line when known, otherwise the package.json line that
// declares the dependency, otherwise the top of package.json.
function locate(result, finding, pkgLines) {
  const fix = finding.fix || {};
  if (finding.evidence?.[0]?.file) return { uri: finding.evidence[0].file, line: finding.evidence[0].line || 1 };
  if (fix.file) return { uri: fix.file, line: fix.line || 1 };
  const name = fix.name || (finding.id.includes(':') ? finding.id.split(':').slice(1).join(':') : null);
  if (name) {
    const i = pkgLines.findIndex((l) => l.includes(`"${name}"`));
    if (i >= 0) return { uri: 'package.json', line: i + 1 };
  }
  if (finding.id.startsWith('ios-ats:')) return { uri: finding.id.slice('ios-ats:'.length), line: 1 };
  return { uri: 'package.json', line: 1 };
}

export function sarifReport(result, { version = '0.0.0' } = {}) {
  let pkgLines = [];
  try {
    pkgLines = fs.readFileSync(path.join(result.project.root, 'package.json'), 'utf8').split('\n');
  } catch {
    pkgLines = [];
  }
  const findings = result.findings.filter((f) => f.severity !== 'info');
  const ruleIds = [...new Set(findings.map((f) => f.id.split(':')[0]))].sort();
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'NativeKeel',
            version,
            informationUri: SITE_URL,
            rules: ruleIds.map((id) => ({ id, name: id, shortDescription: { text: id.replace(/-/g, ' ') } })),
          },
        },
        results: findings.map((f) => {
          const loc = locate(result, f, pkgLines);
          return {
            ruleId: f.id.split(':')[0],
            level: LEVEL[f.severity],
            message: { text: `${f.title}. ${f.detail}` },
            locations: [{ physicalLocation: { artifactLocation: { uri: toUri(loc.uri) }, region: { startLine: loc.line } } }],
            // Stable across runs so code scanning tracks one alert per finding.
            partialFingerprints: { nativekeelId: f.id },
            properties: { severity: f.severity, area: f.area, confidence: f.confidence, attack: f.attack },
            ...(f.evidence?.length > 1 ? { relatedLocations: f.evidence.slice(1).map((e, i) => ({ id: i + 1, physicalLocation: { artifactLocation: { uri: toUri(e.file) }, region: { startLine: e.line || 1 } }, message: { text: e.role || "Related source evidence" } })) } : {}),
          };
        }),
      },
    ],
  };
}

// SARIF artifact locations are URIs: encode each path segment (spaces, #, %), keep the slashes.
function toUri(file) {
  return file.split(/[\\/]/).map(encodeURIComponent).join('/');
}
