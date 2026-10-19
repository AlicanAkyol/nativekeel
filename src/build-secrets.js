import fs from './read-boundary.js';
import path from 'node:path';
import { readZipEntries, entryData } from './elf-align.js';
import { findSecrets } from './secrets.js';

// Secrets inside the JavaScript bundle the app actually ships. A key set as an EAS or CI
// environment variable (EXPO_PUBLIC_…) is compiled into the bundle without ever appearing in the
// repository, so a source scan cannot see it. This opens built apps (APK, AAB, IPA) and bundle
// files and scans the bundle itself, plain JavaScript or Hermes bytecode.

const BUNDLE_ENTRY = /(?:^|\/)assets\/(?:index\.android\.bundle|app\.bundle)$|(?:^|\/)main\.jsbundle$|\.hbc$/;
const MAX_ARCHIVE = 1024 * 1024 * 1024;
const MAX_BUNDLE = 200 * 1024 * 1024;

function walk(dir, depth, test, out) {
  if (depth < 0) return;
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of list) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', '.git', 'Pods', '.gradle', 'intermediates', 'tmp'].includes(e.name)) walk(full, depth - 1, test, out);
    } else if (test(e.name, full)) out.push(full);
  }
}

// Built apps and bundles a release build leaves in the project: Gradle outputs, the bundle Gradle
// generates, a bundle committed to the repository, and `eas build --local` results in the root.
export function buildFiles(root) {
  const out = [];
  walk(path.join(root, 'android', 'app', 'build', 'outputs'), 4, (n) => /\.(?:apk|aab)$/.test(n), out);
  walk(path.join(root, 'android', 'app', 'build', 'generated'), 6, (n) => n === 'index.android.bundle', out);
  walk(path.join(root, 'android', 'app', 'src', 'main', 'assets'), 1, (n) => n === 'index.android.bundle', out);
  walk(path.join(root, 'ios'), 2, (n) => n === 'main.jsbundle', out);
  walk(root, 0, (n) => /^build-\d+\.(?:apk|aab|ipa)$/.test(n), out);
  return [...new Set(out)];
}

function scanBundle(buf) {
  const text = buf.toString('latin1');
  // Hermes keeps strings with non-ASCII characters as UTF-16; dropping the zero bytes makes their
  // ASCII parts readable.
  return [...findSecrets(text, { binary: true }), ...findSecrets(text.replace(/\x00/g, ''), { binary: true })];
}

// [{ rule, label, value, file, entry }], one per distinct value. `known` holds the start of
// values the source scan already reported, so the same key is not reported twice.
export function secretsInBuilds(root, { artifacts = [], known = new Set() } = {}) {
  const found = new Map();
  const errors = [];
  const files = [...new Set([...artifacts.map((a) => path.resolve(a)), ...buildFiles(root)])];
  for (const file of files) {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      errors.push(`${file}: not found`);
      continue;
    }
    const rel = path.relative(root, file).startsWith('..') ? path.relative(process.cwd(), file) : path.relative(root, file);
    const bundles = [];
    try {
      if (/\.(?:apk|aab|ipa|zip)$/i.test(file)) {
        if (size > MAX_ARCHIVE) { errors.push(`${rel}: larger than 1 GB, skipped`); continue; }
        const buf = fs.readFileSync(file);
        for (const entry of readZipEntries(buf)) if (BUNDLE_ENTRY.test(entry.name) && entry.size <= MAX_BUNDLE) bundles.push({ entry: entry.name, data: entryData(buf, entry) });
        if (!bundles.length) errors.push(`${rel}: no JavaScript bundle inside`);
      } else if (size <= MAX_BUNDLE) {
        bundles.push({ entry: null, data: fs.readFileSync(file) });
      }
    } catch (e) {
      errors.push(`${rel}: ${e.message}`);
      continue;
    }
    for (const b of bundles) {
      for (const s of scanBundle(b.data)) {
        const key = s.value.slice(0, 16);
        if (known.has(key) || found.has(key)) continue;
        found.set(key, { rule: s.rule, label: s.label, value: s.value, file: rel, entry: b.entry });
      }
    }
  }
  return { secrets: [...found.values()], scanned: files.length, errors };
}
