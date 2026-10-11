import fs from './read-boundary.js';
import path from 'node:path';
import { localExperimentPath, readExperimentFile as readFile, sha256, verifySourceInventory, IMPORT_CONTEXT as CONTEXT, importContext } from './experiment-input.js';

// This importer measures bytes; it does not run builds, load source maps, or certify the
// caller's description of how those bytes were produced. Keep attribution explicit.
const MAX_BUNDLE = 64 * 1024 * 1024;
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);

export function compareImports(manifestFile) {
  const manifestPath = fs.realpathSync(manifestFile);
  const root = path.dirname(manifestPath);
  const input = JSON.parse(readFile(manifestPath, 2 * 1024 * 1024).toString('utf8'));
  if (!object(input) || input.schemaVersion !== 1 || input.recipe !== 'lodash-import-scope') throw new Error('Expected a schemaVersion 1 lodash-import-scope experiment.');
  const sides = ['before', 'after'].map((side) => {
    const entry = input[side];
    if (!object(entry) || !text(entry.file) || path.isAbsolute(entry.file) || entry.file.split(/[\\/]/).includes('..')) throw new Error(`${side}: use a relative artifact path inside the experiment folder.`);
    if (!hash(entry.sha256) || !hash(entry.sourceSnapshotHash)) throw new Error(`${side}: artifact and source snapshot SHA-256 hashes are required.`);
    const ctx = importContext(entry.context);
    const file = localExperimentPath(root, entry.file);
    const bytes = readFile(file, MAX_BUNDLE, root);
    const digest = sha256(bytes);
    if (digest !== entry.sha256) throw new Error(`${side}: artifact SHA-256 does not match.`);
    const inventory = entry.sourceInventory === undefined ? null : verifySourceInventory(root, entry);
    if (!bytes.length) throw new Error(`${side}: empty artifact is not a valid comparison.`);
    return { bytes: bytes.length, sha256: digest, context: ctx, sourceSnapshotHash: entry.sourceSnapshotHash, inventory };
  });
  const [before, after] = sides;
  const reasons = [];
  for (const key of CONTEXT) if (before.context[key] !== after.context[key]) reasons.push(`Build context differs: ${key}.`);
  if (before.sourceSnapshotHash === after.sourceSnapshotHash) reasons.push('The source snapshots do not identify a changed implementation.');
  if (!!before.inventory !== !!after.inventory) reasons.push('Both sides must use the same source evidence mode.');
  const sourceChanges = before.inventory && after.inventory ? (() => {
    const a = new Map(before.inventory.map((f) => [f.path, f.sha256]));
    const b = new Map(after.inventory.map((f) => [f.path, f.sha256]));
    const changed = [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
    if ([...a.keys()].some((p) => !b.has(p)) || [...b.keys()].some((p) => !a.has(p))) reasons.push('The selected source file sets differ; use the same coverage on both sides.');
    if (changed.some((p) => !/\.[cm]?[jt]sx?$/.test(p) || /\.d\.[cm]?ts$|\.config\.[cm]?[jt]s$/.test(p))) reasons.push('A selected non-runtime-source or configuration file changed; this is not the scoped import-only experiment.');
    return { coverage: 'selected-files-only', count: changed.length, paths: changed.slice(0, 50), truncated: changed.length > 50 };
  })() : null;
  const v = input.verification;
  if (!object(v) || v.onlyImportChange !== true || v.samePackageVersion !== true || v.behaviorTests !== 'passed' || !Array.isArray(v.testScope) || !v.testScope.length || v.testScope.length > 30 || !v.testScope.every(text)) {
    reasons.push('A reviewed import-only change, unchanged package version and passed behavior tests with scope must be reported.');
  }
  const comparable = !reasons.length;
  const reduction = before.bytes - after.bytes;
  return {
    schemaVersion: 1,
    recipe: input.recipe,
    status: comparable ? (reduction > 0 ? 'reported-context-size-reduction' : 'no-size-reduction') : 'incomparable',
    recommendation: 'requires-review',
    provenance: { artifactBytes: 'measured-locally', buildContext: 'caller-reported', changeAndTests: 'caller-reported', sourceHashes: before.inventory && after.inventory ? 'verified-selected-files' : 'caller-reported' },
    sourceChanges,
    before: { bytes: before.bytes, sha256: before.sha256, sourceSnapshotHash: before.sourceSnapshotHash,
      reportedContext: Object.fromEntries(['mode', ...CONTEXT].map((k) => [k, before.context[k]])) },
    after: { bytes: after.bytes, sha256: after.sha256, sourceSnapshotHash: after.sourceSnapshotHash,
      reportedContext: Object.fromEntries(['mode', ...CONTEXT].map((k) => [k, after.context[k]])) },
    reportedTestScope: Array.isArray(v?.testScope) ? v.testScope.filter(text).slice(0, 30) : [],
    comparison: comparable ? { metric: 'artifact-bytes', reductionBytes: reduction, reductionPercent: Number((100 * reduction / before.bytes).toFixed(3)) } : null,
    reasons,
    limits: [
      'Build settings, source snapshots, the scope of the change and test results are caller-reported, not independently verified.',
      'Source inventories, when present, are checked against the selected local files; coverage of all build inputs remains caller-reported.',
      'Hashes identify inputs; they do not prove build provenance or behavioral equivalence.',
      'This is the size of the supplied bundle, not installed app size, download size, startup speed or frame rate.',
      'Review the actual patch and affected consumers before deciding to keep the change. The package may still be required elsewhere.',
    ],
  };
}

export function importComparisonText(result) {
  const lines = ['Lodash import experiment', '', `Status: ${result.status}`, `Before: ${result.before.bytes} bytes; after: ${result.after.bytes} bytes.`];
  if (result.comparison) lines.push(`Artifact reduction: ${result.comparison.reductionBytes} bytes (${result.comparison.reductionPercent}%), under caller-reported build and test conditions.`);
  lines.push(...result.reasons, '', ...result.limits);
  return lines.join('\n');
}
