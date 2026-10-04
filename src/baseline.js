import fs from 'node:fs';

// A baseline is the list of finding ids a team has accepted. In CI only findings that are
// not in the baseline fail the build, so an old app can adopt NativeKeel without fixing
// everything on day one, and nothing new slips in afterwards.

export function saveBaseline(file, result) {
  const data = {
    tool: 'nativekeel',
    createdAt: result.scannedAt,
    ids: [...new Set(result.findings.filter((f) => f.severity !== 'info').map((f) => f.id))].sort(),
  };
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return data.ids.length;
}

export function applyBaseline(file, result) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const known = new Set(data.ids || []);
  const findings = result.findings.filter((f) => !known.has(f.id));
  const fixed = [...known].filter((id) => !result.findings.some((f) => f.id === id));
  return { ...result, findings, baseline: { file, suppressed: result.findings.length - findings.length, fixed } };
}
