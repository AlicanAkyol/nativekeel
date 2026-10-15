import path from 'node:path';
import fs from './read-boundary.js';

// What the shipped JavaScript bundle is made of, measured from the source map a release build
// already wrote. Nothing is built or run: the map is read as data. Bytes are attributed to the
// source of each mapping until the next mapping. For Hermes bytecode maps that covers the code;
// string tables and function metadata have no source and are not attributed.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) DIGIT[B64.charCodeAt(i)] = i;
const MAX_MAP = 300 * 1024 * 1024;

// Where React Native and Expo leave a release map without extra flags.
const CANDIDATES = [
  'android/app/build/generated/sourcemaps/react/release/index.android.bundle.map',
  'android/app/build/generated/sourcemaps/react/productionRelease/index.android.bundle.map',
];
const EXPORT_DIRS = ['dist/_expo/static/js/android', 'dist/_expo/static/js/ios'];

export function findBundleMaps(root) {
  const found = [];
  const add = (rel) => {
    try {
      const st = fs.statSync(path.join(root, rel));
      if (st.isFile() && st.size > 0 && st.size <= MAX_MAP) found.push({ file: rel, mtime: st.mtimeMs });
    } catch { /* not there */ }
  };
  for (const rel of CANDIDATES) add(rel);
  for (const dir of EXPORT_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, dir)); } catch { continue; }
    for (const e of entries) if (/\.(?:hbc|js)\.map$/.test(e)) add(`${dir}/${e}`);
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

// Package name and the directory it was bundled from (two directories = two copies).
function packageOf(source) {
  const at = source.lastIndexOf('node_modules/');
  if (at === -1) return null;
  const parts = source.slice(at + 13).split('/');
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  return { name, dir: source.slice(0, at + 13) + name };
}

export function analyzeSourceMap(text) {
  const map = JSON.parse(text);
  if (!map || map.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== 'string') {
    throw new Error('Not a version 3 source map.');
  }
  // Decode segments as [line, generatedColumn, sourceIndex]; only the fields needed.
  const s = map.mappings;
  const lines = [];
  let segs = [];
  let col = 0, src = 0;
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    if (c === 59) { lines.push(segs); segs = []; col = 0; i++; continue; } // ;
    if (c === 44) { i++; continue; } // ,
    let n = 0, gotSource = false;
    while (i < s.length && s.charCodeAt(i) !== 44 && s.charCodeAt(i) !== 59) {
      let v = 0, shift = 0, d;
      do {
        d = DIGIT[s.charCodeAt(i++)];
        if (d === undefined || d < 0) throw new Error('Invalid source map mappings.');
        v += (d & 31) * 2 ** shift;
        shift += 5;
      } while (d & 32);
      const value = v % 2 ? -(v - 1) / 2 : v / 2;
      if (n === 0) col += value;
      else if (n === 1) { src += value; gotSource = true; }
      n++;
    }
    segs.push([col, gotSource ? src : -1]);
  }
  lines.push(segs);

  const bytes = new Float64Array(map.sources.length);
  let mapped = 0;
  for (const line of lines) {
    line.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < line.length - 1; k++) {
      const [c0, idx] = line[k];
      const span = line[k + 1][0] - c0;
      if (idx < 0 || idx >= bytes.length || span <= 0) continue;
      bytes[idx] += span;
      mapped += span;
    }
  }

  const packages = new Map();
  const copies = new Map();
  let app = 0, momentLocales = 0;
  const json = [];
  map.sources.forEach((source, k) => {
    const b = bytes[k];
    if (!b) return;
    if (/\.json$/.test(source)) json.push({ source, bytes: b });
    if (/node_modules\/moment\/(?:min\/)?locale\//.test(source)) momentLocales += b;
    const p = packageOf(String(source));
    if (!p) { app += b; return; }
    packages.set(p.name, (packages.get(p.name) || 0) + b);
    if (!copies.has(p.name)) copies.set(p.name, new Map());
    const dirs = copies.get(p.name);
    dirs.set(p.dir, (dirs.get(p.dir) || 0) + b);
  });
  const duplicates = [...copies].filter(([, dirs]) => dirs.size > 1)
    .map(([name, dirs]) => ({ name, copies: [...dirs].map(([dir, b]) => ({ dir, bytes: b })).sort((a, b) => b.bytes - a.bytes) }))
    .sort((a, b) => b.copies.slice(1).reduce((t, c) => t + c.bytes, 0) - a.copies.slice(1).reduce((t, c) => t + c.bytes, 0));
  return {
    hermes: !!map.x_hermes_function_offsets,
    sources: map.sources.length,
    mappedBytes: mapped,
    appBytes: app,
    momentLocales,
    packages: [...packages].map(([name, b]) => ({ name, bytes: b })).sort((a, b) => b.bytes - a.bytes),
    duplicates,
    json: json.sort((a, b) => b.bytes - a.bytes),
  };
}

const kb = (b) => `${Math.round(b / 1024)} KB`;
const signedKb = (b) => `${b >= 0 ? '+' : '−'}${Math.round(Math.abs(b) / 1024)} KB`;

// Two measurements of the same app, before and after a change: what grew, what shrank, what
// is new or gone, and which packages started being bundled twice. Both maps must be of the same
// kind (both Hermes or both plain JavaScript) for the byte counts to be comparable.
export function compareBundles(before, after) {
  const map = (r) => new Map(r.packages.map((p) => [p.name, p.bytes]));
  const a = map(before), b = map(after);
  const names = new Set([...a.keys(), ...b.keys()]);
  const changes = [...names].map((name) => ({ name, before: a.get(name) || 0, after: b.get(name) || 0 }))
    .map((c) => ({ ...c, delta: c.after - c.before }))
    .filter((c) => c.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const dupBefore = new Set(before.duplicates.map((d) => d.name));
  return {
    comparable: before.hermes === after.hermes,
    total: { before: before.mappedBytes, after: after.mappedBytes, delta: after.mappedBytes - before.mappedBytes },
    app: { before: before.appBytes, after: after.appBytes, delta: after.appBytes - before.appBytes },
    added: changes.filter((c) => !c.before),
    removed: changes.filter((c) => !c.after),
    changed: changes.filter((c) => c.before && c.after),
    newDuplicates: after.duplicates.filter((d) => !dupBefore.has(d.name)),
  };
}

export function compareText(diff, beforeFile, afterFile) {
  const out = [`JavaScript bundle: ${beforeFile} → ${afterFile}`];
  if (!diff.comparable) out.push('! One map is Hermes bytecode and the other plain JavaScript: byte counts are not comparable.');
  out.push(`Mapped code: ${kb(diff.total.before)} → ${kb(diff.total.after)} (${signedKb(diff.total.delta)}); your app's code ${signedKb(diff.app.delta)}`, '');
  const row = (c) => `  ${signedKb(c.delta).padStart(9)}  ${c.name}${c.before && c.after ? ` (${kb(c.before)} → ${kb(c.after)})` : ''}`;
  if (diff.added.length) out.push('New in the bundle:', ...diff.added.slice(0, 15).map(row), '');
  if (diff.removed.length) out.push('No longer in the bundle:', ...diff.removed.slice(0, 15).map(row), '');
  // Mapping boundaries shift by a few bytes between builds; under 1 KB is noise, not a change.
  const visible = diff.changed.filter((c) => Math.abs(c.delta) >= 1024);
  if (visible.length) out.push('Changed size:', ...visible.slice(0, 15).map(row), '');
  if (diff.newDuplicates.length) out.push('Now bundled more than once:', ...diff.newDuplicates.slice(0, 10).map((d) => `  ${d.name}: ${d.copies.map((c) => `${c.dir} (${kb(c.bytes)})`).join(', ')}`), '');
  if (!diff.added.length && !diff.removed.length && !visible.length && !diff.newDuplicates.length) out.push('No package changed size by 1 KB or more.');
  return out.join('\n').trimEnd();
}
const pct = (b, total) => `${(100 * b / total).toFixed(1)}%`;

export function bundleText(result, file) {
  const out = [`JavaScript bundle measured from ${file}${result.hermes ? ' (Hermes bytecode)' : ''}`, `Mapped code: ${kb(result.mappedBytes)} from ${result.sources} source files. Strings and metadata are not attributed.`, ''];
  out.push(`  ${kb(result.appBytes).padStart(8)}  ${pct(result.appBytes, result.mappedBytes).padStart(6)}  your app's code`);
  for (const p of result.packages.slice(0, 20)) out.push(`  ${kb(p.bytes).padStart(8)}  ${pct(p.bytes, result.mappedBytes).padStart(6)}  ${p.name}`);
  if (result.duplicates.length) {
    out.push('', 'Bundled more than once:');
    for (const d of result.duplicates.slice(0, 10)) out.push(`  ${d.name}: ${d.copies.map((c) => `${c.dir} (${kb(c.bytes)})`).join(', ')}`);
  }
  return out.join('\n');
}

// Findings for the scan, from the newest map in the project. A map older than package.json
// may describe a different dependency set, so the finding says how old it is.
export function bundleChecks(root) {
  const [newest] = findBundleMaps(root);
  if (!newest) return { findings: [], measured: null, analysis: null };
  let result;
  try { result = analyzeSourceMap(fs.readFileSync(path.join(root, newest.file), 'utf8')); } catch { return { findings: [], measured: null, analysis: null }; }
  if (!result.mappedBytes) return { findings: [], measured: null, analysis: null };
  let stale = false;
  try { stale = fs.statSync(path.join(root, 'package.json')).mtimeMs > newest.mtime; } catch { /* no package.json */ }
  const when = new Date(newest.mtime).toISOString().slice(0, 10);
  const top = result.packages.slice(0, 8);
  const findings = [{
    id: 'bundle-composition',
    severity: 'info',
    area: 'performance',
    title: `JavaScript bundle measured: ${kb(result.mappedBytes)} of mapped code, your app ${pct(result.appBytes, result.mappedBytes)}, ${top[0] ? `${top[0].name} ${pct(top[0].bytes, result.mappedBytes)}` : ''}`,
    detail: `From ${newest.file} (written ${when}${stale ? ', older than package.json: rebuild for current numbers' : ''}). Largest packages: ${top.map((p) => `${p.name} ${kb(p.bytes)} (${pct(p.bytes, result.mappedBytes)})`).join(', ')}. Measured from the release source map; strings and bytecode metadata have no source and are not included. Run \`npx nativekeel bundle\` for the full list.`,
    evidence: [{ kind: 'artifact', file: newest.file, mappedBytes: result.mappedBytes, packages: top }],
  }];
  const extra = (d) => d.copies.slice(1).reduce((t, c) => t + c.bytes, 0);
  const dups = result.duplicates.filter((d) => extra(d) >= 2048);
  if (dups.length) {
    const total = dups.reduce((t, d) => t + extra(d), 0);
    findings.push({
      id: 'bundle-duplicate-packages',
      severity: total >= 100 * 1024 ? 'medium' : 'low',
      area: 'performance',
      title: `${dups.length} package${dups.length === 1 ? ' is' : 's are'} bundled more than once (${kb(total)} extra, measured)`,
      detail: `${dups.slice(0, 5).map((d) => `${d.name}: ${d.copies.map((c) => `${c.dir} ${kb(c.bytes)}`).join(' and ')}`).join('; ')}. Two versions of the same package end up in the bundle when dependencies ask for incompatible ranges. Measured from ${newest.file}.`,
      evidence: dups.slice(0, 10).map((d) => ({ kind: 'artifact', package: d.name, copies: d.copies })),
      fix: { kind: 'performance', step: `Find why each copy is installed (\`npm ls ${dups[0].name}\` or \`yarn why ${dups[0].name}\`), then align the versions or add a resolution/override so one copy remains. Rebuild and run \`npx nativekeel bundle\` to confirm.` },
    });
  }
  return { findings, measured: { file: newest.file, mappedBytes: result.mappedBytes, stale }, analysis: result };
}

// Adds what the release bundle actually contains to source-pattern findings, so a review starts
// from measured bytes instead of a guess. Absent from the bundle is reported too.
export function annotateWithBundle(findings, bundle) {
  if (!bundle?.analysis) return;
  const r = bundle.analysis;
  const bytesOf = (name) => r.packages.find((p) => p.name === name)?.bytes || 0;
  const heavy = findings.find((f) => f.id === 'perf-heavy-imports');
  if (heavy) {
    const notes = [];
    for (const name of ['lodash', 'moment']) {
      if (!new RegExp(`\\b${name}\\b`).test(heavy.title)) continue;
      const b = bytesOf(name);
      if (!b) notes.push(`${name} is not in the measured bundle`);
      else notes.push(`${name} is ${kb(b)} (${pct(b, r.mappedBytes)}) of the measured bundle${name === 'moment' && r.momentLocales ? `, ${kb(r.momentLocales)} of it locale files` : ''}`);
    }
    if (notes.length) {
      heavy.detail += ` Measured in ${bundle.measured.file}${bundle.measured.stale ? ' (older than package.json)' : ''}: ${notes.join('; ')}.`;
      heavy.evidence = [...(heavy.evidence || []), { kind: 'artifact', file: bundle.measured.file, packages: ['lodash', 'moment'].map((n) => ({ name: n, bytes: bytesOf(n) })) }];
    }
  }
}
