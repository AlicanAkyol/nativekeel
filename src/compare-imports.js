import fs from './read-boundary.js';
import path from 'node:path';
import { createHash } from 'node:crypto';

// This importer measures bytes; it does not run builds, load source maps, or certify the
// caller's description of how those bytes were produced. Keep attribution explicit.
const MAX_BUNDLE = 64 * 1024 * 1024;
const CONTEXT = ['platform', 'variant', 'artifactKind', 'reactNative', 'engine', 'bundler', 'lodashVersion', 'buildSettingsHash'];
const inside = (file, root) => file.startsWith(root + path.sep);
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);

function readFile(file, limit) {
  // No FIFO/device reads, no following a replaced final symlink, bounded memory even if
  // a file grows after the first stat. The MCP read boundary also applies if called there.
  const real = fs.realpathSync(file);
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw new Error('Input must be a regular file within the size limit.');
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const n = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!n) throw new Error('Input changed while reading.');
      offset += n;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Input changed while reading.');
    return data;
  } finally { fs.closeSync(fd); }
}

export function compareImports(manifestFile) {
  const manifestPath = fs.realpathSync(manifestFile);
  const root = path.dirname(manifestPath);
  const input = JSON.parse(readFile(manifestPath, 64 * 1024).toString('utf8'));
  if (!object(input) || input.schemaVersion !== 1 || input.recipe !== 'lodash-import-scope') throw new Error('Expected a schemaVersion 1 lodash-import-scope experiment.');
  const sides = ['before', 'after'].map((side) => {
    const entry = input[side];
    if (!object(entry) || !text(entry.file) || path.isAbsolute(entry.file) || entry.file.split(/[\\/]/).includes('..')) throw new Error(`${side}: use a relative artifact path inside the experiment folder.`);
    if (!hash(entry.sha256) || !hash(entry.sourceSnapshotHash)) throw new Error(`${side}: artifact and source snapshot SHA-256 hashes are required.`);
    if (!object(entry.context) || CONTEXT.some((k) => !text(entry.context[k]))) throw new Error(`${side}: complete build context is required.`);
    const ctx = entry.context;
    if (!['android', 'ios'].includes(ctx.platform) || ctx.mode !== 'release' || !['javascript-bundle', 'hermes-bytecode'].includes(ctx.artifactKind) || !hash(ctx.buildSettingsHash) || !/^4\.\d+\.\d+$/.test(ctx.lodashVersion)) throw new Error(`${side}: expected a release Android/iOS bundle, Lodash 4 version and build settings hash.`);
    const file = fs.realpathSync(path.resolve(root, entry.file));
    if (!inside(file, root)) throw new Error(`${side}: artifact resolves outside the experiment folder.`);
    const bytes = readFile(file, MAX_BUNDLE);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== entry.sha256) throw new Error(`${side}: artifact SHA-256 does not match.`);
    if (!bytes.length) throw new Error(`${side}: empty artifact is not a valid comparison.`);
    return { bytes: bytes.length, sha256, context: ctx, sourceSnapshotHash: entry.sourceSnapshotHash };
  });
  const [before, after] = sides;
  const reasons = [];
  for (const key of CONTEXT) if (before.context[key] !== after.context[key]) reasons.push(`Build context differs: ${key}.`);
  if (before.sourceSnapshotHash === after.sourceSnapshotHash) reasons.push('The source snapshots do not identify a changed implementation.');
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
    provenance: { artifactBytes: 'measured-locally', buildContext: 'caller-reported', changeAndTests: 'caller-reported' },
    before: { bytes: before.bytes, sha256: before.sha256, sourceSnapshotHash: before.sourceSnapshotHash,
      reportedContext: Object.fromEntries(['mode', ...CONTEXT].map((k) => [k, before.context[k]])) },
    after: { bytes: after.bytes, sha256: after.sha256, sourceSnapshotHash: after.sourceSnapshotHash,
      reportedContext: Object.fromEntries(['mode', ...CONTEXT].map((k) => [k, after.context[k]])) },
    reportedTestScope: Array.isArray(v?.testScope) ? v.testScope.filter(text).slice(0, 30) : [],
    comparison: comparable ? { metric: 'artifact-bytes', reductionBytes: reduction, reductionPercent: Number((100 * reduction / before.bytes).toFixed(3)) } : null,
    reasons,
    limits: [
      'Build settings, source snapshots, the scope of the change and test results are caller-reported, not independently verified.',
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
