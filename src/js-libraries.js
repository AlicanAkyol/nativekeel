import fs from './read-boundary.js';
import path from 'node:path';
import { findPackageDir, cleanVersion } from './project.js';
import { lockedVersions } from './lockfile.js';
import { compareVersions } from './known-issues.js';

// JavaScript libraries that still call an API React Native removed. The app's own code can be clean
// and the app still crash (InteractionManager, the StatusBar setters) or lose a layout silently
// (StyleSheet.absoluteFillObject) on upgrade, because a dependency calls it. Native libraries are
// covered by the header check; these are the JavaScript ones.
//
// With node_modules the installed code is read. Without it, KNOWN lists releases verified by hand
// against their published code (scripts/lab/js-lib-removed-api.mjs on the npm tarballs).

// change id (upcoming.js) -> how a library really uses the removed API, and what in the same file
// means it is not React Native's (its own copy) or is guarded (checked before it is called).
const USES = {
  'rn87-interaction-manager': {
    use: /\bInteractionManager\s*\.\s*(?:runAfterInteractions|createInteractionHandle|clearInteractionHandle|setDeadline)\s*\(/,
    own: /\bInteractionManager\s*=\s*\{|\b(?:const|let|var|function|class)\s+InteractionManager\b/,
    guard: /typeof\s+InteractionManager\b|\bInteractionManager\s*(?:&&|\?(?!\.))|\bInteractionManager\s*\?\./,
  },
  'rn87-statusbar-props': {
    use: /\bStatusBar\s*\.\s*(?:setBackgroundColor|setTranslucent|setNetworkActivityIndicatorVisible)\s*\(/,
    own: /\bStatusBar\s*=\s*\{|\bclass\s+StatusBar\b/,
    guard: /\bStatusBar\s*\.\s*(?:setBackgroundColor|setTranslucent|setNetworkActivityIndicatorVisible)\b(?!\s*\()|StatusBar\s*\?\.\s*set/,
  },
  'rn85-absolute-fill-object': {
    use: /\bStyleSheet\s*\.\s*absoluteFillObject\b(?!\s*=[^=])/,
    own: /\babsoluteFillObject\s*=\s*\{/,
    guard: /\bStyleSheet\s*\.\s*absoluteFillObject\s*(?:\?\?|\|\|)|StyleSheet\s*\?\.\s*absoluteFillObject/,
  },
};

// Releases checked by hand (23 Oct 2026) on their published code: from the oldest release checked
// that has it to the newest. Older majors can differ (native-base 2.x and draggable-flatlist before
// 4.0.3 do not use these APIs) and a later release may fix it, so only that range is matched.
export const KNOWN = [
  { name: 'moti', change: 'rn85-absolute-fill-object', from: '0.25.4', upTo: '0.30.0', where: 'skeleton' },
  { name: '@rneui/base', change: 'rn85-absolute-fill-object', from: '4.0.0', upTo: '5.0.0', where: 'Image' },
  { name: 'native-base', change: 'rn85-absolute-fill-object', from: '3.0.0', upTo: '3.4.28', where: 'AspectRatio' },
  { name: '@ui-kitten/components', change: 'rn85-absolute-fill-object', from: '4.4.1', upTo: '6.2.1', where: 'TopNavigation, CircularProgressBar' },
  { name: 'react-native-draggable-flatlist', change: 'rn87-interaction-manager', from: '4.0.3', upTo: '4.0.3', where: 'DraggableFlatList' },
  { name: 'react-native-modal', change: 'rn87-interaction-manager', from: '11.10.0', upTo: '14.0.0', where: 'Modal' },
];

const CODE = /\.(?:m?js|cjs|jsx|ts|tsx)$/;
const CORE = /^(?:react-native|react-native-web|react-native-windows|react-native-macos|react-native-tvos|@react-native\/.*|@react-native-community\/cli.*)$/;
const SKIP_DIR = /^(?:node_modules|__tests__|__mocks__|test|tests|example|examples|docs|android|ios|website)$/;
const MAX_FILES = 600;
// Comments blanked, line breaks kept (so a line number still points at the real line).
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

function scanInstalled(dir) {
  const found = {};
  let files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files >= MAX_FILES || Object.keys(found).length === Object.keys(USES).length) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(f); continue; }
      if (!CODE.test(e.name) || /\.d\.ts$|\.(?:test|spec)\./.test(e.name)) continue;
      files++;
      let text;
      try { if (fs.statSync(f).size > 2 * 1024 * 1024) continue; text = strip(fs.readFileSync(f, 'utf8')); } catch { continue; }
      for (const [id, c] of Object.entries(USES)) {
        if (found[id]) continue;
        const m = c.use.exec(text);
        if (!m || c.own.test(text) || c.guard.test(text)) continue;
        found[id] = `${path.relative(dir, f).split(path.sep).join('/')}:${text.slice(0, m.index).split('\n').length}`;
      }
    }
  };
  walk(dir);
  return found;
}

// Map change id -> [{ name, version, where }] for the app's direct dependencies.
export function removedApiInLibraries(project) {
  const root = project.root;
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
  const deps = { ...(pkg.dependencies || {}) };
  const out = new Map();
  const add = (id, hit) => { if (!out.has(id)) out.set(id, []); out.get(id).push(hit); };
  const locked = lockedVersions(root, deps);
  for (const name of Object.keys(deps)) {
    // React Native itself (and its platform forks) define and use these APIs: it is not a library
    // that lags behind, it is the version being upgraded.
    if (CORE.test(name)) continue;
    const dir = findPackageDir(root, name);
    if (dir) {
      let version = null;
      try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch {}
      for (const [id, where] of Object.entries(scanInstalled(dir))) add(id, { name, version, where });
      continue;
    }
    // Not installed: the releases verified by hand, matched on the exact (locked) or declared version.
    const version = locked[name] || cleanVersion(deps[name]);
    if (!version || !/^\d/.test(version)) continue;
    for (const k of KNOWN.filter((x) => x.name === name)) {
      if (compareVersions(version, k.from) >= 0 && compareVersions(version, k.upTo) <= 0) add(k.change, { name, version, where: k.where });
    }
  }
  return out;
}
