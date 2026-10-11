import fs from './read-boundary.js';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const IMPORT_CONTEXT = ['platform', 'variant', 'artifactKind', 'reactNative', 'engine', 'bundler', 'lodashVersion', 'buildSettingsHash'];
export function importContext(ctx) {
  const text = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
  if (!ctx || IMPORT_CONTEXT.some((k) => !text(ctx[k]))) throw new Error('Complete build context is required.');
  if (!['android', 'ios'].includes(ctx.platform) || ctx.mode !== 'release' || !['javascript-bundle', 'hermes-bytecode'].includes(ctx.artifactKind) || !/^[a-f0-9]{64}$/.test(ctx.buildSettingsHash) || !/^4\.\d+\.\d+$/.test(ctx.lodashVersion)) throw new Error('Expected a release Android/iOS bundle, Lodash 4 version and build settings hash.');
  return Object.fromEntries(['mode', ...IMPORT_CONTEXT].map((k) => [k, ctx[k]]));
}

export function localExperimentPath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || /[\x00-\x1f\x7f]/.test(relative) || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new Error('Use a relative artifact path inside the experiment folder.');
  }
  const real = fs.realpathSync(path.resolve(root, relative));
  if (real !== root && !real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) throw new Error('Input resolves outside the experiment folder.');
  return real;
}

export function readExperimentFile(file, limit, allowedRoot = path.dirname(fs.realpathSync(file))) {
  const real = fs.realpathSync(file);
  const check = () => {
    const current = fs.realpathSync(file);
    if (current !== allowedRoot && !current.startsWith(allowedRoot.endsWith(path.sep) ? allowedRoot : allowedRoot + path.sep)) throw new Error('Input resolves outside the experiment folder.');
    return fs.statSync(current);
  };
  check();
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    // Recheck after open, before reading: O_NOFOLLOW protects only the final component.
    // A parent directory might have been exchanged for a symlink in the meantime.
    const current = check();
    if (before.dev !== current.dev || before.ino !== current.ino) throw new Error('Input changed while opening.');
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

// Explicit selection only. We cannot infer all inputs used by arbitrary build configs.
// No source content is returned; membership/completeness is still caller-reported.
export function captureSourceSelection(experimentRoot, selection) {
  if (!selection || !Array.isArray(selection.files) || !selection.files.length || selection.files.length > 5000) throw new Error('Select between 1 and 5000 source files.');
  const root = localExperimentPath(experimentRoot, selection.root);
  if (!fs.statSync(root).isDirectory()) throw new Error('Source root must be a directory.');
  const seen = new Set();
  let total = 0;
  const files = selection.files.map((name) => {
    const file = localExperimentPath(root, name);
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (seen.has(relative)) throw new Error('Duplicate source file in selection.');
    seen.add(relative);
    const data = readExperimentFile(file, Math.min(8 * 1024 * 1024, 32 * 1024 * 1024 - total), root);
    total += data.length;
    return { path: relative, sha256: sha256(data), bytes: data.length };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { root: selection.root, files, sha256: sha256(JSON.stringify(files)) };
}

export function verifySourceInventory(root, entry) {
  const inventory = entry.sourceInventory;
  if (!inventory || !Array.isArray(inventory.files)) throw new Error('Invalid source inventory.');
  const actual = captureSourceSelection(root, { root: inventory.root, files: inventory.files.map((f) => f?.path) });
  const expected = [...inventory.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (actual.sha256 !== entry.sourceSnapshotHash || expected.some((f, i) => f.sha256 !== actual.files[i].sha256 || f.bytes !== actual.files[i].bytes)) throw new Error('Source inventory changed or does not match its hashes.');
  return actual.files;
}
